import {
  App,
  Callback,
  Env,
  type GroupSpec,
  type ManifestSection,
  SecretSchema,
  Spec,
} from "@confect/core";
import { DatabaseSchema } from "@confect/server";
import type * as Mount from "@confect/core/Mount";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- A synchronous hash of bytes already read, matching the digest the test layer checks; Effect's Crypto is a service.
import { createHash } from "node:crypto";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as Command from "effect/cli/Command";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type * as PlatformError from "effect/PlatformError";
import type { BuildError } from "../BuildError.js";
import { pipe } from "effect/Function";
import * as HashSet from "effect/HashSet";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import type * as Scope from "effect/Scope";
import * as Bundler from "../Bundler.js";
import { fromBundlerError } from "../BuildError.js";
import * as CodegenError from "../CodegenError.js";
import { LegacySchemaFileError } from "../CodegenError.js";
import { ConfectDirectory } from "../ConfectDirectory.js";
import * as ConvexConfig from "../ConvexConfig.js";
import { ConvexDirectory } from "../ConvexDirectory.js";
import * as DirectoryOptions from "../DirectoryOptions.js";
import * as DocName from "../DocName.js";
import * as FunctionPaths from "../FunctionPaths.js";
import * as FunctionModule from "../FunctionModule.js";
import * as GenerationSnapshot from "../GenerationSnapshot.js";
import * as EntryPoint from "../EntryPoint.js";
import type { ImplModulePath } from "../ImplModulePath.js";
import {
  discoverLeafSpecFiles,
  implPathForSpec,
  loadAll,
  registeredFunctionsRelativePath,
  toLeafModule,
  validateAllImpls,
  withImplFiles,
  type LeafModule,
  type LoadedLeafModule,
} from "../LeafModule.js";
import {
  logFileAdded,
  logFileModified,
  logFileRemoved,
  logPending,
  logSuccess,
  logWarn,
} from "../log.js";
import { ProjectRoot } from "../ProjectRoot.js";
import { preserveComponentOutput } from "../Rollback.js";
import { assemblyNodesFromLeaves } from "../SpecAssemblyNode.js";
import * as ManifestSections from "../ManifestSections.js";
import * as SectionFiles from "../SectionFiles.js";
import * as TableModule from "../TableModule.js";
import * as TestingManifest from "../TestingManifest.js";
import * as templates from "../templates.js";
import {
  generateAuthConfig,
  generateCrons,
  generateHttp,
  removePathIfExists,
  toModuleImportPath,
  touchConvexSchema,
  writeFileStringAndLog,
} from "../utils.js";
import {
  syncManifestSections,
  readPrevious,
  syncDeclaration,
  syncDeployModule,
  syncHealthModule,
  syncDeclaredHttp,
  syncRoutes,
} from "./declaration.js";
import * as String from "effect/String";
import { quote, stringify } from "../Json.js";

const GENERATED_DIRNAME = "_generated";

const declaredSections = (backend: Option.Option<SectionFiles.Backend>) =>
  Option.match(backend, {
    onNone: () => [],
    onSome: ({ sections }) => sections,
  });

const isComponent = Effect.map(
  ConvexDirectory.target,
  (target) => target.kind === "component",
);

const GENERATED_SPEC_PATH = Effect.map(Path.Path, (path) =>
  path.join(GENERATED_DIRNAME, "spec.ts"),
);
const GENERATED_SCHEMA_PATH = Effect.map(Path.Path, (path) =>
  path.join(GENERATED_DIRNAME, "schema.ts"),
);
const GENERATED_CONVEX_SCHEMA_PATH = Effect.map(Path.Path, (path) =>
  path.join(GENERATED_DIRNAME, "convexSchema.ts"),
);
const GENERATED_ID_PATH = Effect.map(Path.Path, (path) =>
  path.join(GENERATED_DIRNAME, "id.ts"),
);
const GENERATED_COMPONENTS_PATH = Effect.map(Path.Path, (path) =>
  path.join(GENERATED_DIRNAME, "components.ts"),
);
const GENERATED_TABLES_DIRNAME = Effect.map(Path.Path, (path) =>
  path.join(GENERATED_DIRNAME, "tables"),
);

const LEGACY_PATHS = Effect.gen(function* () {
  const path = yield* Path.Path;

  return [
    "spec.ts",
    "nodeSpec.ts",
    "impl.ts",
    "nodeImpl.ts",
    path.join(GENERATED_DIRNAME, "registeredFunctions.ts"),
    path.join(GENERATED_DIRNAME, "nodeRegisteredFunctions.ts"),
    path.join(GENERATED_DIRNAME, "impl.ts"),
    path.join(GENERATED_DIRNAME, "nodeImpl.ts"),
    // `_generated/nodeSpec.ts` is not part of the generated output (all groups
    // live in `_generated/spec.ts`); delete any copy left by an older version.
    path.join(GENERATED_DIRNAME, "nodeSpec.ts"),
  ];
});

/**
 * @internal
 */
export const codegen = Command.make("codegen", DirectoryOptions.flags, () =>
  Effect.gen(function* () {
    yield* logPending("Performing initial sync…");
    yield* codegenHandler.pipe(
      Effect.asVoid,
      Effect.tap(() => logSuccess("Generated files are up-to-date")),
      CodegenError.tapAndLog,
    );
  }),
).pipe(
  Command.provide(DirectoryOptions.layer),
  Command.withDescription(
    "Generate `confect/_generated` files and the contents of the `convex` directory (except `tsconfig.json`, and `convex.config.ts` unless `confect/app.ts` declares the backend)",
  ),
);

const runCodegen = Effect.gen(function* () {
  yield* validateComponentConfiguration;
  yield* rejectDeployModuleGroup;
  yield* generateConfectGeneratedDirectory;
  const previousManifest = yield* readPrevious;
  // Reject a legacy `confect/schema.ts` up front so the user-facing
  // migration message surfaces before any bundler error from impl
  // validation (each impl imports `_generated/schema.ts`).
  yield* rejectLegacySchemaFile;
  // List `confect/tables/*.ts` (filename-only—no bundling yet) so the
  // `_generated/id.ts` constructor can be emitted *before* we bundle any
  // user-authored table module. Tables import from `_generated/id.ts` for
  // cross-table id refs, so it must exist on disk first.
  const tableModules = yield* TableModule.discover;
  yield* warnIfNoTables(tableModules);
  yield* generateIdConstructor(tableModules);
  // The declaration can import `_generated/refs` (a mount's callback arg),
  // which imports the assembled spec, the leaf specs and their table
  // wrappers. Their text follows from the file layout alone, so they are
  // written before the declaration is bundled, even on a first run.
  yield* generateTableWrappers(tableModules);
  yield* removeObsoleteTableWrappers(tableModules);
  const leafSpecFiles = yield* discoverLeafSpecFiles;
  const forEach2 = yield* Effect.forEach(leafSpecFiles, toLeafModule);
  yield* generateAssembledSpecs(forEach2);
  yield* generateRefs;
  // Specs and tables can import the components registry, but the registry
  // reads the `convex.config.ts` that the declaration writes. Only its type
  // depends on the config, so any registry on disk, or an empty one on a first
  // run, serves the declaration bundle until the real one is written below.
  yield* provisionalComponents;
  // A declared backend's `convex.config.ts` and manifest come next: the
  // registry below reads the config, and nothing may validate against a
  // manifest the current declaration did not produce.
  const {
    app: declared,
    digest,
    routeBase,
    backend,
    rootModules,
  } = yield* syncDeclaration(previousManifest);
  const mounts = yield* generateComponents;
  yield* validateCallbackPrefixes(declared);
  // Now that `_generated/id.ts` is on disk, bundle each table module and
  // check its default export is an `UnnamedTable`. Surface diagnostics
  // here (rather than later) so they appear before impl-validation noise.
  yield* TableModule.validate(tableModules);
  yield* validateNoDocNameCollisions(tableModules);
  yield* generateRuntimeSchema(tableModules);
  const leaves = yield* loadAll;
  yield* rejectComponentNodeGroups(leaves);
  yield* Effect.fromResult(ManifestSections.refuseSpecSections(leaves));
  const sections = yield* SectionFiles.sync(backend, leaves, mounts);
  // Nothing above writes a Convex entrypoint. The check waits for this run's
  // section files, because the HTTP router may import any of them.
  yield* FunctionModule.assertOwnedEntrypoints;
  const sectionBase = yield* syncManifestSections(
    declaredSections(backend),
    leaves,
    previousManifest,
    digest,
    sections.modules,
  );
  const base = sectionBase ?? routeBase;
  yield* removeLegacyFiles;
  const snapshot = yield* Effect.fromResult(
    GenerationSnapshot.fromLoadedLeaves(leaves),
  );
  // `_generated/api.ts`/`nodeApi.ts` are no longer imported by generated or
  // impl code (impls take the database schema from `_generated/schema`
  // directly), so remove any copies left over from earlier versions before
  // impl validation runs.
  yield* Effect.all(
    [
      removeGeneratedApi,
      generateComponentContract(tableModules),
      removeGeneratedNodeApi,
      generateDocs(tableModules),
      generateServices,
      generateConvexSchema(tableModules),
    ],
    { concurrency: "unbounded" },
  );
  const required = Option.isSome(declared)
    ? declared.value.requiresMiddleware
    : [];
  yield* validateAllImpls(leaves, required);
  yield* generateGroupRegisteredFunctions(leaves, required, sections.files);
  yield* removeObsoleteRegisteredFunctions(leaves);
  const [functionPaths] = yield* Effect.all(
    [
      FunctionModule.generateFunctions(snapshot),
      generateConvexSchemaReexport,
      logGenerated(
        Option.match(declared, {
          onNone: () => generateHttp,
          onSome: (app) => syncDeclaredHttp(app, sections.files, base),
        }),
      ),
      logGenerated(
        Option.isNone(declared)
          ? generateCrons()
          : syncDeclaredCrons(sections.crons),
      ),
      Option.isNone(declared)
        ? logGenerated(generateAuthConfig)
        : Effect.succeedNone,
    ],
    { concurrency: "unbounded" },
  );
  yield* SectionFiles.removeUnclaimed(sections.files);
  yield* syncDeployModule(declared, rootModules);
  yield* syncHealthModule;
  if (Option.isSome(declared))
    yield* generateTesting(declared.value, {
      leaves,
      sections: declaredSections(backend),
      modules: sections.modules,
    });
  yield* SectionFiles.verify(backend, mounts);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const confectDirectory = yield* ConfectDirectory.get;
  const optionalFiles = yield* Effect.filter(
    ["http.ts", "crons.ts", "auth.ts"],
    (file) => fs.exists(path.join(confectDirectory, file)),
  );
  yield* Bundler.withBatch(
    Array.map(optionalFiles, (file) => path.join(confectDirectory, file)),
    Effect.forEach(
      optionalFiles,
      (file) =>
        Bundler.check(path.join(confectDirectory, file)).pipe(
          Effect.mapError((error) => fromBundlerError(file, error)),
        ),
      { discard: true },
    ),
  );
  return {
    functionPaths,
    snapshot,
  };
});

/**
 * @internal
 */
export const generateWithSnapshot = runCodegen.pipe(
  Effect.withSpan("Cli.codegen"),
);

/**
 * @internal
 */
export const makeCodegenHandler = (
  duringRestore?: Effect.Effect<void, never, Scope.Scope>,
) =>
  preserveComponentOutput(generateWithSnapshot, duringRestore).pipe(
    Effect.tap(() => touchConvexSchema),
    Effect.map(({ functionPaths }) => ({ functionPaths })),
  );

/**
 * @internal
 */
export const codegenHandler = makeCodegenHandler();

/**
 * @internal
 */
export const updateDeclarations = Effect.fn("Cli.updateDeclarations")(
  function* (
    snapshot: GenerationSnapshot.GenerationSnapshot,
    declarations: Array.NonEmptyReadonlyArray<EntryPoint.Declaration>,
    affectedImpls: ReadonlyArray<ImplModulePath>,
  ) {
    yield* rejectDeployModuleGroup;
    const previousManifest = yield* readPrevious;
    const path = yield* Path.Path;
    const { paths, tables } = EntryPoint.planDeclarations(
      declarations,
      affectedImpls,
      path,
    );
    yield* TableModule.validate(tables);
    return yield* withImplFiles(paths, (leaves) =>
      Effect.gen(function* () {
        yield* rejectComponentNodeGroups(leaves);
        yield* Effect.fromResult(ManifestSections.refuseSpecSections(leaves));
        const next = yield* Effect.fromResult(
          GenerationSnapshot.update(snapshot, leaves),
        );
        const {
          app: declared,
          digest,
          routeBase,
          backend,
        } = yield* syncDeclaration(previousManifest);
        const all = Option.isSome(declared) ? yield* loadAll : [];
        const mounts = Option.isSome(backend) ? yield* installedMounts : [];
        const sections = yield* SectionFiles.sync(backend, all, mounts);
        const sectionBase = Option.isSome(declared)
          ? yield* syncManifestSections(
              declaredSections(backend),
              all,
              previousManifest,
              digest,
              sections.modules,
            )
          : undefined;
        const base = sectionBase ?? routeBase;
        const required = Option.isSome(declared)
          ? declared.value.requiresMiddleware
          : [];
        yield* validateAllImpls(leaves, required);
        // A section file that appeared or went changes every registration
        // file's imports and the HTTP router's, not only the edited groups'.
        yield* generateGroupRegisteredFunctions(
          sections.changed ? all : leaves,
          required,
          sections.files,
        );
        if (sections.changed && Option.isSome(declared))
          yield* logGenerated(
            syncDeclaredHttp(declared.value, sections.files, base),
          );
        else if (Option.isSome(declared))
          yield* syncRoutes(declared.value, base);
        if (Option.isSome(declared)) yield* syncHealthModule;
        // Which sections wrap crons can change while the section files stay.
        if (Option.isSome(declared))
          yield* logGenerated(generateCrons(sections.crons));
        yield* SectionFiles.removeUnclaimed(sections.files);
        yield* FunctionModule.applyFunctionPlan(
          GenerationSnapshot.diff(snapshot, next),
        );
        yield* SectionFiles.verify(backend, mounts);
        return next;
      }),
    );
  },
);

// Convex components cannot run Node.js functions, at any nesting depth.
const validateComponentGroupRuntime = (
  group: GroupSpec.AnyWithProps,
  groupPath: string,
  specPath: string,
): Result.Result<void, CodegenError.ComponentNodeGroupError> =>
  Result.gen(function* () {
    if (group.runtime === "Node") {
      return yield* Result.fail(
        CodegenError.ComponentNodeGroupError.make({ specPath, groupPath }),
      );
    }
    for (const [name, child] of Record.toEntries(group.groups)) {
      yield* validateComponentGroupRuntime(
        child,
        `${groupPath}.${name}`,
        specPath,
      );
    }
  });

const rejectComponentNodeGroups = Effect.fnUntraced(function* (
  leaves: ReadonlyArray<LoadedLeafModule>,
) {
  if ((yield* ConvexDirectory.target).kind === "app") return;
  yield* Effect.forEach(leaves, (leaf) =>
    Effect.fromResult(
      validateComponentGroupRuntime(
        leaf.spec,
        leaf.groupPathDot,
        leaf.relativePath,
      ),
    ),
  );
});

const validateCallbackPrefixes = Effect.fnUntraced(function* (
  declared: Option.Option<App.Any>,
) {
  if ((yield* ConvexDirectory.target).kind !== "component") return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const confectDirectory = yield* ConfectDirectory.get;
  const callbacksPath = path.join(confectDirectory, "callbacks.ts");
  if (!(yield* fs.exists(callbacksPath))) return;
  const name = Option.isSome(declared)
    ? Env.name(App.env(declared.value))
    : yield* Effect.flatMap(ConvexDirectory.get, (convexDirectory) =>
        ConvexConfig.componentName(
          path.join(convexDirectory, ConvexConfig.CONVEX_CONFIG_FILENAME),
        ),
      );
  const { module } = yield* Bundler.bundle(callbacksPath).pipe(
    Effect.mapError((error) => fromBundlerError("confect/callbacks.ts", error)),
  );
  for (const contract of Record.values(module)) {
    if (
      Callback.isContract(contract) &&
      !pipe(contract.id, String.startsWith(`${name}/`))
    ) {
      return yield* CodegenError.CallbackPrefixError.make({
        declarationPath: "confect/callbacks.ts",
        contractId: contract.id,
        componentName: name,
      });
    }
  }
});

const validateComponentConfiguration = Effect.gen(function* () {
  return yield* Match.value((yield* ConvexDirectory.target).kind).pipe(
    Match.when("app", () => Effect.void),
    Match.when("component", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const confectDirectory = yield* ConfectDirectory.get;
        const authPath = path.join(confectDirectory, "auth.ts");
        if (yield* fs.exists(authPath)) {
          return yield* CodegenError.InvalidConvexConfigError.make({
            configPath: authPath,
            reason:
              "Components cannot configure application authentication. Pass identity explicitly through function arguments.",
          });
        }
      }),
    ),
    Match.exhaustive,
  );
});

const generateComponentContract = Effect.fnUntraced(function* (
  tables: ReadonlyArray<TableModule.TableModule>,
) {
  return yield* Match.value((yield* ConvexDirectory.target).kind).pipe(
    Match.when("app", () => Effect.void),
    Match.when("component", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const directory = yield* ConfectDirectory.get;
        const contents = yield* templates.componentContract({
          tableNames: Array.map(tables, (table) => table.tableName),
        });
        yield* writeFileStringAndLog(
          path.join(directory, GENERATED_DIRNAME, "component.ts"),
          contents,
        );
      }),
    ),
    Match.exhaustive,
  );
});

const generateConfectGeneratedDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const confectDirectory = yield* ConfectDirectory.get;

  if (!(yield* fs.exists(path.join(confectDirectory, "_generated")))) {
    yield* fs.makeDirectory(path.join(confectDirectory, "_generated"), {
      recursive: true,
    });
    yield* logFileAdded(path.join(confectDirectory, "_generated") + "/");
  }
});

const removeLegacyFiles = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const confectDirectory = yield* ConfectDirectory.get;
  const legacyPaths = yield* LEGACY_PATHS;

  yield* Effect.forEach(
    legacyPaths,
    Effect.fnUntraced(function* (relativePath: string) {
      const absolutePath = path.join(confectDirectory, relativePath);
      if (yield* fs.exists(absolutePath)) {
        yield* removePathIfExists(absolutePath);
        yield* logFileRemoved(absolutePath);
      }
    }),
  );
});

const generateAssembledSpecs = Effect.fnUntraced(function* (
  leaves: ReadonlyArray<LeafModule>,
) {
  const path = yield* Path.Path;
  const confectDirectory = yield* ConfectDirectory.get;
  const generatedSpecPath = yield* GENERATED_SPEC_PATH;

  // A single assembled spec holds every group regardless of runtime—a Node
  // group's `makeNode()` lives in its imported leaf spec, so the assembled
  // file is runtime-agnostic. Always emit it (even empty) so downstream
  // readers (`loadGeneratedSpec`, `generateRefs`) always find a spec module.
  const nodes = assemblyNodesFromLeaves(leaves);
  const specContents = yield* templates.assembledSpec({ nodes });
  yield* writeFileStringAndLog(
    path.join(confectDirectory, generatedSpecPath),
    specContents,
  );
});

const generateGroupRegisteredFunctions = Effect.fnUntraced(function* (
  leaves: ReadonlyArray<LoadedLeafModule>,
  required: ReadonlyArray<{ readonly key: string }>,
  sectionFiles: ReadonlyArray<string>,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const confectDirectory = yield* ConfectDirectory.get;
  const runtimePath = path.join(confectDirectory, "runtime.ts");
  const hasRuntime = yield* fs.exists(runtimePath);

  yield* Effect.forEach(
    leaves,
    Effect.fnUntraced(function* (leaf: LoadedLeafModule) {
      const registryRelativePath = yield* registeredFunctionsRelativePath(leaf);
      const registryPath = path.join(
        confectDirectory,
        "_generated",
        registryRelativePath,
      );
      const registryDir = path.dirname(registryPath);
      if (!(yield* fs.exists(registryDir))) {
        yield* fs.makeDirectory(registryDir, { recursive: true });
      }

      const implRelativePath = yield* implPathForSpec(leaf.relativePath);
      const schemaImportPath = yield* toModuleImportPath(
        path.relative(
          path.dirname(registryPath),
          path.join(confectDirectory, "_generated", "schema.ts"),
        ),
      );
      // The group's own leaf spec (sibling of its impl), referenced
      // type-only by the registry to shape its returned record.
      const specImportPath = yield* toModuleImportPath(
        path.relative(
          path.dirname(registryPath),
          path.join(confectDirectory, leaf.relativePath),
        ),
      );
      const implImportPath = yield* toModuleImportPath(
        path.relative(
          path.dirname(registryPath),
          path.join(confectDirectory, implRelativePath),
        ),
      );

      const contents = yield* templates.registeredFunctionsForGroup({
        spec: leaf.spec,
        required,
        groupPath: leaf.groupPathDot,
        schemaImportPath,
        specImportPath,
        implImportPath,
        runtimeImportPath: hasRuntime
          ? yield* toModuleImportPath(path.relative(registryDir, runtimePath))
          : undefined,
        sectionImportPaths: yield* Effect.forEach(sectionFiles, (file) =>
          toModuleImportPath(
            path.relative(
              registryDir,
              path.join(confectDirectory, "_generated", file),
            ),
          ),
        ),
      });

      yield* writeFileStringAndLog(registryPath, contents);
    }),
  );
});

const removeObsoleteRegisteredFunctions = Effect.fnUntraced(function* (
  leaves: ReadonlyArray<LeafModule>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const confectDirectory = yield* ConfectDirectory.get;
  const registryRoot = path.join(
    confectDirectory,
    "_generated",
    "registeredFunctions",
  );

  if (!(yield* fs.exists(registryRoot))) {
    return;
  }

  const expectedPaths = yield* Effect.forEach(leaves, (leaf) =>
    registeredFunctionsRelativePath(leaf),
  );
  const expected = new Set(expectedPaths);

  const existing = yield* fs.readDirectory(registryRoot, { recursive: true });
  yield* Effect.forEach(existing, (relativePath) => {
    if (path.extname(relativePath) !== ".ts") {
      return Effect.void;
    }
    const normalized = path.join("registeredFunctions", relativePath);
    if (!expected.has(normalized)) {
      return Effect.gen(function* () {
        const absolutePath = path.join(registryRoot, relativePath);
        if (yield* fs.exists(absolutePath)) {
          yield* removePathIfExists(absolutePath);
          yield* logFileRemoved(absolutePath);
        }
      });
    }
    return Effect.void;
  });
});

const getGeneratedSpecPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  const confectDirectory = yield* ConfectDirectory.get;
  const generatedSpecPath = yield* GENERATED_SPEC_PATH;
  return path.join(confectDirectory, generatedSpecPath);
});

const loadGeneratedSpec = Effect.gen(function* () {
  const specPath = yield* getGeneratedSpecPath;
  const { module: specModule } = yield* Bundler.bundle(specPath);
  const spec = specModule.default;

  if (!Spec.isSpec(spec)) {
    return yield* Effect.die(
      new Error("_generated/spec.ts does not export a valid Spec"),
    );
  }

  return spec;
});

const emptyFunctionPaths = FunctionPaths.FunctionPaths.make(HashSet.empty());

/**
 * @internal
 */
export const loadPreviousFunctionPaths = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const specPath = yield* getGeneratedSpecPath;

  if (!(yield* fs.exists(specPath))) {
    return emptyFunctionPaths;
  }

  const specResult = yield* loadGeneratedSpec.pipe(Effect.result);

  return Result.match(specResult, {
    onFailure: () => emptyFunctionPaths,
    onSuccess: (spec) => FunctionPaths.make(spec),
  });
});

/**
 * Remove a now-obsolete `_generated/<name>.ts` if present (and log it), for
 * projects upgrading from a version that still emitted it.
 */
const removeObsoleteGeneratedFile = Effect.fnUntraced(function* (
  fileName: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const confectDirectory = yield* ConfectDirectory.get;
  const filePath = path.join(confectDirectory, "_generated", fileName);

  if (yield* fs.exists(filePath)) {
    yield* removePathIfExists(filePath);
    yield* logFileRemoved(filePath);
  }
});

// `_generated/api.ts` is no longer imported by generated or impl code: impls
// take the database schema (`_generated/schema`) directly, and per-group
// registries reference the spec type-only. Remove any stale copy.
const removeGeneratedApi = removeObsoleteGeneratedFile("api.ts");

// `_generated/nodeApi.ts` is obsolete for the same reason.
const removeGeneratedNodeApi = removeObsoleteGeneratedFile("nodeApi.ts");

/**
 * The user-authored `confect/schema.ts` is no longer supported: codegen now
 * owns both `_generated/schema.ts` (runtime) and `_generated/convexSchema.ts`
 * (deploy), derived from a single scan of `confect/tables/*.ts`. Detect a stray
 * file and fail with a clear migration message—leaving it in place would
 * silently shadow the codegen-owned
 * `_generated/schema.ts`/`_generated/convexSchema.ts`.
 */
const rejectLegacySchemaFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const confectDirectory = yield* ConfectDirectory.get;
  const legacyPath = path.join(confectDirectory, "schema.ts");

  if (yield* fs.exists(legacyPath)) {
    return yield* LegacySchemaFileError.make({ schemaPath: "schema.ts" });
  }
});

// A root group named `confectDeploy` would write the entrypoint
// `syncDeployModule` owns, so refuse it before anything is written.
const rejectDeployModuleGroup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const confectDirectory = yield* ConfectDirectory.get;
  if (yield* fs.exists(path.join(confectDirectory, "confectHealth.spec.ts")))
    return yield* CodegenError.InvalidDeclarationError.make({
      declarationPath: "confect/confectHealth.spec.ts",
      reason:
        "its functions would go in convex/confectHealth.ts, which codegen writes for the deploy's digest check. Rename the group.",
    });
  if (yield* fs.exists(path.join(confectDirectory, "confectDeploy.spec.ts")))
    return yield* CodegenError.InvalidDeclarationError.make({
      declarationPath: "confect/confectDeploy.spec.ts",
      reason:
        "its functions would go in convex/confectDeploy.ts, which codegen writes for the mounts a push initialises. Rename the group, for example to confect/deploy.spec.ts.",
    });
});

/**
 * Surface a yellow `⚠` warning when codegen sees no tables—either the
 * `confect/tables/` directory is missing or it contains no `.ts` files.
 * Generation still succeeds (emitting an empty `DatabaseSchema` and
 * `defineSchema({})`), since action-only/table-free Confect backends are
 * legal—but the warning catches the much more common case of a typoed directory
 * or files placed under the wrong root.
 */
const warnIfNoTables = (tableModules: ReadonlyArray<TableModule.TableModule>) =>
  tableModules.length === 0
    ? logWarn(
        `No tables discovered in \`confect/${TableModule.TABLES_DIRNAME}/\`. ` +
          `Generating an empty schema; add a \`Table.make(...)\` module under that ` +
          `directory unless this backend is intentionally tables-free.`,
      )
    : Effect.void;

const tableModuleBindings = Effect.fnUntraced(function* (
  tableModules: ReadonlyArray<TableModule.TableModule>,
  generatedFilePath: string,
) {
  const path = yield* Path.Path;
  const confectDirectory = yield* ConfectDirectory.get;
  const generatedDir = path.dirname(generatedFilePath);

  const generatedTablesDirname = yield* GENERATED_TABLES_DIRNAME;

  return yield* Effect.forEach(
    tableModules,
    Effect.fnUntraced(function* (tableModule: TableModule.TableModule) {
      const wrapperAbsolutePath = path.join(
        confectDirectory,
        generatedTablesDirname,
        `${tableModule.tableName}.ts`,
      );
      const importPath = yield* toModuleImportPath(
        path.relative(generatedDir, wrapperAbsolutePath),
      );
      return {
        importPath,
        tableName: tableModule.tableName,
      };
    }),
  );
});

const generateIdConstructor = Effect.fnUntraced(function* (
  tableModules: ReadonlyArray<TableModule.TableModule>,
) {
  const path = yield* Path.Path;
  const confectDirectory = yield* ConfectDirectory.get;
  const generatedIdPath = yield* GENERATED_ID_PATH;
  const idPath = path.join(confectDirectory, generatedIdPath);

  const tableNames = Array.map(
    tableModules,
    (tableModule) => tableModule.tableName,
  );
  const convexDirectory = yield* ConvexDirectory.target;
  const contents = yield* Match.value(convexDirectory).pipe(
    Match.when({ kind: "app" }, () => templates.id({ tableNames })),
    Match.when({ kind: "component" }, ({ scope }) =>
      templates.id({ tableNames, scope }),
    ),
    Match.exhaustive,
  );

  yield* writeFileStringAndLog(idPath, contents);
});

const generateTableWrappers = Effect.fnUntraced(function* (
  tableModules: ReadonlyArray<TableModule.TableModule>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const confectDirectory = yield* ConfectDirectory.get;
  const generatedTablesDirname = yield* GENERATED_TABLES_DIRNAME;
  const wrappersDir = path.join(confectDirectory, generatedTablesDirname);

  if (!(yield* fs.exists(wrappersDir))) {
    yield* fs.makeDirectory(wrappersDir, { recursive: true });
  }

  yield* Effect.forEach(
    tableModules,
    Effect.fnUntraced(function* (tableModule: TableModule.TableModule) {
      const wrapperPath = path.join(
        confectDirectory,
        generatedTablesDirname,
        `${tableModule.tableName}.ts`,
      );
      const unnamedAbsolutePath = path.join(
        confectDirectory,
        tableModule.relativePath,
      );
      const unnamedImportPath = yield* toModuleImportPath(
        path.relative(path.dirname(wrapperPath), unnamedAbsolutePath),
      );
      const contents = yield* templates.tableWrapper({
        tableName: tableModule.tableName,
        unnamedImportPath,
        component: yield* isComponent,
      });
      yield* writeFileStringAndLog(wrapperPath, contents);
    }),
    { concurrency: "unbounded" },
  );
});

/**
 * Remove any stale `_generated/tables/*.ts` wrapper whose source table has been
 * deleted or renamed. Mirrors `removeObsoleteRegisteredFunctions` for the
 * wrapper directory.
 */
const removeObsoleteTableWrappers = Effect.fnUntraced(function* (
  tableModules: ReadonlyArray<TableModule.TableModule>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const confectDirectory = yield* ConfectDirectory.get;
  const generatedTablesDirname = yield* GENERATED_TABLES_DIRNAME;
  const wrappersDir = path.join(confectDirectory, generatedTablesDirname);

  if (!(yield* fs.exists(wrappersDir))) {
    return;
  }

  const expected = new Set(
    Array.map(tableModules, (tableModule) => `${tableModule.tableName}.ts`),
  );
  const existing = yield* fs.readDirectory(wrappersDir, { recursive: true });
  yield* Effect.forEach(existing, (entry) => {
    if (path.extname(entry) !== ".ts") {
      return Effect.void;
    }
    if (!expected.has(entry)) {
      return Effect.gen(function* () {
        const absolutePath = path.join(wrappersDir, entry);
        if (yield* fs.exists(absolutePath)) {
          yield* removePathIfExists(absolutePath);
          yield* logFileRemoved(absolutePath);
        }
      });
    }
    return Effect.void;
  });
});

const generateRuntimeSchema = Effect.fnUntraced(function* (
  tableModules: ReadonlyArray<TableModule.TableModule>,
) {
  const path = yield* Path.Path;
  const confectDirectory = yield* ConfectDirectory.get;
  const generatedSchemaPath = yield* GENERATED_SCHEMA_PATH;
  const schemaPath = path.join(confectDirectory, generatedSchemaPath);

  const bindings = yield* tableModuleBindings(tableModules, schemaPath);
  const contents = yield* templates.runtimeSchema({
    tableModules: bindings,
    component: yield* isComponent,
  });

  yield* writeFileStringAndLog(schemaPath, contents);
});

const generateConvexSchema = Effect.fnUntraced(function* (
  tableModules: ReadonlyArray<TableModule.TableModule>,
) {
  const path = yield* Path.Path;
  const confectDirectory = yield* ConfectDirectory.get;
  const generatedConvexSchemaPath = yield* GENERATED_CONVEX_SCHEMA_PATH;
  const convexSchemaPath = path.join(
    confectDirectory,
    generatedConvexSchemaPath,
  );

  const bindings = yield* tableModuleBindings(tableModules, convexSchemaPath);
  const contents = yield* templates.convexSchema({ tableModules: bindings });

  yield* writeFileStringAndLog(convexSchemaPath, contents);
});

const generateConvexSchemaReexport = Effect.gen(function* () {
  const path = yield* Path.Path;
  const confectDirectory = yield* ConfectDirectory.get;
  const convexDirectory = yield* ConvexDirectory.get;
  const generatedConvexSchemaRelativePath = yield* GENERATED_CONVEX_SCHEMA_PATH;

  const convexSchemaPath = path.join(convexDirectory, "schema.ts");
  const generatedConvexSchemaPath = path.join(
    confectDirectory,
    generatedConvexSchemaRelativePath,
  );

  const convexSchemaImportPath = yield* toModuleImportPath(
    path.relative(path.dirname(convexSchemaPath), generatedConvexSchemaPath),
  );

  const schemaContents = yield* templates.schema({
    convexSchemaImportPath,
  });

  yield* writeFileStringAndLog(convexSchemaPath, schemaContents);
});

const generateServices = Effect.gen(function* () {
  const path = yield* Path.Path;
  const confectDirectory = yield* ConfectDirectory.get;

  const confectGeneratedDirectory = path.join(confectDirectory, "_generated");

  const servicesPath = path.join(confectGeneratedDirectory, "services.ts");
  const generatedSchemaPath = yield* GENERATED_SCHEMA_PATH;
  const schemaImportPath = yield* toModuleImportPath(
    path.relative(
      path.dirname(servicesPath),
      path.join(confectDirectory, generatedSchemaPath),
    ),
  );

  const servicesContentsString = yield* templates.services({
    schemaImportPath,
    component: yield* isComponent,
  });

  yield* writeFileStringAndLog(servicesPath, servicesContentsString);
});

/**
 * Two tables whose names fold to the same PascalCase document type name (e.g.
 * `user_profiles` and `userProfiles` → `UserProfilesDoc`) would emit duplicate
 * interfaces in `_generated/docs.ts`. Catch that up front with a clear error
 * rather than letting `tsc` report a duplicate-identifier later.
 */
const validateNoDocNameCollisions = Effect.fnUntraced(function* (
  tableModules: ReadonlyArray<TableModule.TableModule>,
) {
  const collisions = pipe(
    tableModules,
    Array.groupBy((tableModule) =>
      DocName.fromTableName(tableModule.tableName),
    ),
    Record.toEntries,
    Array.filter(([, group]) => group.length > 1),
    Array.map(([docName, group]) => ({
      docName,
      tableNames: Array.map(group, (tableModule) => tableModule.tableName),
    })),
  );

  if (Array.isReadonlyArrayNonEmpty(collisions)) {
    return yield* CodegenError.ConflictingDocNameError.make({ collisions });
  }
});

const generateDocs = Effect.fnUntraced(function* (
  tableModules: ReadonlyArray<TableModule.TableModule>,
) {
  const path = yield* Path.Path;
  const confectDirectory = yield* ConfectDirectory.get;

  const confectGeneratedDirectory = path.join(confectDirectory, "_generated");

  const docsPath = path.join(confectGeneratedDirectory, "docs.ts");
  const generatedSchemaPath = yield* GENERATED_SCHEMA_PATH;
  const schemaImportPath = yield* toModuleImportPath(
    path.relative(
      path.dirname(docsPath),
      path.join(confectDirectory, generatedSchemaPath),
    ),
  );

  const docsContentsString = yield* templates.docs({
    schemaImportPath,
    tables: Array.map(tableModules, (tableModule) => ({
      tableName: tableModule.tableName,
      docName: DocName.fromTableName(tableModule.tableName),
    })),
  });

  yield* writeFileStringAndLog(docsPath, docsContentsString);
});

const generateRefs = Effect.gen(function* () {
  const path = yield* Path.Path;
  const confectDirectory = yield* ConfectDirectory.get;

  const confectGeneratedDirectory = path.join(confectDirectory, "_generated");
  const refsPath = path.join(confectGeneratedDirectory, "refs.ts");
  const refsDir = path.dirname(refsPath);
  const generatedSpecPath = yield* GENERATED_SPEC_PATH;

  const specImportPath = yield* toModuleImportPath(
    path.relative(refsDir, path.join(confectDirectory, generatedSpecPath)),
  );

  const refsContents = yield* templates.refs({ specImportPath });

  yield* writeFileStringAndLog(refsPath, refsContents);
});

const installedMounts = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const confectDirectory = yield* ConfectDirectory.get;
  const convexDirectory = yield* ConvexDirectory.get;
  const projectRoot = yield* ProjectRoot.get;
  const convexConfigPath = path.join(
    convexDirectory,
    ConvexConfig.CONVEX_CONFIG_FILENAME,
  );
  const installedComponents = (yield* fs.exists(convexConfigPath))
    ? yield* ConvexConfig.discoverInstalledComponents(
        convexConfigPath,
        path.relative(projectRoot, convexConfigPath),
        (yield* ConvexDirectory.target).kind,
      )
    : [];
  return Array.map(
    installedComponents,
    ({ name, componentDefinitionPath }) => ({
      name,
      definition: ConvexConfig.typeImportPath(
        path,
        componentDefinitionPath,
        path.join(confectDirectory, GENERATED_DIRNAME),
      ),
    }),
  );
});

/**
 * Generate `confect/_generated/components.ts`—the typed registry of Convex
 * components installed in `convex/convex.config.ts` (see
 * {@link templates.components}). The file is emitted even when there is no
 * `convex.config.ts` (as an empty registry) so the import surface stays stable.
 * It must exist before loading tables and specs because they may import bound
 * component IDs and schemas. Returns each mount with the specifier of its
 * definition, relative to `_generated` for an in-repo component.
 *
 * @internal
 */
export const generateComponents = Effect.gen(function* () {
  const path = yield* Path.Path;
  const confectDirectory = yield* ConfectDirectory.get;
  const mounts = yield* installedMounts;
  const contents = yield* templates.components({
    components: Array.map(mounts, ({ name, definition }) => ({
      name,
      typeImportPath: definition,
    })),
  });

  const gENERATEDCOMPONENTSPATH = yield* GENERATED_COMPONENTS_PATH;
  yield* writeFileStringAndLog(
    path.join(confectDirectory, gENERATEDCOMPONENTSPATH),
    contents,
  );
  return mounts;
});

const provisionalComponents = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const confectDirectory = yield* ConfectDirectory.get;
  const gENERATEDCOMPONENTSPATH = yield* GENERATED_COMPONENTS_PATH;
  const registry = path.join(confectDirectory, gENERATEDCOMPONENTSPATH);
  if (yield* fs.exists(registry)) return;
  const components2 = yield* templates.components({ components: [] });
  yield* writeFileStringAndLog(registry, components2);
});

/**
 * Write a declared backend's `convex/crons.ts`, or remove it once
 * `confect/crons.ts` is gone. Its edits run full generation, so
 * `assertOwnedEntrypoints` has proved an existing file is codegen's.
 */
const syncDeclaredCrons = Effect.fnUntraced(function* (
  sectionFiles: ReadonlyArray<string>,
) {
  const written = yield* generateCrons(sectionFiles);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const convexDirectory = yield* ConvexDirectory.get;
  const convexCrons = path.join(convexDirectory, "crons.ts");
  if (Option.isNone(written) && (yield* fs.exists(convexCrons))) {
    yield* fs.remove(convexCrons);
    yield* logFileRemoved(convexCrons);
  }
  return written;
});

const logGenerated = <E, R>(
  effect: Effect.Effect<
    Option.Option<{
      readonly change: "Added" | "Modified" | "Unchanged";
      readonly convexFilePath: string;
    }>,
    E,
    R
  >,
) =>
  effect.pipe(
    Effect.tap(
      Option.match({
        onNone: () => Effect.void,
        onSome: ({ change, convexFilePath }) =>
          Match.value(change).pipe(
            Match.when("Added", () => logFileAdded(convexFilePath)),
            Match.when("Modified", () => logFileModified(convexFilePath)),
            Match.when("Unchanged", () => Effect.void),
            Match.exhaustive,
          ),
      }),
    ),
  );

/**
 * A descriptor's `testing` kit must be a package specifier, so the generated
 * registry holds no machine-specific path, and must export `register`. A kit
 * whose exports cannot be listed without running it passes here, and
 * `TestConfect.layer` names the mount if it has no `register`.
 */
const checkTestKit = Effect.fnUntraced(function* (
  mount: string,
  specifier: string,
  config: string,
  configDisplay: string,
) {
  const path = yield* Path.Path;
  const invalid = (problem: string) =>
    CodegenError.InvalidDeclarationError.make({
      declarationPath: "confect/app.ts",
      reason: `the mount ${quote(mount)} names the test kit ${quote(specifier)} in its component descriptor${problem}`,
    });
  if (pipe(specifier, String.startsWith(".")) || path.isAbsolute(specifier)) {
    return yield* invalid(
      '; name it by a package specifier, such as "<package>/testing".',
    );
  }
  const resolved = Bundler.resolveModule(specifier, config);
  if (Option.isNone(resolved)) {
    return yield* invalid(`, which does not resolve from ${configDisplay}.`);
  }
  const exports = yield* Bundler.exportNames(resolved.value).pipe(
    Effect.mapError((error) => fromBundlerError(specifier, error)),
  );
  if (Option.isSome(exports) && !exports.value.includes("register")) {
    return yield* invalid(", which does not export `register(t, name)`.");
  }
});

/**
 * The loader generated `testing.ts` gives each module of a local component's
 * mount. Under Vite it loads the module for that mount alone, and
 * `@confect/test/Vite`'s plugin carries the mount to every file it imports,
 * wherever it sits, as a deployment bundles each mount's modules apart. A
 * second mount of one component refuses to load without the plugin, since its
 * helpers' module code would run under the first mount's settings. Elsewhere,
 * as in a bundle, every mount shares one copy.
 */
const mountModule = `// Each mount loads its own copy of its component's modules, as a deployment does.
const mountModules = new Map<string, string>();
const mountModule =
  (mount: string, specifier: string, load: () => Promise<unknown>) =>
  (import.meta as { readonly env?: unknown }).env === undefined
    ? load
    : () => {
        const first = mountModules.get(specifier) ?? mount;
        mountModules.set(specifier, first);
        return import(/* @vite-ignore */ \`\${specifier}?confect-mount=\${encodeURIComponent(mount)}\`).then((module: unknown) => {
          if (
            first !== mount &&
            (globalThis as Record<symbol, unknown>)[Symbol.for("@confect/test/Vite")] !== true
          )
            throw new Error(
              \`Mounts "\${first}" and "\${mount}" both load \${specifier}, and each needs its own copy of the files it imports, as a deployment gives each mount. Add plugin() from "@confect/test/Vite" to the Vitest config's plugins.\`,
            );
          return module;
        });
      };`;

/**
 * The reader generated `testing.ts` gives each module's source. It reaches
 * `node:fs` and `URL` without naming their types, so the file compiles in an
 * app without `@types/node`.
 */
const moduleSource = `// Each module's text, read from disk where the test runs, for the test kernel's "use node" check.
const moduleSource = (path: string) => (): Promise<string> =>
  import(/* @vite-ignore */ String("node:fs/promises")).then(
    (fs: { readonly readFile: (file: unknown, encoding: "utf8") => Promise<string> }) =>
      fs.readFile(
        new (globalThis as unknown as { readonly URL: new (input: string, base: string) => unknown }).URL(
          path,
          (import.meta as unknown as { readonly url: string }).url,
        ),
        "utf8",
      ),
  );`;

/**
 * What a path holds, as `lstat` reads it.
 */
type EntryKind =
  | "file"
  | "directory"
  | "symbolic link"
  | "something else"
  | "nothing";

/**
 * The reader generated `testing.ts` gives each packaged mount. It reads the
 * files codegen read and returns them with codegen's entries, as data. Each
 * step names a package, found from the step before by Node's `node_modules`
 * lookup, which no export condition changes, and the definition's file inside
 * it. The test layer checks the version, each file's digest, each walked
 * entry's kind and real path, and each absent path on every open, so the reader
 * holds no state and checks nothing. Like {@link moduleSource}, it names no
 * Node type.
 */
const packageRead = `// Each packaged mount's installed files, read where codegen read them, for the test layer to check against codegen's digests.
// A mount whose layout the registry does not read is a record instead, which the test layer refuses until the test declares its runtime.
type PackageFile = { readonly file: string; readonly digest: string };
type PackageStep = { readonly package?: string; readonly version?: string; readonly manifest?: string; readonly file: string; readonly digest: string; readonly helpers?: ReadonlyArray<PackageFile>; readonly absent?: ReadonlyArray<string>; readonly walked?: ReadonlyArray<PackageEntry> };
type PackageEntry = { readonly path: string; readonly kind: "file" | "directory" };
type PackageStat = { readonly isFile: () => boolean; readonly isDirectory: () => boolean; readonly isSymbolicLink: () => boolean };
type PackageNode = {
  readonly existsSync: (file: string) => boolean;
  readonly lstatSync: (file: string, options: { readonly throwIfNoEntry: false }) => PackageStat | undefined;
  readonly readFileSync: { (file: string): Uint8Array; (file: string, encoding: "utf8"): string };
  readonly realpathSync: (file: string) => string;
  readonly basename: (file: string) => string;
  readonly dirname: (file: string) => string;
  readonly join: (...segments: ReadonlyArray<string>) => string;
  readonly fileURLToPath: (url: string) => string;
};
const packageNode = (): Promise<PackageNode> =>
  Promise.all([
    import(/* @vite-ignore */ String("node:fs")),
    import(/* @vite-ignore */ String("node:path")),
    import(/* @vite-ignore */ String("node:url")),
  ]).then(([fs, path, url]: ReadonlyArray<any>) => ({ ...fs, ...path, ...url }) as PackageNode);
const installedPackage = (node: PackageNode, from: string, name: string): string | undefined => {
  for (let directory = from; ; directory = node.dirname(directory)) {
    const candidate = node.join(directory, "node_modules", name);
    if (node.basename(directory) !== "node_modules" && node.existsSync(node.join(candidate, "package.json")))
      return node.realpathSync(candidate);
    if (node.dirname(directory) === directory) return undefined;
  }
};
const packageRead = (steps: ReadonlyArray<PackageStep>, files: ReadonlyArray<PackageFile>, convex?: { readonly manifest: string }) => () =>
  packageNode().then((node) => {
    const attempt = <A,>(read: () => A): { readonly value?: A; readonly failure?: string } => {
      try {
        return { value: read() };
      } catch (error) {
        return { failure: String(error) };
      }
    };
    // What a path holds, as lstat reads it: a link, dangling or not, is a link.
    const entryAt = (file: string): string => {
      const info = attempt(() => node.lstatSync(file, { throwIfNoEntry: false })).value;
      if (info === undefined) return "nothing";
      return info.isSymbolicLink() ? "symbolic link" : info.isFile() ? "file" : info.isDirectory() ? "directory" : "something else";
    };
    let from = node.dirname(node.realpathSync(node.fileURLToPath((import.meta as unknown as { readonly url: string }).url)));
    let root = from;
    // The convex whose pinned esbuild codegen resolved with, as Node's lookup finds it from here.
    const convexFound = convex === undefined ? undefined : installedPackage(node, from, "convex");
    const toolchain =
      convex === undefined
        ? undefined
        : { ...convex, from, found: convexFound, bytes: convexFound === undefined ? undefined : attempt(() => node.readFileSync(node.join(convexFound, "package.json"))).value };
    const located = steps.map((step) => {
      const looked = from;
      let installed: string | undefined;
      let manifestBytes: Uint8Array | undefined;
      if (step.package !== undefined) {
        const found = installedPackage(node, looked, step.package);
        if (found === undefined) return { ...step, from: looked };
        root = found;
        installed = attempt(
          () => (JSON.parse(node.readFileSync(node.join(found, "package.json"), "utf8")) as { readonly version?: string }).version,
        ).value;
        manifestBytes = attempt(() => node.readFileSync(node.join(found, "package.json"))).value;
      }
      const file = node.join(root, step.file);
      const read = attempt(() => node.readFileSync(file));
      if (read.value !== undefined) from = node.dirname(node.realpathSync(file));
      // Each path codegen found nothing at that holds something now, a dangling link included, as anything there can change what a deploy resolves.
      const appeared = (step.absent ?? []).filter((absent) => entryAt(node.join(root, absent)) !== "nothing");
      // Each file and directory codegen walked, with what it is now and its real path, as a link changes where a relative specifier from it resolves.
      const entries = (step.walked ?? []).map((entry) => {
        const at = node.join(root, entry.path);
        return { ...entry, at, found: entryAt(at), real: attempt(() => node.realpathSync(at)).value };
      });
      // Each file the definition's imports reach inside its package.
      const helpers = (step.helpers ?? []).map((helper) => {
        const helperRead = attempt(() => node.readFileSync(node.join(root, helper.file)));
        return { ...helper, bytes: helperRead.value, failure: helperRead.failure };
      });
      return { ...step, from: looked, found: root, installed, manifestBytes, appeared, entries, helpers, bytes: read.value, failure: read.failure };
    });
    return {
      convex: toolchain,
      steps: located,
      files: files.map((entry) => {
        const read = attempt(() => node.readFileSync(node.join(from, entry.file)));
        return { ...entry, bytes: read.value, failure: read.failure };
      }),
    };
  });`;

const generateTesting = Effect.fnUntraced(function* (
  app: App.Any,
  input: TestingInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const confectDirectory = yield* ConfectDirectory.get;
  const convexDirectory = yield* ConvexDirectory.get;
  const generated = path.join(confectDirectory, "_generated");
  const projectRoot = yield* ProjectRoot.get;
  const configDisplay = Array.join(
    pipe(
      path.relative(
        projectRoot,
        path.join(convexDirectory, ConvexConfig.CONVEX_CONFIG_FILENAME),
      ),
      String.split(path.sep),
    ),
    "/",
  );
  const relative = (file: string) => {
    const value = Array.join(
      pipe(path.relative(generated, file), String.split(path.sep)),
      "/",
    );
    return pipe(value, String.startsWith(".")) ? value : `./${value}`;
  };
  const imports = [
    'import schema from "./schema.js";',
    'import convexSchema from "./convexSchema.js";',
  ];
  // A component's loaders take the mount they load for, so each mount gets its
  // own copy of the component's modules.
  const moduleMap = Effect.fnUntraced(function* (
    directory: string,
    perMount: boolean,
  ) {
    const files = [
      ...(yield* FunctionModule.registeredModules(directory)),
    ].sort();
    return `{ "_generated/testing.ts": () => Promise.resolve({}),\n${pipe(
      files,
      Array.map((file) => {
        const source = relative(path.join(directory, file));
        // A runtime import names the source file itself, as nothing rewrites
        // its extension.
        const load = `() => import(${quote(pipe(source, String.replace(/\.([cm]?)[jt]s$/, ".$1js")))})`;
        return `${quote(Array.join(pipe(file, String.split(path.sep)), "/"))}: ${perMount ? `mountModule(mount, ${quote(source)}, ${load})` : load},`;
      }),
      Array.join("\n"),
    )}\n}`;
  });
  // Each module's text, keyed as its loader is, so the test kernel reads its
  // `"use node"` directive as Convex's bundler does. Read from disk, as a
  // bundle of this file would not carry Vite's `?raw` imports.
  const sourceMap = Effect.fnUntraced(function* (directory: string) {
    const files = [
      ...(yield* FunctionModule.registeredModules(directory)),
    ].sort();
    return `{ "_generated/testing.ts": () => Promise.resolve(""),\n${pipe(
      files,
      Array.map(
        (file) =>
          `${quote(Array.join(pipe(file, String.split(path.sep)), "/"))}: moduleSource(${quote(relative(path.join(directory, file)))}),`,
      ),
      Array.join("\n"),
    )}\n}`;
  });
  const declarations: Array<string> = [moduleSource];
  const identifiers = new Set([
    "schema",
    "convexSchema",
    "mountModule",
    "mountModules",
    "moduleSource",
    "PackageStep",
    "PackageFile",
    "PackageNode",
    "packageNode",
    "installedPackage",
    "packageRead",
  ]);
  const packagedSources: Array<string> = [];
  const posix = (file: string) =>
    Array.join(pipe(file, String.split(path.sep)), "/");
  const fromProject = (file: string) => posix(path.relative(projectRoot, file));
  // A packaged mount's modules, and those of each component its definition
  // mounts, read where Convex's bundler reads them: the directory of the
  // `convex.config` the mount imports. Each step records the package a bare
  // import names, found from the step before by Node's `node_modules` lookup
  // as the generated reader finds it, and the definition's file inside it, so
  // the reader reads these same files whatever conditions its process
  // resolves exports under.
  const real = (file: string) =>
    fs.realPath(file).pipe(Effect.orElseSucceed(() => file));
  // The package.json of the convex whose pinned esbuild resolves every
  // packaged definition, the one Node finds from the app's convex.config, as
  // ConvexConfig.convexEsbuild finds it; its digest goes with each mount's
  // reader, as a newer convex may resolve the same files to another tree.
  const convexManifestDigest = yield* Option.match(
    ConvexConfig.convexManifest(
      path.join(convexDirectory, ConvexConfig.CONVEX_CONFIG_FILENAME),
    ),
    {
      onNone: () => Effect.succeed(Option.none<string>()),
      onSome: (file) =>
        fs.readFile(file).pipe(
          Effect.map((read) =>
            Option.some(
              `sha256:${createHash("sha256").update(read).digest("hex")}`,
            ),
          ),
          Effect.orElseSucceed(() => Option.none<string>()),
        ),
    },
  );
  const installedPackage = Effect.fnUntraced(function* (
    from: string,
    name: string,
  ) {
    for (let directory = from; ; directory = path.dirname(directory)) {
      const candidate = path.join(directory, "node_modules", name);
      if (
        path.basename(directory) !== "node_modules" &&
        (yield* fs.exists(path.join(candidate, "package.json")))
      ) {
        const installed = yield* real(candidate);
        return Option.some(installed);
      }
      if (path.dirname(directory) === directory) return Option.none<string>();
    }
  });
  // What a path holds, as `lstat` reads it: a link, dangling or not, is a
  // link, never what it points at.
  const entryAt = (file: string) =>
    Effect.all({
      link: fs.readLink(file).pipe(Effect.option),
      info: fs.stat(file).pipe(Effect.option),
    }).pipe(
      Effect.map(({ link, info }): EntryKind =>
        Option.isSome(link)
          ? "symbolic link"
          : Option.match(info, {
              onNone: () => "nothing",
              onSome: ({ type }) =>
                type === "File"
                  ? "file"
                  : type === "Directory"
                    ? "directory"
                    : "something else",
            }),
      ),
    );
  // Every file codegen reads to classify or resolve one packaged mount, read
  // only through this recorder, which keeps each file's digest, so the
  // registry checks each one again and no read can skip its digest. Every
  // path it looks up and finds nothing at, as `lstat` reads it, is kept too,
  // so the registry checks that each one is still absent: anything that
  // appears there, a dangling link included, can change what a deploy
  // resolves.
  const readRecorder = () => {
    const digests = new Map<string, string>();
    const absent = new Set<string>();
    const lookup = (file: string) =>
      entryAt(file).pipe(
        Effect.tap((kind) =>
          Effect.sync(() => {
            if (kind === "nothing") absent.add(file);
          }),
        ),
      );
    const bytes = (file: string) =>
      fs.readFile(file).pipe(
        Effect.tap((read) =>
          Effect.sync(() => {
            digests.set(
              file,
              `sha256:${createHash("sha256").update(read).digest("hex")}`,
            );
          }),
        ),
      );
    const text = (file: string) =>
      bytes(file).pipe(Effect.map((read) => textDecoder.decode(read)));
    return { bytes, text, lookup, digests, absent };
  };
  type ReadRecorder = ReturnType<typeof readRecorder>;
  // The plain file a relative import in `directory` names: the specifier as
  // written, or with one of the extensions esbuild tries when its caller sets
  // none, as Convex's definition bundling does (`sharedEsbuildOptions`,
  // `bundle.ts:236-273` in convex 1.49). esbuild 0.27.0 tries the path as
  // written, then each extension (`loadAsFile`, `resolver.go:1816-1826`), in
  // `.tsx`, `.ts`, `.jsx`, `.js`, `.css`, `.json` order, or, for a path inside
  // `node_modules`, with JavaScript before TypeScript: `.jsx`, `.js`, `.tsx`,
  // `.ts`, `.css`, `.json` (`nodeModulesExtensionOrder`, `resolver.go:209`,
  // `257-281` and `1919-1928`). None for anything esbuild would resolve by
  // other rules: a directory, through its `index` or its own `package.json`, a
  // `.js` written for a `.ts`, or a file of a package whose `package.json` has
  // a `browser` field, which the deploy's browser platform reads. None too
  // unless exactly one candidate holds anything, as `lstat` reads it, and it
  // is a regular file inside `root`, reached through no link, so the order
  // decides nothing; each other candidate is recorded absent, as anything
  // there would make the import resolve elsewhere or fail.
  const relativeTarget = Effect.fnUntraced(function* (
    directory: string,
    specifier: string,
    root: string,
    reads: ReadRecorder,
  ) {
    const base = path.resolve(directory, specifier);
    const extensions = pipe(
      directory,
      String.split(path.sep),
      Array.contains("node_modules"),
    )
      ? [".jsx", ".js", ".tsx", ".ts", ".css", ".json"]
      : [".tsx", ".ts", ".jsx", ".js", ".css", ".json"];
    const found: Array<{ readonly file: string; readonly kind: EntryKind }> =
      [];
    for (const candidate of [
      base,
      ...Array.map(extensions, (extension) => base + extension),
    ]) {
      const kind = yield* reads.lookup(candidate);
      if (kind !== "nothing") found.push({ file: candidate, kind });
    }
    const [target] = found;
    if (found.length !== 1 || target === undefined || target.kind !== "file")
      return Option.none<string>();
    const only = target.file;
    const resolved = yield* fs
      .realPath(only)
      .pipe(Effect.orElseSucceed(() => ""));
    if (resolved !== only || !pipe(only, String.startsWith(root + path.sep)))
      return Option.none<string>();
    // A `browser` field, of any shape, in any manifest from the file up to
    // the package root may redirect the deploy's resolution.
    for (
      let at = path.dirname(only);
      pipe(at, String.startsWith(root));
      at = path.dirname(at)
    ) {
      const manifest = path.join(at, "package.json");
      const present = yield* reads.lookup(manifest);
      if (present !== "nothing") {
        const fields = yield* reads.text(manifest).pipe(
          Effect.map(Schema.decodeUnknownOption(ManifestFields)),
          Effect.orElseSucceed(() => Option.none()),
        );
        if (Option.isNone(fields) || "browser" in fields.value)
          return Option.none<string>();
      }
      if (at === root) break;
    }
    return Option.some(only);
  });
  // The files a definition's import graph reaches inside its package, read
  // with the parser the kernel reads `"use node"` with, never run. Each edge
  // is `convex`, another definition, a type-only import or a relative file
  // inside `root`, whose own edges follow the same rules. None for any other
  // edge: a bare package, a dynamic import or `require`, or a relative file
  // that leaves `root`, crosses a link or does not resolve to one file.
  const importGraph = Effect.fnUntraced(function* (
    definition: string,
    root: string,
    reads: ReadRecorder,
  ) {
    const seen = new Set([definition]);
    const helpers: Array<string> = [];
    const pending = [definition];
    for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
      const source = yield* reads.text(file).pipe(Effect.option);
      const edges = Option.flatMap(source, ConvexConfig.configImports);
      if (Option.isNone(edges)) return Option.none<ReadonlyArray<string>>();
      for (const entry of edges.value) {
        if (ConvexConfig.isSupportedConfigImport(entry)) continue;
        const relativeImport =
          pipe(entry.specifier, String.startsWith("./")) ||
          pipe(entry.specifier, String.startsWith("../"));
        if (entry.dynamic || !relativeImport)
          return Option.none<ReadonlyArray<string>>();
        const target = yield* relativeTarget(
          path.dirname(file),
          entry.specifier,
          root,
          reads,
        );
        if (Option.isNone(target)) return Option.none<ReadonlyArray<string>>();
        if (!seen.has(target.value)) {
          seen.add(target.value);
          helpers.push(target.value);
          pending.push(target.value);
        }
      }
    }
    return Option.some(Array.sort(helpers, Order.String));
  });
  // A mount whose layout the registry does not read, and each mount below it,
  // which the layer refuses until the test declares their runtimes.
  const unsupported = (
    name: string,
    packageName: string,
    reason: UnsupportedLayout,
    imported: ConvexConfig.ImportedDefinition,
  ): Effect.Effect<void> =>
    Effect.sync(() => {
      const record = (
        mount: string,
        owner: string,
        definition: ConvexConfig.ImportedDefinition,
        why: UnsupportedLayout,
      ): void => {
        packagedSources.push(
          `${quote(mount)}: { mount: ${quote(mount)}, package: ${quote(owner)}, reason: ${quote(why)} },`,
        );
        // Each mount below names the package its own import names.
        for (const child of definition.mounts)
          record(
            `${mount}/${child.name}`,
            packageOf(child.definition.import.specifier, owner),
            child.definition,
            "inside-unsupported",
          );
      };
      record(name, packageName, imported, reason);
    });
  const packaged = Effect.fnUntraced(function* (
    name: string,
    component: string,
    imported: ConvexConfig.ImportedDefinition,
    from: string,
    enclosing: string,
    steps: ReadonlyArray<string>,
  ): Effect.fn.Return<
    void,
    | CodegenError.ConvexBundlerUnavailableError
    | CodegenError.PackagedComponentUnreadableError
    | PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
  > {
    const unreadable = (reason: string) =>
      CodegenError.PackagedComponentUnreadableError.make({
        mount: name,
        component,
        reason,
      });
    const { specifier, deploy } = imported.import;
    if (deploy.kind === "bundlerUnavailable") {
      return yield* CodegenError.ConvexBundlerUnavailableError.make({
        mount: name,
        reason: deploy.reason,
      });
    }
    if (deploy.kind === "refused") return yield* unreadable(deploy.reason);
    const definition = yield* real(imported.import.path);
    const reads = readRecorder();
    const digestOf = (file: string) =>
      reads.bytes(file).pipe(
        Effect.mapBoth({
          onSuccess: () => reads.digests.get(file) ?? "",
          onFailure: (error) => unreadable(`${error.message}.`),
        }),
      );
    const definitionDigest = yield* digestOf(definition);
    // The supported layout: a bare import that the package's exports map
    // resolves, to a convex.config.js or convex.config.ts with no sibling of
    // the other extension. Anything else is recorded, with no sources, for
    // the test to declare a runtime for.
    const bare =
      !pipe(specifier, String.startsWith(".")) &&
      !pipe(specifier, String.startsWith("#")) &&
      !path.isAbsolute(specifier);
    if (!bare)
      return yield* unsupported(name, enclosing, "outside-exports", imported);
    const packageName = packageOf(specifier, enclosing);
    const found = yield* installedPackage(from, packageName);
    if (Option.isNone(found)) {
      return yield* unreadable(
        `Node's node_modules lookup finds no ${quote(packageName)} from ${quote(fromProject(from))}.`,
      );
    }
    const packageRoot = found.value;
    if (!pipe(definition, String.startsWith(packageRoot + path.sep))) {
      return yield* unreadable(
        `Node's node_modules lookup finds ${quote(packageName)} at ${quote(fromProject(packageRoot))}, but Convex bundles ${quote(fromProject(definition))}, outside it.`,
      );
    }
    const manifestFile = path.join(packageRoot, "package.json");
    const manifest = yield* reads.text(manifestFile).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(PackageManifest)),
      Effect.mapError((error) => unreadable(`${error.message}.`)),
    );
    // Node reads an `exports` of null as none.
    if (manifest.exports === undefined || manifest.exports === null)
      return yield* unsupported(name, packageName, "no-exports", imported);
    const base = path.basename(definition);
    if (base !== "convex.config.js" && base !== "convex.config.ts")
      return yield* unsupported(name, packageName, "config-file", imported);
    const sibling = path.join(
      path.dirname(definition),
      base === "convex.config.js" ? "convex.config.ts" : "convex.config.js",
    );
    const siblingFound = yield* reads.lookup(sibling);
    if (siblingFound !== "nothing")
      return yield* unsupported(name, packageName, "config-siblings", imported);
    // A definition that imports another package may mount what the deploy's
    // conditions pick there, which Node may not, so its import graph may reach
    // only `convex`, other definitions and its own package's files.
    const walked = yield* importGraph(definition, packageRoot, reads);
    if (Option.isNone(walked))
      return yield* unsupported(name, packageName, "config-imports", imported);
    // Every other file the classification read: the files the walk reached
    // and each manifest on the way up from them.
    const helperEntries = Array.map(
      Array.sort(
        Array.filter(
          [...reads.digests.keys()],
          (file) => file !== definition && file !== manifestFile,
        ),
        Order.String,
      ),
      (file) =>
        `{ file: ${quote(posix(path.relative(packageRoot, file)))}, digest: ${quote(reads.digests.get(file) ?? "")} }`,
    );
    // Its exports, imports and main fields decide what a deploy resolves,
    // so any change to it refuses the session, at the same version too.
    const manifestDigest = reads.digests.get(manifestFile) ?? "";
    const directory = path.dirname(definition);
    // Whether the component serves HTTP, which decides its route mount; an
    // `http` module that exists is digested with the others below.
    yield* reads.lookup(path.join(directory, "http.ts"));
    yield* reads.lookup(path.join(directory, "http.js"));
    // Every path a lookup found nothing at: each other candidate of each
    // relative import, each manifest the browser check looked for, the
    // definition's sibling of the other extension and an absent `http` module.
    const absentEntries = Array.map(
      Array.sort([...reads.absent], Order.String),
      (file) => quote(posix(path.relative(packageRoot, file))),
    );
    // Every file whose name the bundler registers, so the test kernel reads
    // each one's source and decides the rule's second half on it, whatever a
    // kit's glob loads.
    const files = [
      ...(yield* FunctionModule.candidateModules(directory).pipe(
        Effect.mapError((error) => unreadable(`${error.message}.`)),
      )),
    ].sort();
    const entries: Array<string> = [];
    for (const file of files) {
      const digest = yield* digestOf(path.join(directory, file));
      entries.push(`{ file: ${quote(posix(file))}, digest: ${quote(digest)} }`);
    }
    // Every file codegen read, and each directory between it and the package
    // root, each a regular file or directory whose real path is its own, so
    // the registry checks that none becomes a link or moves: bytes alone do
    // not show where a relative import from a file resolves.
    const walkedPaths = new Map<string, "file" | "directory">();
    for (const file of reads.digests.keys()) {
      walkedPaths.set(file, "file");
      for (
        let at = path.dirname(file);
        at !== packageRoot &&
        pipe(at, String.startsWith(packageRoot + path.sep));
        at = path.dirname(at)
      )
        walkedPaths.set(at, "directory");
    }
    const walkEntries: Array<string> = [];
    for (const [walkedPath, kind] of Array.sort(
      [...walkedPaths],
      Order.mapInput(Order.String, ([at]: readonly [string, unknown]) => at),
    )) {
      const held = yield* entryAt(walkedPath);
      const realWalked = yield* fs
        .realPath(walkedPath)
        .pipe(Effect.orElseSucceed(() => ""));
      if (held !== kind || realWalked !== walkedPath)
        return yield* unreadable(
          `Codegen reads ${quote(fromProject(walkedPath))} through a symbolic link, so the registry could not check that it stays where codegen read it.`,
        );
      walkEntries.push(
        `{ path: ${quote(posix(path.relative(packageRoot, walkedPath)))}, kind: ${quote(kind)} }`,
      );
    }
    const step = `{ package: ${quote(packageName)}, ${manifest.version === undefined ? "" : `version: ${quote(manifest.version)}, `}manifest: ${quote(manifestDigest)}, file: ${quote(posix(path.relative(packageRoot, definition)))}, digest: ${quote(definitionDigest)}${Array.isArrayNonEmpty(helperEntries) ? `, helpers: [${Array.join(helperEntries, ", ")}]` : ""}${Array.isArrayNonEmpty(absentEntries) ? `, absent: [${Array.join(absentEntries, ", ")}]` : ""}, walked: [${Array.join(walkEntries, ", ")}] }`;
    const chain = [...steps, step];
    if (!declarations.includes(packageRead)) declarations.push(packageRead);
    packagedSources.push(
      `${quote(name)}: packageRead([${Array.join(chain, ", ")}], [${Array.join(entries, ", ")}]${Option.match(convexManifestDigest, { onNone: () => "", onSome: (digest) => `, { manifest: ${quote(digest)} }` })}),`,
    );
    for (const child of imported.mounts) {
      yield* packaged(
        `${name}/${child.name}`,
        child.definition.import.specifier,
        child.definition,
        directory,
        packageName,
        chain,
      );
    }
  });
  const components: Array<string> = [];
  const httpMounts: Array<string> = [];
  const kits = new Map<string, string>();
  const visit = Effect.fnUntraced(function* (
    directory: string,
    prefix: string,
    kind: "app" | "component",
    parentHttpPrefix: string | undefined,
    declaring: App.Any | undefined,
  ): Effect.fn.Return<
    void,
    | PlatformError.PlatformError
    | BuildError
    | CodegenError.InvalidConvexConfigError
    | CodegenError.InvalidDeclarationError
    | CodegenError.MissingTestKitError
    | CodegenError.ConvexBundlerUnavailableError
    | CodegenError.PackagedComponentUnreadableError
    | CodegenError.TestKitSecretsMissingError
    | CodegenError.TestKitExportsUnknownError,
    FileSystem.FileSystem | Path.Path
  > {
    const config = path.join(directory, ConvexConfig.CONVEX_CONFIG_FILENAME);
    if (!(yield* fs.exists(config))) return;
    const installed = yield* ConvexConfig.discoverInstalledComponents(
      config,
      relative(config),
      kind,
    );
    for (const component of installed) {
      const name = prefix + component.name;
      // The mount as the backend that installs it declared it: the app, or a
      // local component's own `confect/app.ts`.
      const mount =
        declaring === undefined
          ? undefined
          : Option.getOrUndefined(
              Array.findFirst(
                App.mounts(declaring),
                (declared) => declared.name === component.name,
              ),
            );
      // A bare definition belongs to another package. Its directory is read
      // here but never written out; tests use the kit its descriptor names,
      // else its public test entry.
      const fromPackage = !path.isAbsolute(component.componentDefinitionPath);
      const named = fromPackage ? mount?.component.testing : undefined;
      if (named !== undefined) {
        yield* checkTestKit(name, named, config, configDisplay);
      }
      const kitEntries =
        named !== undefined
          ? [named]
          : fromPackage
            ? [
                `${component.componentDefinitionPath}/testing`,
                `${component.componentDefinitionPath}/test`,
              ]
            : [];
      const kitEntry = Option.getOrUndefined(
        Array.findFirst(kitEntries, (entry) =>
          Option.isSome(Bundler.resolveModule(entry, config)),
        ),
      );
      const resolved = fromPackage
        ? yield* ConvexConfig.resolveDefinition(
            `${component.componentDefinitionPath}/convex.config`,
            config,
            path,
          ).pipe(
            Effect.fromOption,
            Effect.mapBoth({
              onFailure: () =>
                CodegenError.InvalidConvexConfigError.make({
                  configPath: relative(config),
                  reason: `Cannot resolve component ${component.componentDefinitionPath} for testing.`,
                }),
              onSuccess: (definition) => path.dirname(definition),
            }),
          )
        : component.componentDefinitionPath;
      const localPrefix =
        prefix === "" ? mount?.httpPrefix : component.httpPrefix;
      const httpPrefix =
        parentHttpPrefix === undefined || localPrefix === undefined
          ? undefined
          : pipe(
              `${pipe(parentHttpPrefix, String.replace(/\/+$/, ""))}${localPrefix}`,
              String.replace(/\/+$/, ""),
              (joined) => (joined === "" ? "/" : joined),
            );
      // A packaged mount serves HTTP when the directory Convex deploys holds an
      // http module, the directory whose two http paths its reader records.
      const deployedDefinition =
        fromPackage && Option.isSome(component.imported)
          ? yield* real(component.imported.value.import.path)
          : undefined;
      const httpDirectory =
        deployedDefinition === undefined
          ? resolved
          : path.dirname(deployedDefinition);
      if (
        httpPrefix !== undefined &&
        ((yield* fs.exists(path.join(httpDirectory, "http.ts"))) ||
          (yield* fs.exists(path.join(httpDirectory, "http.js"))))
      ) {
        httpMounts.push(
          `{ componentPath: ${quote(name)}, httpPrefix: ${quote(httpPrefix)} }`,
        );
      }
      const kitKey = kitEntry ?? resolved;
      let identifier = kits.get(kitKey);
      if (identifier === undefined) {
        const cleaned = pipe(name, String.replaceAll(/[^A-Za-z0-9_$]/g, "_"));
        const base = /^[A-Za-z_$]/.test(cleaned) ? cleaned : `_${cleaned}`;
        identifier = `${base}Kit`;
        let schemaIdentifier = `${base}Schema`;
        for (
          let n = 2;
          identifiers.has(identifier) || identifiers.has(schemaIdentifier);
          n++
        ) {
          identifier = `${base}Kit${n}`;
          schemaIdentifier = `${base}Schema${n}`;
        }
        identifiers.add(identifier);
        identifiers.add(schemaIdentifier);
        kits.set(kitKey, identifier);
        if (!fromPackage) {
          imports.push(
            `import ${schemaIdentifier} from ${quote(relative(path.join(resolved, "schema.js")))};`,
          );
          if (!declarations.includes(mountModule))
            declarations.push(mountModule);
          declarations.push(
            `const ${identifier} = (mount: string) => ({ schema: ${schemaIdentifier}, modules: ${yield* moduleMap(resolved, true)}, sources: ${yield* sourceMap(resolved)} });`,
          );
        } else {
          if (kitEntry === undefined) {
            return yield* CodegenError.MissingTestKitError.make({
              configPath: relative(config),
              mount: name,
              component: component.componentDefinitionPath,
              entries: kitEntries,
            });
          }
          imports.push(`import * as ${identifier} from ${quote(kitEntry)};`);
        }
      }
      components.push(
        `${quote(name)}: ${fromPackage ? identifier : `${identifier}(${quote(name)})`},`,
      );
      // A packaged Confect component keeps its secret fields, so its kit
      // must hand the kernel its secret policy as it registers.
      if (
        fromPackage &&
        kitEntry !== undefined &&
        mount?.component.contract !== undefined
      ) {
        const kitFile = Bundler.resolveModule(kitEntry, config);
        const exported = Option.isNone(kitFile)
          ? Option.none()
          : yield* Bundler.exportNames(kitFile.value).pipe(
              Effect.mapError((error) => fromBundlerError(kitEntry, error)),
            );
        // A kit whose exports cannot be listed without running it might not
        // pass a policy, so it fails as a missing one would.
        if (Option.isNone(exported))
          return yield* CodegenError.TestKitExportsUnknownError.make({
            mount: name,
            kit: kitEntry,
          });
        if (!exported.value.includes("secrets"))
          return yield* CodegenError.TestKitSecretsMissingError.make({
            mount: name,
            kit: kitEntry,
          });
      }
      if (fromPackage) {
        if (Option.isNone(component.imported)) {
          return yield* CodegenError.PackagedComponentUnreadableError.make({
            mount: name,
            component: component.componentDefinitionPath,
            reason: `codegen cannot list the components its definition mounts from ${relative(config)}.`,
          });
        }
        const here = yield* real(generated);
        yield* packaged(
          name,
          component.componentDefinitionPath,
          component.imported.value,
          here,
          component.componentDefinitionPath,
          [],
        );
      }
      // A local mount's tree and modules are the deploy's only when its
      // definition is the one Convex deploys.
      const mountDeploy = Option.map(
        component.imported,
        ({ import: imported }) => imported.deploy,
      );
      if (!fromPackage && Option.isSome(mountDeploy)) {
        if (mountDeploy.value.kind === "bundlerUnavailable")
          return yield* CodegenError.ConvexBundlerUnavailableError.make({
            mount: name,
            reason: mountDeploy.value.reason,
          });
        if (mountDeploy.value.kind === "refused")
          return yield* CodegenError.InvalidConvexConfigError.make({
            configPath: relative(config),
            reason: `the mount "${name}" is not the one Convex deploys: ${mountDeploy.value.reason}`,
          });
      }
      // A push runs a parent's `init` before the components it mounts.
      const local = path.join(path.dirname(resolved), "confect");
      mounts.push({
        path: name,
        kit: fromPackage ? kitKey : "local",
        ...mountSettings(mount),
      });
      if (!fromPackage) {
        sources.push({ path: name, identifier, confect: local });
        // A component's own declaration names its mounts' kits, which the
        // registry needs, and their bindings, which the subject needs.
        const nested = yield* bundledDefault(path.join(local, "app.ts"));
        yield* visit(
          resolved,
          `${name}/`,
          "component",
          httpPrefix,
          App.isApp(nested) ? nested : undefined,
        );
      }
    }
  });
  // A component's subject is row 9's component profile, with no groups. An
  // app without @confect/test keeps the registry alone, so it still compiles.
  const subjected =
    (yield* ConvexDirectory.target).kind === "app" &&
    Bundler.canImport("@confect/test", path.join(generated, "testing.ts"));
  const mounts: Array<TestingManifest.MountEntry> = [];
  const sources: Array<SecretSource> = [];
  yield* visit(
    convexDirectory,
    "",
    (yield* ConvexDirectory.target).kind,
    "",
    app,
  );
  const secrets = yield* secretsOf(input.leaves, sources, relative);
  imports.push(...secrets.imports);
  const subject = subjected
    ? yield* testBackend(app, input, mounts)
    : { imports: [], declaration: "" };
  imports.push(
    ...Array.filter(subject.imports, (line) => !imports.includes(line)),
  );
  const modules = yield* moduleMap(convexDirectory, false);
  const policy =
    secrets.policy === undefined ? "" : `, secrets: ${secrets.policy}`;
  const moduleSources = yield* sourceMap(convexDirectory);
  // An explicit undefined tells `TestConfect.layer`'s types that no packaged
  // mount can change under the session.
  const packagedField =
    packagedSources.length === 0
      ? ", packagedSources: undefined"
      : `, packagedSources: {${Array.join(packagedSources, "\n")}}`;
  const registry = `{ httpMounts: [${Array.join(httpMounts, ",")}], schema, convexSchema, modules: ${modules}, sources: ${moduleSources}, components: {${Array.join(components, "\n")}}${packagedField}${policy} }`;
  yield* writeFileStringAndLog(
    path.join(generated, "testing.ts"),
    Array.join(
      [
        "// Generated by `confect codegen`. Test-only; do not import in backend functions.",
        ...imports,
        ...declarations,
        ...(subject.declaration === ""
          ? [`export default ${registry};`]
          : [
              `const backend = ${registry};`,
              "export default backend;",
              subject.declaration,
              "",
            ]),
      ],
      "\n",
    ),
  );
});

/**
 * Write the `TestBackend` export from the specs, the manifest and every
 * declared section's `testing` facts. A fact naming something the backend lacks
 * stops codegen before `testing.ts` is written.
 */
const testBackend = Effect.fnUntraced(function* (
  app: App.Any,
  input: TestingInput,
  mounts: ReadonlyArray<TestingManifest.MountEntry>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const confectDirectory = yield* ConfectDirectory.get;
  const groups = TestingManifest.groupsOf(input.leaves);
  const registry = yield* Effect.fromResult(
    ManifestSections.collect(input.sections, input.leaves),
  );
  const facts = yield* Effect.fromResult(
    TestingManifest.collectFacts(registry, input.modules, groups),
  );
  const schema = yield* bundledDefault(
    path.join(confectDirectory, GENERATED_DIRNAME, "schema.ts"),
  );
  const realm = yield* fs.exists(path.join(confectDirectory, "auth.ts"));
  const planned = yield* Effect.fromResult(
    TestingManifest.plan({
      groups,
      facts,
      tables: tableInfo(schema),
      mounts: Array.map(mounts, ({ path: mountPath }) => mountPath),
      realm,
    }),
  );
  const manifest = yield* readPrevious;
  const digest = Predicate.isString(manifest["digest"])
    ? manifest["digest"]
    : "";
  const imports = [
    'import { TestBackend as $TestBackend } from "@confect/test";',
    'import refs from "./refs.js";',
  ];
  const ports: Array<string> = [];
  for (const [index, port] of planned.ports.entries()) {
    const [file, exportName = ""] = pipe(port.input, String.split("#"));
    if (!(yield* fs.exists(path.join(confectDirectory, file))))
      return yield* CodegenError.InvalidDeclarationError.make({
        declarationPath: `confect/${file}`,
        reason: `the port ${quote(port.name)} takes its input codec from this file, which does not exist.`,
      });
    const specifier = `../${pipe(file, String.replace(/\.ts$/, ".js"))}`;
    imports.push(`import * as $port${index} from ${quote(specifier)};`);
    ports.push(
      `${quote(port.name)}: $TestBackend.port({ name: ${quote(port.name)}, input: $port${index}[${quote(exportName)}], outcomes: ${stringify(port.outcomes)} }),`,
    );
  }
  const groupLines = Array.map(
    planned.groups,
    ({ path: groupPath, segments, owner, functions, open }) => {
      const refs = pipe(
        functions,
        Array.map(
          (name) =>
            `${quote(name)}: refs.public${access(segments)}${access([name])}`,
        ),
        Array.join(", "),
      );
      return `    ${quote(groupPath)}: $TestBackend.group({ path: ${quote(groupPath)}, owner: ${quote(owner)}, functions: { ${refs} }, open: ${stringify(open)} }),`;
    },
  );
  const portLines = Array.map(ports, (line) => `\n    ${line}`);
  const owner = Env.name(App.env(app));
  const settings = Array.map(
    Env.descriptors(App.env(app)),
    ([name, descriptor]) => ({ name, owner, optional: descriptor.optional }),
  );
  return {
    imports,
    declaration: Array.join(
      [
        "export const TestBackend = $TestBackend.make(backend, {",
        "  refs,",
        `  groups: {\n${Array.join(groupLines, "\n")}\n  },`,
        `  ports: {${Array.join(portLines, "")}${ports.length === 0 ? "" : "\n  "}},`,
        `  laws: ${stringify(planned.laws)},`,
        `  obligations: ${stringify(planned.obligations)},`,
        `  manifestDigest: ${quote(digest)},`,
        `  mounts: ${stringify(mounts)},`,
        `  settings: ${stringify(settings)},`,
        "});",
      ],
      "\n",
    ),
  };
});

/**
 * What a mount binds its component's settings to, and which of them the
 * component requires: a literal stays a value, an entry of the mounting
 * backend's env forwards that backend's setting.
 */
const mountSettings = (
  mount: Mount.Data | undefined,
): Pick<TestingManifest.MountEntry, "env" | "required"> => {
  const env: Record<string, TestingManifest.Binding> = {};
  const bound = Array.sort(
    Record.toEntries(mount?.env ?? {}),
    Order.mapInput(Order.String, ([slot]: readonly [string, unknown]) => slot),
  );
  for (const [slot, value] of bound) {
    if (Predicate.isString(value)) env[slot] = { value };
    else if (value !== undefined && Env.isEntry(value))
      env[slot] = { from: Env.origin(value).key };
  }
  // A slot the mount does not bind is open: an app's own mount binds none in
  // format 1, and a session leaves an open slot unset.
  for (const slot of Record.keys(mount?.component.env ?? {}))
    if (env[slot] === undefined) env[slot] = { open: true };
  const required = pipe(
    Record.toEntries(mount?.component.env ?? {}),
    Array.filter(([, schema]) => !SchemaAST.isOptional(schema.ast)),
    Array.map(([slot]) => slot),
    Array.sort(Order.String),
  );
  return {
    env: Record.fromEntries(
      Array.sort(
        Record.toEntries(env),
        Order.mapInput(
          Order.String,
          ([slot]: readonly [string, unknown]) => slot,
        ),
      ),
    ),
    required,
  };
};

/**
 * A property path in generated code, such as `.tasks.tasks`.
 */
const access = (segments: ReadonlyArray<string>) =>
  pipe(
    segments,
    Array.map((segment) =>
      /^[A-Za-z_$][\w$]*$/.test(segment)
        ? `.${segment}`
        : `[${quote(segment)}]`,
    ),
    Array.join(""),
  );

/**
 * A local mount whose own `confect/` holds its generated schema and refs, and
 * the identifier codegen gave its kit, which is unique among the mounts.
 */
interface SecretSource {
  readonly path: string;
  readonly identifier: string;
  readonly confect: string;
}

/**
 * A Confect database schema's tables, or none for any other value.
 */
const tablesOfSchema = (schema: unknown) =>
  DatabaseSchema.isDatabaseSchema(schema)
    ? Record.values(
        DatabaseSchema.tables(schema as DatabaseSchema.AnyWithProps),
      )
    : [];

/**
 * Each app table with its stored fields and its declared indexes.
 */
const tableInfo = (schema: unknown): Array<TestingManifest.TableInfo> =>
  Array.map(tablesOfSchema(schema), (table) => ({
    name: table.tableName,
    fields:
      table.Fields.ast._tag === "Objects"
        ? Array.filter(
            Array.map(table.Fields.ast.propertySignatures, ({ name }) => name),
            Predicate.isString,
          )
        : [],
    indexes: Record.keys(table.indexes),
  }));

/**
 * A module's default export, bundled as codegen bundles a declaration, so a
 * `convex.config` it reaches at any depth loads outside the Convex runtime.
 */
/**
 * The version a component package's manifest declares, which the generated
 * reader checks is still the one installed.
 */
/**
 * Why a packaged mount's layout is not the one the test registry reads: its
 * import does not go through a package's exports map, the package has none, the
 * definition is not a `convex.config.js` or `convex.config.ts`, a sibling of
 * the other extension sits beside it, it imports anything but `convex` and
 * other definitions, or it sits below such a mount.
 */
type UnsupportedLayout =
  | "outside-exports"
  | "no-exports"
  | "config-file"
  | "config-siblings"
  | "config-imports"
  | "inside-unsupported";

/**
 * The package a component definition import names, for a bare specifier, or
 * `enclosing`, the package it sits in, for a relative, `#` or absolute one.
 */
const packageOf = (specifier: string, enclosing: string): string => {
  if (
    pipe(specifier, String.startsWith(".")) ||
    pipe(specifier, String.startsWith("#")) ||
    pipe(specifier, String.startsWith("/"))
  )
    return enclosing;
  const segments = pipe(specifier, String.split("/"));
  return pipe(segments[0] ?? "", String.startsWith("@"))
    ? `${segments[0]}/${segments[1] ?? ""}`
    : (segments[0] ?? "");
};

/**
 * A manifest's fields, any of them, to tell whether it has a `browser` field.
 */
const ManifestFields = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Unknown),
);

const textDecoder = new TextDecoder();

const PackageManifest = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.optionalKey(Schema.String),
    exports: Schema.optionalKey(Schema.Unknown),
  }),
);

const bundledDefault = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(file))) return undefined;
  const { module } = yield* Bundler.bundle(file, {
    plugins: [ConvexConfig.componentConfigPlugin(path)],
  }).pipe(Effect.mapError((error) => fromBundlerError(file, error)));
  return module.default as unknown;
});

/**
 * A thunk of each Confect function codec of `functions` that holds a secret.
 */
const functionSecrets = (
  functions: ReadonlyArray<TestingManifest.ConfectFunction>,
  refs: string,
) =>
  pipe(
    functions,
    Array.filterMap((fn) => {
      const ref = `${refs}.${fn.visibility}${access([...fn.segments, fn.name])}`;
      const codecs = [
        ...(SecretSchema.hasSecret(fn.args.ast)
          ? [`args: () => ${ref}.args`]
          : []),
        ...(SecretSchema.hasSecret(fn.returns.ast)
          ? [`returns: () => ${ref}.returns`]
          : []),
      ];
      const key = quote(`${Array.join(fn.segments, "/")}:${fn.name}`);
      return codecs.length === 0
        ? Result.failVoid
        : Result.succeed(`${key}: { ${Array.join(codecs, ", ")} }`);
    }),
    Array.sort(Order.String),
  );

/**
 * The secret policy `TestConfect.layer` feeds the kernel's redaction: a thunk
 * of each Confect codec that holds a `Schema.Redacted` node, among the app's
 * functions and each local mount's tables and functions. The layer reads the
 * app's own tables from its schema. A packaged component's kit hands the kernel
 * its own policy as it registers.
 */
const secretsOf = Effect.fnUntraced(function* (
  leaves: ReadonlyArray<LoadedLeafModule>,
  sources: ReadonlyArray<SecretSource>,
  relative: (file: string) => string,
) {
  const path = yield* Path.Path;
  const imports: Array<string> = [];
  const tables: Array<string> = [];
  const functions: Array<string> = [];
  const own = functionSecrets(
    Array.flatMap(leaves, (leaf) =>
      TestingManifest.confectFunctions(
        { [Array.lastNonEmpty(leaf.pathSegments)]: leaf.spec },
        Array.initNonEmpty(leaf.pathSegments),
      ),
    ),
    "refs",
  );
  if (own.length > 0) {
    imports.push('import refs from "./refs.js";');
    functions.push(`"": { ${Array.join(own, ", ")} }`);
  }
  for (const source of sources) {
    const generated = path.join(source.confect, GENERATED_DIRNAME);
    const schema = yield* bundledDefault(path.join(generated, "schema.ts"));
    const secretTables = pipe(
      tablesOfSchema(schema),
      Array.filter((table) => SecretSchema.hasSecret(table.Fields.ast)),
      Array.map((table) => table.tableName),
      Array.sort(Order.String),
    );
    if (secretTables.length > 0) {
      const local = `${source.identifier}ConfectSchema`;
      const thunks = pipe(
        secretTables,
        Array.map(
          (table) =>
            `${quote(table)}: () => $DatabaseSchema.tables(${local})${access([table])}.Fields`,
        ),
        Array.join(", "),
      );
      imports.push(
        `import ${local} from ${quote(relative(path.join(generated, "schema.js")))};`,
      );
      tables.push(`${quote(source.path)}: { ${thunks} }`);
    }
    const spec = yield* bundledDefault(path.join(generated, "spec.ts"));
    const local = `${source.identifier}Refs`;
    const entries = Spec.isSpec(spec)
      ? functionSecrets(
          TestingManifest.confectFunctions(Spec.groups(spec)),
          local,
        )
      : [];
    if (entries.length > 0) {
      imports.push(
        `import ${local} from ${quote(relative(path.join(generated, "refs.js")))};`,
      );
      functions.push(`${quote(source.path)}: { ${Array.join(entries, ", ")} }`);
    }
  }
  if (tables.length > 0)
    imports.unshift(
      'import { DatabaseSchema as $DatabaseSchema } from "@confect/server";',
    );
  const parts = [
    ...(tables.length === 0 ? [] : [`tables: { ${Array.join(tables, ", ")} }`]),
    ...(functions.length === 0
      ? []
      : [`functions: { ${Array.join(functions, ", ")} }`]),
  ];
  return {
    imports: Array.dedupe(imports),
    policy: parts.length === 0 ? undefined : `{ ${Array.join(parts, ", ")} }`,
  };
});

interface TestingInput {
  readonly leaves: ReadonlyArray<LoadedLeafModule>;
  readonly sections: ReadonlyArray<ManifestSection.Entry>;
  readonly modules: ReadonlyMap<
    string,
    ManifestSection.GenerateInput["modules"]
  >;
}
