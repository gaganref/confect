import {
  App,
  Guard,
  Http,
  Mount,
  Manifest,
  HealthModule,
  type ManifestSection,
} from "@confect/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as esbuild from "esbuild";
import type * as HttpApi from "effect/http-api/HttpApi";
import type * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as OpenApi from "effect/http-api/OpenApi";
import { fromBundlerError, ImportFailedError } from "../BuildError.js";
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
import { quote, stringify } from "../Json.js";
import * as ManifestSections from "../ManifestSections.js";
import { implPathForSpec, type LoadedLeafModule } from "../LeafModule.js";
import type * as RouteSpecs from "../RouteSpecs.js";
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
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";

/**
 * Bumped when the generated files change shape, so a manifest written by an
 * older generator never matches a current one.
 */
const GENERATOR_FORMAT = "4";

const ROUTES = "routes.ts";
const OPENAPI = "openapi.json";

const confectPath = Effect.fnUntraced(function* (file: string) {
  const path = yield* Path.Path;
  const confectDirectory = yield* ConfectDirectory.get;
  return path.join(confectDirectory, file);
});

/**
 * A backend opts in to the declaration by writing `confect/app.ts`.
 *
 * @internal
 */
export const isDeclared = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const confectPathResult = yield* confectPath("app.ts");
  return yield* fs.exists(confectPathResult);
});

const displayPath = Effect.fnUntraced(function* (absolutePath: string) {
  const path = yield* Path.Path;
  const projectRoot = yield* ProjectRoot.get;
  return toPosixPath(path, path.relative(projectRoot, absolutePath));
});

const bundleDeclaration = Effect.fnUntraced(function* (
  file: string,
  instrument?: {
    readonly plugin: esbuild.Plugin;
    readonly footers: ReadonlyMap<string, (source: string) => string>;
  },
) {
  const path = yield* Path.Path;
  const absolutePath = yield* confectPath(file);
  return yield* Bundler.bundle(absolutePath, {
    plugins: [
      ConvexConfig.componentConfigPlugin(path),
      ...(instrument === undefined ? [] : [instrument.plugin]),
    ],
    ...(instrument === undefined ? {} : { footers: instrument.footers }),
  }).pipe(
    Effect.mapError((error) => fromBundlerError(`confect/${file}`, error)),
  );
});

const invalid = (file: string) => (error: { readonly message: string }) =>
  InvalidDeclarationError.make({
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
  const convexPathContents = yield* fs.readFileString(convexPath);
  if (Declaration.isGenerated(convexPathContents, legacy)) {
    return;
  }
  return yield* HandWrittenConvexFileError.make({
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
 * through the emitted manifest and shipped component digests instead. The
 * components registry is left out: codegen derives it from the
 * `convex.config.ts` this declaration writes, so its inputs are already here,
 * and a first run bundles a provisional registry that the real one replaces.
 */
const declarationInputs = Effect.fnUntraced(function* (
  bundles: ReadonlyArray<Bundler.Bundled>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectRoot = yield* ProjectRoot.get;
  const confectDirectory = yield* ConfectDirectory.get;
  const registry = path.join(confectDirectory, "_generated", "components.ts");
  const files = new Set<string>();
  for (const { metafile } of bundles) {
    for (const input of Rec.keys(metafile.inputs)) {
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

/**
 * A TypeScript file directly in `confect/` that ran while `app.ts` loaded, with
 * its exports and every name it has there, the names `app.ts` imports it by
 * first. Two names share one file when one links to the other.
 *
 * @internal
 */
export interface RootModule {
  readonly names: Arr.NonEmptyReadonlyArray<string>;
  readonly exports: Readonly<Record<string, unknown>>;
}

const typeScriptFile = /\.(?:ts|mts|tsx)$/;

const stem = (file: string) =>
  pipe(file, String.replace(/\.[cm]?[jt]sx?$/, ""));

/**
 * Each TypeScript file directly in `confect/` but `app.ts`, by real path, with
 * its names there.
 */
const rootFiles = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const confectDirectory = yield* ConfectDirectory.get;
  const files = new Map<string, Arr.NonEmptyReadonlyArray<string>>();
  for (const name of yield* fs.readDirectory(confectDirectory)) {
    if (name === "app.ts" || !typeScriptFile.test(name)) continue;
    const real = yield* Effect.option(
      fs.realPath(path.join(confectDirectory, name)),
    );
    if (Option.isSome(real))
      files.set(real.value, Arr.append(files.get(real.value) ?? [], name));
  }
  return files;
});

/**
 * The names in `files` by which the bundled modules import a root file: an
 * import that resolves to the file and whose specifier, relative or through a
 * path alias, ends in one of its names. A module's import of itself, such as a
 * footer's, names nothing.
 */
const importedNames = (
  path: Path.Path,
  metafile: Bundler.Bundled["metafile"],
  files: ReadonlyMap<string, Arr.NonEmptyReadonlyArray<string>>,
) =>
  new Set(
    Arr.flatMap(Rec.toEntries(metafile.inputs), ([input, { imports }]) =>
      Arr.flatMap(imports, ({ path: target, original }) => {
        const names = target === input ? undefined : files.get(target);
        if (names === undefined || original === undefined) return [];
        const imported = stem(path.basename(original));
        return Arr.filter(names, (name) => stem(name) === imported);
      }),
    ),
  );

/**
 * Where each run of `bundleApp` in this process listens for root modules, by an
 * id the run takes, so runs that overlap never share one.
 */
interface Listeners {
  next: number;
  readonly byId: Map<
    number,
    (file: string, exports: Readonly<Record<string, unknown>>) => void
  >;
}

const LISTENERS = "@confect/cli/RootModule";

const listeners = (): Listeners => {
  const global = globalThis as Record<symbol, Listeners | undefined>;
  return (global[Symbol.for(LISTENERS)] ??= { next: 0, byId: new Map() });
};

const RECORD_MODULE = "confect:root-module";

/**
 * Resolves the footers' import of {@link RECORD_MODULE} to a module whose
 * `record` hands a root module to the listener with this `id`.
 */
const recordPlugin = (id: number): esbuild.Plugin => ({
  name: "confect-root-module",
  setup: (build) => {
    build.onResolve({ filter: /^confect:root-module$/ }, () => ({
      path: RECORD_MODULE,
      namespace: RECORD_MODULE,
    }));
    build.onLoad({ filter: /.*/, namespace: RECORD_MODULE }, () => ({
      contents: `export const record = (file, exports) => globalThis[Symbol.for(${quote(LISTENERS)})]?.byId.get(${id})?.(file, exports);\n`,
      loader: "js",
    }));
  },
});

/**
 * Bundle and run `app.ts`, and record each root file that run evaluates. Each
 * root file gets a footer, as the bundler reads it, that hands its own exports
 * to this run's listener when its body finishes, so a file the run never
 * evaluates, such as one behind an uncalled `import()`, records nothing and
 * runs nothing more. The footer reads no global and suffixes its bindings with
 * a random id for this run, so Unicode-escaped user bindings cannot collide.
 */
const bundleApp = Effect.gen(function* () {
  const path = yield* Path.Path;
  const files = yield* rootFiles;
  // oxlint-disable-next-line effecttsgo/crypto-random-uuid-in-effect -- Footer names need an unseeded id without a crypto service.
  const suffix = pipe(crypto.randomUUID(), String.replaceAll("-", ""));
  const recordName = `__confectRecord_${suffix}`;
  const exportsName = `__confectExports_${suffix}`;
  const footers = new Map(
    Arr.map([...files.keys()], (file) => [
      file,
      () =>
        `\nimport { record as ${recordName} } from ${quote(RECORD_MODULE)};\nimport * as ${exportsName} from ${quote(`./${path.basename(file)}`)};\n${recordName}(${quote(file)}, ${exportsName});\n`,
    ]),
  );
  const ran = new Map<string, Readonly<Record<string, unknown>>>();
  const app = yield* Effect.acquireUseRelease(
    Effect.sync(() => {
      const all = listeners();
      const id = all.next++;
      all.byId.set(id, (file, exports) => ran.set(file, exports));
      return id;
    }),
    (id) => bundleDeclaration("app.ts", { plugin: recordPlugin(id), footers }),
    (id) =>
      Effect.sync(() => {
        listeners().byId.delete(id);
      }),
  );
  const imported = importedNames(path, app.metafile, files);
  const byImport = Order.combine(
    Order.mapInput(Order.Boolean, (name: string) => !imported.has(name)),
    Order.String,
  );
  const rootModules = Arr.flatMap([...files], ([file, names]) => {
    const exports = ran.get(file);
    return exports === undefined
      ? []
      : [{ names: Arr.sort(names, byImport), exports } satisfies RootModule];
  });
  return { app, rootModules };
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
  const confectDirectory = yield* ConfectDirectory.get;
  return path.join(confectDirectory, "_generated", "manifest.ts");
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
  const filePathContents = yield* fs.readFileString(filePath);
  if (!Declaration.isGenerated(filePathContents, legacy)) {
    return;
  }
  yield* removePathIfExists(filePath);
  yield* logFileRemoved(filePath);
});

const removeManifest = Effect.gen(function* () {
  const manifestPathValue = yield* manifestPath;
  yield* removeGenerated(manifestPathValue, []);
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
  return yield* Effect.fromResult(Manifest.decode(data, file));
});

/**
 * The manifest an earlier codegen wrote, for section history and route leaves.
 * One that no longer decodes is reported once and treated as absent.
 *
 * @internal
 */
export const readPrevious = readManifest.pipe(
  Effect.catch((error) =>
    logWarn(
      `confect/_generated/manifest.ts does not decode, so manifest history starts fresh: ${error._tag === "UnsupportedManifestFormat" ? error.reason : error.message}`,
    ).pipe(Effect.as({} as Record<string, unknown>)),
  ),
);

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
    const checked = ManifestSections.check(
      registry,
      ManifestSections.sections(previous),
    );
    for (const note of checked.notes) yield* logWarn(note);
    const [error, ...more] = checked.errors;
    for (const other of more) yield* logCodegenError(other);
    if (error !== undefined) return yield* error;
    const sections = Rec.fromEntries(
      Arr.map([...registry], ([key, { data }]) => [key, data]),
    );
    const next = { ...current, sections };
    const routes = Declaration.previousLeaves(current.http);
    const digest = Declaration.manifestDigest(baseDigest, next);
    const manifestPathValue = yield* manifestPath;
    const catalogue = yield* Effect.fromResult(
      Declaration.routeCatalogue(routes, digest),
    );
    yield* writeFileStringAndLog(
      manifestPathValue,
      Declaration.renderManifest({
        ...next,
        http: catalogue,
        digest,
      }),
    );
    return baseDigest;
  },
  Effect.tapError(() => removeManifest),
);

const authProvidersPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  const confectDirectory = yield* ConfectDirectory.get;
  return path.join(confectDirectory, "_generated", "auth.providers.ts");
});

const removeAuthProviders = Effect.gen(function* () {
  const authProvidersPathValue = yield* authProvidersPath;
  yield* removeGenerated(authProvidersPathValue, []);
});

const writeDeclaration = Effect.fnUntraced(function* (
  previous: Readonly<Record<string, unknown>>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const convexDirectory = yield* ConvexDirectory.get;
  const projectRoot = yield* ProjectRoot.get;
  const target = (yield* ConvexDirectory.target).kind;

  const { app, rootModules } = yield* bundleApp;
  const appValue: unknown = app.module.default;
  if (App.isApp(appValue) && appValue.kind !== target) {
    return yield* DeclarationKindMismatchError.make({
      declarationPath: "confect/app.ts",
      declaredKind: appValue.kind,
      targetKind: target,
    });
  }
  const authPath = yield* confectPath("auth.ts");
  const auth = (yield* fs.exists(authPath))
    ? yield* Effect.asSome(bundleDeclaration("auth.ts"))
    : Option.none();

  const declaration = yield* Declaration.parse({
    target,
    app: app.module.default,
    auth: Option.map(auth, ({ module }) => module.default),
    componentImport: yield* componentImport(),
  }).pipe(
    Result.mapError((error) =>
      error._tag === "UnsupportedManifestFormat"
        ? error
        : InvalidDeclarationError.make({
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

  // A component writes its manifest too: it is the descriptor a host's
  // codegen reads through the component's `Component.make({ manifest })`.
  const digest = Declaration.digest({
    files: [
      ...(yield* declarationInputs([app, ...Option.toArray(auth)])),
      ...Arr.flatMap(declaration.mounts, ({ name, descriptor }) =>
        descriptor === undefined
          ? []
          : [[`mount:${name}`, descriptor.digest] as const],
      ),
    ],
    versions: [
      ["convex", yield* packageVersion("convex", projectRoot)],
      [
        "@confect/cli",
        yield* packageVersion("@confect/cli", import.meta.dirname),
      ],
      ["@confect/cli generator format", GENERATOR_FORMAT],
    ],
  });
  const sections = target === "app" ? ManifestSections.sections(previous) : {};
  const leaves = Declaration.previousLeaves(previous.http);
  const manifestPathValue = yield* manifestPath;
  const contents = yield* Effect.fromResult(
    Declaration.manifest(declaration, digest, sections, leaves),
  );
  yield* writeFileStringAndLog(manifestPathValue, contents);
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
        const authProvidersPathValue = yield* authProvidersPath;
        yield* writeFileStringAndLog(
          authProvidersPathValue,
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
    // Sections describe an app's functions; a component's manifest has none.
    digest: target === "app" ? digest : undefined,
    routeBase: digest,
    backend: Option.some<SectionFiles.Backend>({
      target: sectionTarget,
      sections: manifestSections,
    }),
    rootModules,
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
      routeBase: undefined,
      backend: Option.none<SectionFiles.Backend>(),
      rootModules: [],
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
 * `confect/http.ts`, with `confect/_generated/routes.ts` and `openapi.json`
 * when the backend has route specs. Runs after generation, because `http.ts`
 * imports its handlers, which import generated services. Returns the generated
 * router's change and the name of the guard `http.ts` declares.
 *
 * @internal
 */
export const syncDeclaredHttp = (
  app: App.Any,
  sectionFiles: ReadonlyArray<string>,
  base: string | undefined,
  routes: ReadonlyArray<RouteSpecs.RouteSpec>,
) =>
  checkAndWriteHttp(app, sectionFiles, base, routes).pipe(
    Effect.tapError(() => removeManifest),
  );

/**
 * Refuse route specs unless `confect/http.ts` names their guard, and return the
 * name of the guard it declares, if any.
 */
const guardOf = (
  http: Http.Any | undefined,
  routes: ReadonlyArray<RouteSpecs.RouteSpec>,
) =>
  Effect.gen(function* () {
    const guard = http?.guard;
    if (Guard.isGuard(guard)) return guard.name;
    const [route] = routes;
    if (route !== undefined)
      return yield* InvalidDeclarationError.make({
        declarationPath: "confect/http.ts",
        reason:
          http === undefined
            ? `${route.functionPath} is a route spec, so it needs a guard: export default Http.make({ guard: Guard.none }) from confect/http.ts, or pass your own guard.`
            : `${route.functionPath} is a route spec, so it needs a guard: pass Http.make a guard made with Guard.make, or Guard.none to serve routes without admission.`,
      });
    return undefined;
  });

/**
 * Write the manifest's route catalogue from the routes just checked, and the
 * final digest, which covers them: a route that changes changes the digest
 * every route leaf carries.
 */
const writeRoutes = Effect.fnUntraced(function* (
  app: App.Any,
  own: ReadonlyArray<Http.Route>,
  base: string | undefined,
) {
  if (base === undefined) return;
  for (const mount of App.mounts(app)) {
    if (
      mount.httpPrefix !== undefined &&
      mount.component.manifest === undefined
    )
      yield* logWarn(
        `The mount "${mount.name}" has HTTP prefix "${mount.httpPrefix}" but its component ships no manifest. Its routes are omitted from the route catalogue.`,
      );
  }
  const current = yield* readManifest;
  const leaves = yield* Effect.fromResult(
    Declaration.routeLeaves(own, App.mounts(app)),
  );
  const http = yield* Effect.fromResult(Declaration.routeCatalogue(leaves, ""));
  const digest = Declaration.manifestDigest(base, { ...current, http });
  const catalogue = yield* Effect.fromResult(
    Declaration.routeCatalogue(leaves, digest),
  );
  const manifestPathValue = yield* manifestPath;
  yield* writeFileString(
    manifestPathValue,
    Declaration.renderManifest({
      ...current,
      http: catalogue,
      digest,
    }),
  );
});

/**
 * Write `confect/_generated/routes.ts` for the route specs, and the OpenAPI
 * document of the api it serves. Reading that api evaluates every route, so a
 * route error without an HTTP status fails codegen here, not the router when it
 * first serves.
 */
const writeServedRoutes = Effect.fnUntraced(function* (
  app: App.Any,
  routes: Arr.NonEmptyReadonlyArray<RouteSpecs.RouteSpec>,
) {
  const path = yield* Path.Path;
  const confectDirectory = yield* ConfectDirectory.get;
  const generated = path.join(confectDirectory, "_generated");
  const fromGenerated = (file: string) =>
    toModuleImportPath(
      path.relative(generated, path.join(confectDirectory, file)),
    );
  const leaves = yield* Effect.forEach(
    Arr.dedupeWith(routes, (a, b) => a.group === b.group),
    Effect.fnUntraced(function* (route: RouteSpecs.RouteSpec) {
      const implPath = yield* implPathForSpec(route.source);
      return {
        modulePath: route.group,
        specImportPath: yield* fromGenerated(route.source),
        implImportPath: yield* fromGenerated(implPath),
      };
    }),
  );
  const routesPath = path.join(generated, ROUTES);
  const schemaImportPath = yield* fromGenerated("_generated/schema.ts");
  const contents = yield* templates.routes({
    schemaImportPath,
    leaves,
    required: app.requiresMiddleware,
  });
  yield* writeFileStringAndLog(routesPath, contents);
  const { module } = yield* Bundler.bundle(routesPath).pipe(
    Effect.mapError((error) =>
      fromBundlerError(`confect/_generated/${ROUTES}`, error),
    ),
  );
  const document = yield* Effect.try({
    try: () =>
      OpenApi.fromApi(
        (
          module.default as {
            readonly api: HttpApi.HttpApi<string, HttpApiGroup.Top>;
          }
        ).api,
      ),
    catch: (error) => routeRefusal(routes, error),
  });
  yield* writeFileStringAndLog(
    path.join(generated, OPENAPI),
    `${stringify(document, 2)}\n`,
  );
  return routesPath;
});

/**
 * A route error without a status, reported at the spec that declares the route;
 * anything else that threw while reading or documenting the routes, as an
 * import failure of `routes.ts`.
 */
const routeRefusal = (
  routes: ReadonlyArray<RouteSpecs.RouteSpec>,
  error: unknown,
) =>
  Option.match(
    Predicate.isTagged(error, "RouteErrorWithoutStatus") &&
      Predicate.hasProperty(error, "functionPath")
      ? Arr.findFirst(
          routes,
          (route) => route.functionPath === error.functionPath,
        )
      : Option.none(),
    {
      onSome: (route) =>
        InvalidDeclarationError.make({
          declarationPath: `confect/${route.source}`,
          reason: (error as Error).message,
        }),
      onNone: () =>
        ImportFailedError.make({
          file: `confect/_generated/${ROUTES}`,
          cause: error,
        }),
    },
  );

const removeServedRoutes = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const confectDirectory = yield* ConfectDirectory.get;
  const generated = path.join(confectDirectory, "_generated");
  yield* removeGenerated(path.join(generated, ROUTES), []);
  const openApi = path.join(generated, OPENAPI);
  if (yield* fs.exists(openApi)) {
    yield* removePathIfExists(openApi);
    yield* logFileRemoved(openApi);
  }
});

const checkAndWriteHttp = Effect.fnUntraced(function* (
  app: App.Any,
  sectionFiles: ReadonlyArray<string>,
  base: string | undefined,
  routes: ReadonlyArray<RouteSpecs.RouteSpec>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const convexDirectory = yield* ConvexDirectory.get;
  const confectDirectory = yield* ConfectDirectory.get;
  const httpPath = yield* confectPath("http.ts");

  const convexHttpPath = path.join(convexDirectory, "http.ts");
  if (!(yield* fs.exists(httpPath))) {
    yield* guardOf(undefined, routes);
    const own = yield* Http.routes(app).pipe(
      Result.mapError(invalid("app.ts")),
      Effect.fromResult,
    );
    yield* writeRoutes(app, own, base);
    yield* removeServedRoutes;
    yield* removeGenerated(convexHttpPath, [
      yield* templates.http({
        httpImportPath: yield* toModuleImportPath(
          path.relative(convexDirectory, httpPath),
        ),
      }),
    ]);
    return { written: Option.none(), guard: undefined };
  }

  const http = (yield* bundleDeclaration("http.ts")).module.default;
  if (!Http.isHttp(http)) {
    return yield* InvalidDeclarationError.make({
      declarationPath: "confect/http.ts",
      reason: "it must default-export Http.make(...).",
    });
  }
  const guard = yield* guardOf(http, routes);
  const own = yield* Http.routes(app, http, routes).pipe(
    Result.mapError(invalid("http.ts")),
    Effect.fromResult,
  );
  yield* writeRoutes(app, own, base);
  const routesImportPath = Arr.isReadonlyArrayNonEmpty(routes)
    ? yield* writeServedRoutes(app, routes).pipe(
        Effect.flatMap((routesPath) =>
          toModuleImportPath(path.relative(convexDirectory, routesPath)),
        ),
      )
    : yield* removeServedRoutes.pipe(Effect.as(undefined));

  const contents = yield* templates.declaredHttp({
    routesImportPath,
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
  return {
    written: Option.some({ change, convexFilePath: convexHttpPath }),
    guard,
  };
});

const DEPLOY_MODULE = "confectDeploy.ts";
const HEALTH_MODULE = "confectHealth.ts";

/**
 * Write `convex/confectHealth.ts` into an app backend, the internal query that
 * returns the digest of the manifest this run wrote; remove it from anything
 * else. A deploy compares its answer with the manifest it deployed.
 *
 * @internal
 */
export const syncHealthModule = Effect.gen(function* () {
  const path = yield* Path.Path;
  const convexDirectory = yield* ConvexDirectory.get;
  const target = (yield* ConvexDirectory.target).kind;
  const healthPath = path.join(convexDirectory, HEALTH_MODULE);
  const current = yield* readManifest;
  if (target !== "app" || !Predicate.isString(current.digest))
    return yield* removeGenerated(healthPath, []);
  yield* writeFileString(healthPath, HealthModule.render(current.digest));
});

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
 * The first export of `exports` that is the mount named `name`.
 */
const exportOf = (exports: Readonly<Record<string, unknown>>, name: string) =>
  Option.map(
    Arr.findFirst(
      Rec.toEntries(exports),
      ([, value]) =>
        Predicate.hasProperty(value, "~@confect/core/Mount") &&
        Mount.data(value as Mount.Any).name === name,
    ),
    ([exportName]) => exportName,
  );

/**
 * The one root file and export that is the mount named `name`, among the root
 * modules `app.ts` ran, each by the first of its names. When none exports it,
 * `app.ts` may load it in a way the bundle does not follow, such as an
 * `import()` of a computed path, so fall back to `confect/<name>.ts`.
 */
const mountExport = Effect.fnUntraced(function* (
  name: string,
  rootModules: ReadonlyArray<RootModule>,
) {
  const fs = yield* FileSystem.FileSystem;
  const legacy = `${name}.ts`;
  const missing = InvalidDeclarationError.make({
    declarationPath: "confect/app.ts",
    reason: `the mount ${name} runs at every push, so export it from a file directly in confect/ that app.ts imports, or from confect/${legacy}.`,
  });
  const [only, ...more] = Arr.sort(
    Arr.flatMap(rootModules, ({ names, exports }) =>
      Option.match(exportOf(exports, name), {
        onNone: () => [],
        onSome: (exportName) => [{ file: Arr.headNonEmpty(names), exportName }],
      }),
    ),
    Order.mapInput(Order.String, ({ file }: { readonly file: string }) => file),
  );
  if (only === undefined) {
    const legacyPath = yield* confectPath(legacy);
    if (!(yield* fs.exists(legacyPath))) return yield* missing;
    const exports: Record<string, unknown> = (yield* bundleDeclaration(legacy))
      .module;
    return yield* Option.match(exportOf(exports, name), {
      onNone: () => missing,
      onSome: (exportName) => Effect.succeed({ file: legacy, exportName }),
    });
  }
  if (more.length > 0)
    return yield* InvalidDeclarationError.make({
      declarationPath: "confect/app.ts",
      reason: `the mount ${name} runs at every push, so export it from one file in confect/, not from each of ${Arr.join(
        Arr.map([only, ...more], ({ file }) => `confect/${file}`),
        " and ",
      )}.`,
    });
  return only;
});

/**
 * Write `convex/confectDeploy.ts`, the internal mutation a push calls for the
 * steps it runs at each mount: every mount whose component declares `init` or
 * has a deploy module of its own, in declaration order, each imported from the
 * root file that exports it. Remove it when there are none.
 *
 * @internal
 */
export const syncDeployModule = Effect.fnUntraced(function* (
  app: Option.Option<App.Any>,
  rootModules: ReadonlyArray<RootModule>,
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
      ? yield* Effect.flatMap(
          Effect.all([displayPath(config), ConvexDirectory.target]),
          ([shown, target]) =>
            ConvexConfig.discoverInstalledComponents(
              config,
              shown,
              target.kind,
            ),
        )
      : [];
  const entries: Array<string> = [];
  const imports: Array<string> = [];
  for (const mount of Option.match(app, {
    onNone: () => [],
    onSome: App.mounts,
  })) {
    const component = Option.getOrUndefined(
      Arr.findFirst(installed, ({ name }) => name === mount.name),
    );
    const nested =
      component !== undefined && (yield* hasDeployModule(component, config));
    if (mount.component.init === undefined && !nested) continue;
    const { file, exportName } = yield* mountExport(mount.name, rootModules);
    const local = `mount${entries.length}`;
    const mountPath = yield* confectPath(file);
    const modulePath = yield* toModuleImportPath(
      path.relative(convexDirectory, mountPath),
    );
    const specifier = pipe(file, String.endsWith(".mts"))
      ? pipe(modulePath, String.replace(/\.js$/, ".mjs"))
      : modulePath;
    imports.push(`import { ${exportName} as ${local} } from "${specifier}";`);
    entries.push(`  { mount: ${local}, nested: ${nested} },`);
  }
  if (entries.length === 0) return yield* removeGenerated(deployPath, []);
  yield* writeFileStringAndLog(
    deployPath,
    Arr.join(
      [
        "// Generated by `confect codegen` from confect/app.ts. Do not edit.",
        'import { MountInit } from "@confect/server";',
        ...imports,
        "",
        "export const steps = MountInit.mutation([",
        ...entries,
        "]);",
        "",
      ],
      "\n",
    ),
  );
});
