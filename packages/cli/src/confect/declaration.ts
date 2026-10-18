import { App, Http } from "@confect/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { fromBundlerError } from "../BuildError";
import * as Bundler from "../Bundler";
import {
  HandWrittenConvexFileError,
  DeclarationKindMismatchError,
  InvalidDeclarationError,
} from "../CodegenError";
import { ConfectDirectory } from "../ConfectDirectory";
import * as ConvexConfig from "../ConvexConfig";
import { ConvexDirectory } from "../ConvexDirectory";
import * as Declaration from "../Declaration";
import { logFileRemoved } from "../log";
import { ProjectRoot } from "../ProjectRoot";
import * as templates from "../templates";
import {
  removePathIfExists,
  toModuleImportPath,
  toPosixPath,
  writeFileString,
  writeFileStringAndLog,
} from "../utils";

/**
 * Bumped when the generated files change shape, so a manifest written by an
 * older generator never matches a current one.
 */
const GENERATOR_FORMAT = "1";

const confectPath = Effect.fnUntraced(function* (file: string) {
  const path = yield* Path.Path;
  return path.join(yield* ConfectDirectory.get, file);
});

/**
 * A backend opts in to the declaration by writing `confect/app.ts`.
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
 * the digest.
 */
const declarationInputs = Effect.fnUntraced(function* (
  bundles: ReadonlyArray<Bundler.Bundled>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectRoot = yield* ProjectRoot.get;
  const files = new Set<string>();
  for (const { metafile } of bundles) {
    for (const input of Object.keys(metafile.inputs)) {
      const relative = path.relative(projectRoot, input);
      if (
        path.isAbsolute(input) &&
        !relative.startsWith("..") &&
        !relative.split(path.sep).includes("node_modules")
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
        !recorded.specifier.startsWith(".") &&
        !path.isAbsolute(recorded.specifier);
      const relative = toPosixPath(
        path,
        path.relative(convexDirectory, recorded.path),
      ).replace(/\.[cm]?[jt]s$/, "");
      return {
        importPath: bare
          ? recorded.specifier
          : relative.startsWith(".")
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

const writeDeclaration = Effect.gen(function* () {
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

  const convexConfigPath = path.join(
    convexDirectory,
    ConvexConfig.CONVEX_CONFIG_FILENAME,
  );
  const authConfigPath = path.join(convexDirectory, "auth.config.ts");
  const legacyAuthConfig = yield* templates.authConfig({
    authImportPath: yield* toModuleImportPath(
      path.relative(convexDirectory, authPath),
    ),
  });
  yield* assertOwned(convexConfigPath, "app.ts", []);
  yield* assertOwned(authConfigPath, "auth.ts", [legacyAuthConfig]);

  if (target === "app") {
    const digest = Declaration.digest({
      files: yield* declarationInputs([app, ...Option.toArray(auth)]),
      versions: [
        ["convex", yield* packageVersion("convex", projectRoot)],
        ["@confect/cli generator format", GENERATOR_FORMAT],
      ],
    });
    yield* writeFileStringAndLog(
      yield* manifestPath,
      Declaration.manifest(declaration, digest),
    );
  }
  yield* writeFileStringAndLog(
    convexConfigPath,
    Declaration.convexConfig(declaration),
  );
  yield* Option.match(declaration.providers, {
    onNone: () =>
      Effect.gen(function* () {
        if (yield* fs.exists(authConfigPath)) {
          yield* removePathIfExists(authConfigPath);
          yield* logFileRemoved(authConfigPath);
        }
      }),
    onSome: (providers) =>
      writeFileStringAndLog(authConfigPath, Declaration.authConfig(providers)),
  });
  return App.isApp(appValue) ? Option.some(appValue) : Option.none<App.Any>();
});

/**
 * Write the declaration's Convex files and manifest from `confect/app.ts`,
 * `confect/env.ts` and `confect/auth.ts`, before anything else is validated. On
 * any failure the previous manifest is removed, so a stale manifest never
 * outlives a declaration that no longer produces it.
 */
export const syncDeclaration = Effect.gen(function* () {
  if (!(yield* isDeclared)) {
    yield* removeManifest;
    return Option.none<App.Any>();
  }
  return yield* writeDeclaration.pipe(Effect.tapError(() => removeManifest));
});

/**
 * Check every HTTP route the backend serves and write `convex/http.ts` from
 * `confect/http.ts`. Runs after generation, because `http.ts` imports its
 * handlers, which import generated services.
 */
export const syncDeclaredHttp = (app: App.Any) =>
  checkAndWriteHttp(app).pipe(Effect.tapError(() => removeManifest));

const checkAndWriteHttp = Effect.fnUntraced(function* (app: App.Any) {
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
    schemaImportPath: yield* toModuleImportPath(
      path.relative(
        convexDirectory,
        path.join(confectDirectory, "_generated", "schema.ts"),
      ),
    ),
    httpImportPath: yield* toModuleImportPath(
      path.relative(convexDirectory, httpPath),
    ),
  });
  const change = yield* writeFileString(convexHttpPath, contents);
  return Option.some({ change, convexFilePath: convexHttpPath });
});
