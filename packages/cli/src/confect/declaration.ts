import { App, Http, Mount, type ManifestSection } from "@confect/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { fromBundlerError } from "../BuildError.js";
import * as Bundler from "../Bundler.js";
import {
  HandWrittenConvexFileError,
  DeclarationKindMismatchError,
  InvalidDeclarationError,
  logCodegenError,
} from "../CodegenError.js";
import { ConfectDirectory } from "../ConfectDirectory.js";
import * as ConvexConfig from "../ConvexConfig.js";
import { ConvexDirectory } from "../ConvexDirectory.js";
import * as Declaration from "../Declaration.js";
import * as ManifestSections from "../ManifestSections.js";
import type { LoadedLeafModule } from "../LeafModule.js";
import type * as SectionFiles from "../SectionFiles.js";
import { logWarn, logFileRemoved } from "../log.js";
import { ProjectRoot } from "../ProjectRoot.js";
import * as templates from "../templates.js";
import {
  removePathIfExists,
  toModuleImportPath,
  toPosixPath,
  writeFileString,
  writeFileStringAndLog,
} from "../utils.js";
import * as String from "effect/String";
import { pipe } from "effect/Function";

/**
 * Bumped when the generated files change shape, so a manifest written by an
 * older generator never matches a current one.
 */
const GENERATOR_FORMAT = "2";

const confectPath = Effect.fnUntraced(function* (file: string) {
  const path = yield* Path.Path;
  return path.join(yield* ConfectDirectory.get, file);
});

/**
 * A backend opts in to the declaration by writing `confect/app.ts`.
 *
 * @internal
 */
export const isDeclared = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.exists(yield* confectPath("app.ts"));
});

const displayPath = Effect.fnUntraced(function* (absolutePath: string) {
  const path = yield* Path.Path;
  return toPosixPath(path, path.relative(yield* ProjectRoot.get, absolutePath));
});

const bundleDeclaration = Effect.fnUntraced(function* (file: string) {
  const path = yield* Path.Path;
  const absolutePath = yield* confectPath(file);
  return yield* Bundler.bundle(absolutePath, {
    plugins: [ConvexConfig.componentConfigPlugin(path)],
  }).pipe(
    Effect.mapError((error) => fromBundlerError(`confect/${file}`, error)),
  );
});

const invalid = (file: string) => (error: { readonly message: string }) =>
  new InvalidDeclarationError({
    declarationPath: `confect/${file}`,
    reason: error.message,
  });

/**
 * Fail instead of overwriting a Convex file someone wrote by hand. A file with
 * the generated header, or one of the exact files an earlier codegen wrote
 * there, is ours to replace.
 */
const assertOwned = Effect.fnUntraced(function* (
  convexPath: string,
  declarationFile: string,
  legacy: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(convexPath))) return;
  if (Declaration.isGenerated(yield* fs.readFileString(convexPath), legacy)) {
    return;
  }
  return yield* new HandWrittenConvexFileError({
    convexPath: yield* displayPath(convexPath),
    declarationPath: `confect/${declarationFile}`,
  });
});

const decodeVersion = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
);

const packageVersion = Effect.fnUntraced(function* (
  name: string,
  from: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* Option.match(
    Bundler.resolveModule(`${name}/package.json`, path.join(from, "_")),
    {
      onNone: () => Effect.succeed("unresolved"),
      onSome: (packageJson) =>
        fs.readFileString(packageJson).pipe(
          Effect.map((contents) =>
            Option.match(decodeVersion(contents), {
              onNone: () => "unknown",
              onSome: ({ version }) => version,
            }),
          ),
        ),
    },
  );
});

/**
 * Every first-party file the declaration modules import, by project-relative
 * path and contents. Files under `node_modules` and outside the project count
 * through package versions instead, so rebuilding a dependency does not change
 * the digest. The components registry is left out: codegen derives it from the
 * `convex.config.ts` this declaration writes, so its inputs are already here,
 * and a first run bundles a provisional registry that the real one replaces.
 */
const declarationInputs = Effect.fnUntraced(function* (
  bundles: ReadonlyArray<Bundler.Bundled>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectRoot = yield* ProjectRoot.get;
  const registry = path.join(
    yield* ConfectDirectory.get,
    "_generated",
    "components.ts",
  );
  const files = new Set<string>();
  for (const { metafile } of bundles) {
    for (const input of Object.keys(metafile.inputs)) {
      const relative = path.relative(projectRoot, input);
      if (
        path.isAbsolute(input) &&
        !pipe(relative, String.startsWith("..")) &&
        !pipe(relative, String.split(path.sep)).includes("node_modules") &&
        path.resolve(input) !== registry
      ) {
        files.add(input);
      }
    }
  }
  // Plugin namespaces (component config wrappers) appear as inputs too;
  // only real files count.
  const real = yield* Effect.filter([...files], (file) => fs.exists(file));
  return yield* Effect.forEach(real, (file) =>
    fs
      .readFileString(file)
      .pipe(
        Effect.map(
          (contents) =>
            [
              toPosixPath(path, path.relative(projectRoot, file)),
              contents,
            ] as const,
        ),
      ),
  );
});

const componentImport = Effect.fnUntraced(function* () {
  const path = yield* Path.Path;
  const convexDirectory = yield* ConvexDirectory.get;
  return (definition: unknown): Option.Option<Declaration.ComponentImport> =>
    Option.map(ConvexConfig.componentImportOf(definition), (recorded) => {
      const bare =
        !pipe(recorded.specifier, String.startsWith(".")) &&
        !path.isAbsolute(recorded.specifier);
      const relative = pipe(
        toPosixPath(path, path.relative(convexDirectory, recorded.path)),
        String.replace(/\.([cm]?)[jt]s$/, ".$1js"),
      );
      return {
        importPath: bare
          ? recorded.specifier
          : pipe(relative, String.startsWith("."))
            ? relative
            : `./${relative}`,
        componentName:
          Predicate.hasProperty(definition, "defaultName") &&
          Predicate.isString(definition.defaultName)
            ? definition.defaultName
            : "component",
      };
    });
});

const manifestPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.join(yield* ConfectDirectory.get, "_generated", "manifest.ts");
});

/**
 * Remove a file codegen wrote whose source is gone; leave anything else.
 */
const removeGenerated = Effect.fnUntraced(function* (
  filePath: string,
  legacy: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(filePath))) return;
  if (!Declaration.isGenerated(yield* fs.readFileString(filePath), legacy)) {
    return;
  }
  yield* removePathIfExists(filePath);
  yield* logFileRemoved(filePath);
});

const removeManifest = Effect.gen(function* () {
  yield* removeGenerated(yield* manifestPath, []);
});

const readManifest = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* manifestPath;
  if (!(yield* fs.exists(file))) return {} as Record<string, unknown>;
  const data: unknown = (yield* Bundler.bundle(file).pipe(
    Effect.mapError((error) =>
      fromBundlerError("confect/_generated/manifest.ts", error),
    ),
  )).module.default;
  return Predicate.isObject(data) ? data : {};
});

/**
 * @internal
 */
export const readPrevious = readManifest.pipe(
  Effect.orElseSucceed(() => ({}) as Record<string, unknown>),
);

const sectionDigest = (
  base: string,
  sections: Readonly<Record<string, unknown>>,
) =>
  Object.keys(sections).length === 0
    ? base
    : Declaration.digest({
        files: [["declaration", base]],
        versions: [],
        sections,
      });

/**
 * @internal
 */
export const syncManifestSections = Effect.fnUntraced(
  function* (
    declared: ReadonlyArray<ManifestSection.Entry>,
    leaves: ReadonlyArray<LoadedLeafModule>,
    previous: Readonly<Record<string, unknown>>,
    baseDigest: string | undefined,
    modules: ReadonlyMap<string, ManifestSection.GenerateInput["modules"]>,
  ) {
    if (baseDigest === undefined) return;
    const current = yield* readManifest;
    const registry = yield* Effect.fromResult(
      ManifestSections.collect(declared, leaves).pipe(
        Result.flatMap((described) =>
          ManifestSections.summarize(described, modules),
        ),
      ),
    );
    const checked = ManifestSections.check(registry, previous);
    for (const note of checked.notes) yield* logWarn(note);
    const [error, ...more] = checked.errors;
    for (const other of more) yield* logCodegenError(other);
    if (error !== undefined) return yield* error;
    const sections = Object.fromEntries(
      [...registry].map(([key, { data }]) => [key, data]),
    );
    const { name, env, http } = current;
    const digest = sectionDigest(baseDigest, sections);
    yield* writeFileStringAndLog(
      yield* manifestPath,
      Declaration.renderManifest({ name, env, http, digest, ...sections }),
    );
  },
  Effect.tapError(() => removeManifest),
);

const authProvidersPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.join(
    yield* ConfectDirectory.get,
    "_generated",
    "auth.providers.ts",
  );
});

const removeAuthProviders = Effect.gen(function* () {
  yield* removeGenerated(yield* authProvidersPath, []);
});

const writeDeclaration = Effect.fnUntraced(function* (
  previous: Readonly<Record<string, unknown>>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const convexDirectory = yield* ConvexDirectory.get;
  const projectRoot = yield* ProjectRoot.get;
  const target = (yield* ConvexDirectory.target).kind;

  const app = yield* bundleDeclaration("app.ts");
  const appValue: unknown = app.module.default;
  if (App.isApp(appValue) && appValue.kind !== target) {
    return yield* new DeclarationKindMismatchError({
      declarationPath: "confect/app.ts",
      declaredKind: appValue.kind,
      targetKind: target,
    });
  }
  const authPath = yield* confectPath("auth.ts");
  const auth = (yield* fs.exists(authPath))
    ? Option.some(yield* bundleDeclaration("auth.ts"))
    : Option.none();

  const declaration = yield* Declaration.parse({
    target,
    app: app.module.default,
    auth: Option.map(auth, ({ module }) => module.default),
    componentImport: yield* componentImport(),
  }).pipe(
    Result.mapError(
      (error) =>
        new InvalidDeclarationError({
          declarationPath: Declaration.fileOf(error),
          reason: error.message,
        }),
    ),
    Effect.fromResult,
  );
  const manifestSections = App.isApp(appValue) ? appValue.manifestSections : [];
  yield* Effect.fromResult(ManifestSections.declared(manifestSections));

  const convexConfigPath = path.join(
    convexDirectory,
    ConvexConfig.CONVEX_CONFIG_FILENAME,
  );
  const authConfigPath = path.join(convexDirectory, "auth.config.ts");
  const authImportPath = yield* toModuleImportPath(
    path.relative(convexDirectory, authPath),
  );
  const legacyAuthConfigs = yield* Effect.forEach(
    [authImportPath, pipe(authImportPath, String.replace(/\.js$/, ""))],
    (importPath) => templates.authConfig({ authImportPath: importPath }),
  );
  yield* assertOwned(convexConfigPath, "app.ts", []);
  yield* assertOwned(authConfigPath, "auth.ts", legacyAuthConfigs);

  let digest: string | undefined;
  if (target === "app") {
    digest = Declaration.digest({
      files: yield* declarationInputs([app, ...Option.toArray(auth)]),
      versions: [
        ["convex", yield* packageVersion("convex", projectRoot)],
        ["@confect/cli generator format", GENERATOR_FORMAT],
      ],
    });
    const sections = ManifestSections.sections(previous);
    yield* writeFileStringAndLog(
      yield* manifestPath,
      Declaration.manifest(
        declaration,
        sectionDigest(digest, sections),
        sections,
      ),
    );
  }
  yield* writeFileStringAndLog(
    convexConfigPath,
    Declaration.convexConfig(declaration),
  );
  yield* Option.match(declaration.providers, {
    onNone: () =>
      Effect.gen(function* () {
        yield* removeAuthProviders;
        if (yield* fs.exists(authConfigPath)) {
          yield* removePathIfExists(authConfigPath);
          yield* logFileRemoved(authConfigPath);
        }
      }),
    onSome: (providers) =>
      Effect.gen(function* () {
        yield* writeFileStringAndLog(
          authConfigPath,
          Declaration.authConfig(providers),
        );
        yield* writeFileStringAndLog(
          yield* authProvidersPath,
          Declaration.authProviders(providers),
        );
      }),
  });
  const sectionTarget: ManifestSection.Target =
    target === "app"
      ? { kind: "app" }
      : { kind: "component", name: declaration.name };
  return {
    app: App.isApp(appValue) ? Option.some(appValue) : Option.none<App.Any>(),
    digest,
    backend: Option.some<SectionFiles.Backend>({
      target: sectionTarget,
      sections: manifestSections,
    }),
  };
});

/**
 * Write the declaration's Convex files and manifest from `confect/app.ts`,
 * `confect/env.ts` and `confect/auth.ts`, before anything else is validated. On
 * any failure the previous manifest is removed, so a stale manifest never
 * outlives a declaration that no longer produces it.
 *
 * @internal
 */
export const syncDeclaration = Effect.fnUntraced(function* (
  previous: Readonly<Record<string, unknown>>,
) {
  if (!(yield* isDeclared)) {
    yield* removeManifest;
    yield* removeAuthProviders;
    return {
      app: Option.none<App.Any>(),
      digest: undefined,
      backend: Option.none<SectionFiles.Backend>(),
    };
  }
  return yield* writeDeclaration(previous).pipe(
    Effect.tapError(() =>
      removeManifest.pipe(Effect.andThen(removeAuthProviders)),
    ),
  );
});

/**
 * Check every HTTP route the backend serves and write `convex/http.ts` from
 * `confect/http.ts`. Runs after generation, because `http.ts` imports its
 * handlers, which import generated services.
 *
 * @internal
 */
export const syncDeclaredHttp = (
  app: App.Any,
  sectionFiles: ReadonlyArray<string>,
) =>
  checkAndWriteHttp(app, sectionFiles).pipe(
    Effect.tapError(() => removeManifest),
  );

const checkAndWriteHttp = Effect.fnUntraced(function* (
  app: App.Any,
  sectionFiles: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const convexDirectory = yield* ConvexDirectory.get;
  const confectDirectory = yield* ConfectDirectory.get;
  const httpPath = yield* confectPath("http.ts");

  const convexHttpPath = path.join(convexDirectory, "http.ts");
  if (!(yield* fs.exists(httpPath))) {
    yield* Http.routes(app).pipe(
      Result.mapError(invalid("app.ts")),
      Effect.fromResult,
    );
    yield* removeGenerated(convexHttpPath, [
      yield* templates.http({
        httpImportPath: yield* toModuleImportPath(
          path.relative(convexDirectory, httpPath),
        ),
      }),
    ]);
    return Option.none();
  }

  const http = (yield* bundleDeclaration("http.ts")).module.default;
  if (!Http.isHttp(http)) {
    return yield* new InvalidDeclarationError({
      declarationPath: "confect/http.ts",
      reason: "it must default-export Http.make(...).",
    });
  }
  yield* Http.routes(app, http).pipe(
    Result.mapError(invalid("http.ts")),
    Effect.fromResult,
  );

  const contents = yield* templates.declaredHttp({
    runtimeImportPath: (yield* fs.exists(
      path.join(confectDirectory, "runtime.ts"),
    ))
      ? yield* toModuleImportPath(
          path.relative(
            convexDirectory,
            path.join(confectDirectory, "runtime.ts"),
          ),
        )
      : undefined,
    schemaImportPath: yield* toModuleImportPath(
      path.relative(
        convexDirectory,
        path.join(confectDirectory, "_generated", "schema.ts"),
      ),
    ),
    httpImportPath: yield* toModuleImportPath(
      path.relative(convexDirectory, httpPath),
    ),
    sectionImportPaths: yield* Effect.forEach(sectionFiles, (file) =>
      toModuleImportPath(
        path.relative(
          convexDirectory,
          path.join(confectDirectory, "_generated", file),
        ),
      ),
    ),
  });
  const change = yield* writeFileString(convexHttpPath, contents);
  return Option.some({ change, convexFilePath: convexHttpPath });
});

const DEPLOY_MODULE = "confectDeploy.ts";

/**
 * Whether a mounted component's own codegen wrote a deploy module, so a push
 * visits its mounts after its `init`.
 */
const hasDeployModule = Effect.fnUntraced(function* (
  component: ConvexConfig.InstalledComponent,
  config: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.isAbsolute(component.componentDefinitionPath)
    ? Option.some(component.componentDefinitionPath)
    : Option.map(
        ConvexConfig.resolveDefinition(
          `${component.componentDefinitionPath}/convex.config`,
          config,
          path,
        ),
        path.dirname,
      );
  if (Option.isNone(directory)) return false;
  for (const file of [DEPLOY_MODULE, "confectDeploy.js"]) {
    if (yield* fs.exists(path.join(directory.value, file))) return true;
  }
  return false;
});

/**
 * The export of `confect/<name>.ts` that is the mount named `name`.
 */
const mountExport = Effect.fnUntraced(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* confectPath(`${name}.ts`);
  const missing = new InvalidDeclarationError({
    declarationPath: "confect/app.ts",
    reason: `the mount ${name} runs at every push, so export it from confect/${name}.ts.`,
  });
  if (!(yield* fs.exists(file))) return yield* missing;
  const exports: Record<string, unknown> = (yield* bundleDeclaration(
    `${name}.ts`,
  )).module;
  const found = Object.entries(exports).find(
    ([, value]) =>
      Predicate.hasProperty(value, "~@confect/core/Mount") &&
      Mount.data(value as Mount.Any).name === name,
  );
  if (found === undefined) return yield* missing;
  return { file, exportName: found[0] };
});

/**
 * Write `convex/confectDeploy.ts`, the internal mutation a push calls for the
 * steps it runs at each mount: every mount whose component declares `init` or
 * has a deploy module of its own, in declaration order. Remove it when there
 * are none.
 *
 * @internal
 */
export const syncDeployModule = Effect.fnUntraced(function* (
  app: Option.Option<App.Any>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const convexDirectory = yield* ConvexDirectory.get;
  const deployPath = path.join(convexDirectory, DEPLOY_MODULE);
  const config = path.join(
    convexDirectory,
    ConvexConfig.CONVEX_CONFIG_FILENAME,
  );
  const installed =
    Option.isSome(app) && (yield* fs.exists(config))
      ? yield* ConvexConfig.discoverInstalledComponents(
          config,
          yield* displayPath(config),
          (yield* ConvexDirectory.target).kind,
        )
      : [];
  const entries: Array<string> = [];
  const imports: Array<string> = [];
  for (const mount of Option.match(app, {
    onNone: () => [],
    onSome: App.mounts,
  })) {
    const component = installed.find(({ name }) => name === mount.name);
    const nested =
      component !== undefined && (yield* hasDeployModule(component, config));
    if (mount.component.init === undefined && !nested) continue;
    const { file, exportName } = yield* mountExport(mount.name);
    const local = `mount${entries.length}`;
    imports.push(
      `import { ${exportName} as ${local} } from "${yield* toModuleImportPath(path.relative(convexDirectory, file))}";`,
    );
    entries.push(`  { mount: ${local}, nested: ${nested} },`);
  }
  if (entries.length === 0) return yield* removeGenerated(deployPath, []);
  yield* writeFileStringAndLog(
    deployPath,
    [
      "// Generated by `confect codegen` from confect/app.ts. Do not edit.",
      'import { MountInit } from "@confect/server";',
      ...imports,
      "",
      "export const steps = MountInit.mutation([",
      ...entries,
      "]);",
      "",
    ].join("\n"),
  );
});
