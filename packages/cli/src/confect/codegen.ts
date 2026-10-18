import { App, Callback, Env, type GroupSpec, Spec } from "@confect/core";
import * as Command from "effect/cli/Command";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type * as PlatformError from "effect/PlatformError";
import type { BuildError } from "../BuildError";
import { pipe } from "effect/Function";
import * as HashSet from "effect/HashSet";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import type * as Scope from "effect/Scope";
import * as Bundler from "../Bundler";
import { fromBundlerError } from "../BuildError";
import * as CodegenError from "../CodegenError";
import { LegacySchemaFileError } from "../CodegenError";
import { ConfectDirectory } from "../ConfectDirectory";
import * as ConvexConfig from "../ConvexConfig";
import { ConvexDirectory } from "../ConvexDirectory";
import * as DirectoryOptions from "../DirectoryOptions";
import * as DocName from "../DocName";
import * as FunctionPaths from "../FunctionPaths";
import * as FunctionModule from "../FunctionModule";
import * as GenerationSnapshot from "../GenerationSnapshot";
import * as EntryPoint from "../EntryPoint";
import type { ImplModulePath } from "../ImplModulePath";
import {
  implPathForSpec,
  loadAll,
  registeredFunctionsRelativePath,
  validateAllImpls,
  withImplFiles,
  type LeafModule,
  type LoadedLeafModule,
} from "../LeafModule";
import {
  logFileAdded,
  logFileModified,
  logFileRemoved,
  logPending,
  logSuccess,
  logWarn,
} from "../log";
import { ProjectRoot } from "../ProjectRoot";
import { preserveComponentOutput } from "../Rollback";
import { assemblyNodesFromLeaves } from "../SpecAssemblyNode";
import * as TableModule from "../TableModule";
import * as templates from "../templates";
import {
  generateAuthConfig,
  generateCrons,
  generateHttp,
  removePathIfExists,
  toModuleImportPath,
  touchConvexSchema,
  writeFileStringAndLog,
} from "../utils";
import { syncDeclaration, syncDeclaredHttp } from "./declaration";

const GENERATED_DIRNAME = "_generated";

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
  yield* generateConfectGeneratedDirectory;
  // A declared backend's `convex.config.ts` and manifest come first: the
  // components registry below reads the config, and nothing may validate
  // against a manifest the current declaration did not produce.
  const declared = yield* syncDeclaration;
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
  // Tables and specs can use bound component IDs and schemas, so their
  // imports need the registry even on a project's first codegen run.
  yield* generateComponents;
  yield* validateCallbackPrefixes(declared);
  // Now that `_generated/id.ts` is on disk, bundle each table module and
  // check its default export is an `UnnamedTable`. Surface diagnostics
  // here (rather than later) so they appear before impl-validation noise.
  yield* TableModule.validate(tableModules);
  yield* validateNoDocNameCollisions(tableModules);
  yield* generateTableWrappers(tableModules);
  yield* removeObsoleteTableWrappers(tableModules);
  yield* generateRuntimeSchema(tableModules);
  const leaves = yield* loadAll;
  yield* rejectComponentNodeGroups(leaves);
  yield* removeLegacyFiles;
  const snapshot = yield* Effect.fromResult(
    GenerationSnapshot.fromLoadedLeaves(leaves),
  );
  yield* generateAssembledSpecs(leaves);
  // `_generated/api.ts`/`nodeApi.ts` are no longer imported by generated or
  // impl code (impls take the database schema from `_generated/schema`
  // directly), so remove any copies left over from earlier versions before
  // impl validation runs.
  yield* Effect.all(
    [
      removeGeneratedApi,
      generateRefs,
      generateComponentContract(tableModules),
      removeGeneratedNodeApi,
      generateDocs(tableModules),
      generateServices,
      generateConvexSchema(tableModules),
    ],
    { concurrency: "unbounded" },
  );
  yield* validateAllImpls(leaves);
  yield* generateGroupRegisteredFunctions(leaves);
  yield* removeObsoleteRegisteredFunctions(leaves);
  const [functionPaths] = yield* Effect.all(
    [
      FunctionModule.generateFunctions(snapshot),
      generateConvexSchemaReexport,
      logGenerated(
        Option.match(declared, {
          onNone: () => generateHttp,
          onSome: syncDeclaredHttp,
        }),
      ),
      logGenerated(generateCrons),
      Option.isNone(declared)
        ? logGenerated(generateAuthConfig)
        : Effect.succeedNone,
    ],
    { concurrency: "unbounded" },
  );
  if (Option.isSome(declared)) yield* generateTesting(declared.value);
  return {
    functionPaths,
    snapshot,
  };
});

export const generateWithSnapshot = runCodegen.pipe(
  Effect.withSpan("Cli.codegen"),
);

export const makeCodegenHandler = (
  duringRestore?: Effect.Effect<void, never, Scope.Scope>,
) =>
  preserveComponentOutput(generateWithSnapshot, duringRestore).pipe(
    Effect.tap(() => touchConvexSchema),
    Effect.map(({ functionPaths }) => ({ functionPaths })),
  );

export const codegenHandler = makeCodegenHandler();

export const updateDeclarations = Effect.fn("Cli.updateDeclarations")(
  function* (
    snapshot: GenerationSnapshot.GenerationSnapshot,
    declarations: Array.NonEmptyReadonlyArray<EntryPoint.Declaration>,
    affectedImpls: ReadonlyArray<ImplModulePath>,
  ) {
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
        const next = yield* Effect.fromResult(
          GenerationSnapshot.update(snapshot, leaves),
        );
        yield* validateAllImpls(leaves);
        yield* generateGroupRegisteredFunctions(leaves);
        yield* FunctionModule.applyFunctionPlan(
          GenerationSnapshot.diff(snapshot, next),
        );
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
        new CodegenError.ComponentNodeGroupError({ specPath, groupPath }),
      );
    }
    for (const [name, child] of Object.entries(group.groups)) {
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
  const callbacksPath = path.join(yield* ConfectDirectory.get, "callbacks.ts");
  if (!(yield* fs.exists(callbacksPath))) return;
  const name = Option.isSome(declared)
    ? Env.name(App.env(declared.value))
    : yield* ConvexConfig.componentName(
        path.join(
          yield* ConvexDirectory.get,
          ConvexConfig.CONVEX_CONFIG_FILENAME,
        ),
      );
  const { module } = yield* Bundler.bundle(callbacksPath).pipe(
    Effect.mapError((error) => fromBundlerError("confect/callbacks.ts", error)),
  );
  for (const contract of Object.values(module)) {
    if (Callback.isContract(contract) && !contract.id.startsWith(`${name}/`)) {
      return yield* new CodegenError.CallbackPrefixError({
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
          return yield* new CodegenError.InvalidConvexConfigError({
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
) {
  const path = yield* Path.Path;
  const confectDirectory = yield* ConfectDirectory.get;

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
      const fs = yield* FileSystem.FileSystem;
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
        schemaImportPath,
        specImportPath,
        implImportPath,
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

  const expected = new Set(
    yield* Effect.forEach(leaves, (leaf) =>
      registeredFunctionsRelativePath(leaf),
    ),
  );

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
    return yield* new LegacySchemaFileError({ schemaPath: "schema.ts" });
  }
});

/**
 * Surface a yellow `⚠` warning when codegen sees no tables—either the
 * `confect/tables/` directory is missing or it contains no `.ts` files.
 * Generation still succeeds (emitting an empty `DatabaseSchema` and
 * `defineSchema({})`), since action-only/table-free Confect backends are
 * legal—but the warning catches the much more common case of a typoed directory
 * or files placed under the wrong root.
 */
const warnIfNoTables = (
  tableModules: ReadonlyArray<TableModule.TableModule>,
) =>
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
  const contents = yield* Match.value(yield* ConvexDirectory.target).pipe(
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
    return yield* new CodegenError.ConflictingDocNameError({ collisions });
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

/**
 * Generate `confect/_generated/components.ts`—the typed registry of Convex
 * components installed in `convex/convex.config.ts` (see
 * {@link templates.components}). The file is emitted even when there is no
 * `convex.config.ts` (as an empty registry) so the import surface stays stable.
 * It must exist before loading tables and specs because they may import bound
 * component IDs and schemas.
 */
export const generateComponents = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const confectDirectory = yield* ConfectDirectory.get;
  const convexDirectory = yield* ConvexDirectory.get;
  const projectRoot = yield* ProjectRoot.get;

  const confectGeneratedDirectory = path.join(
    confectDirectory,
    GENERATED_DIRNAME,
  );
  const generatedComponentsPath = yield* GENERATED_COMPONENTS_PATH;
  const componentsPath = path.join(confectDirectory, generatedComponentsPath);

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

  const contents = yield* templates.components({
    components: Array.map(
      installedComponents,
      ({ name, componentDefinitionPath }) => ({
        name,
        typeImportPath: ConvexConfig.typeImportPath(
          path,
          componentDefinitionPath,
          confectGeneratedDirectory,
        ),
      }),
    ),
  });

  yield* writeFileStringAndLog(componentsPath, contents);
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
 * Test-only imports never enter the runtime schema or function wrappers.
 */
const quote = (value: string) => JSON.stringify(value);

const generateTesting = Effect.fnUntraced(function* (app: App.Any) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const confectDirectory = yield* ConfectDirectory.get;
  const convexDirectory = yield* ConvexDirectory.get;
  const generated = path.join(confectDirectory, "_generated");
  const relative = (file: string) => {
    const value = path.relative(generated, file).split(path.sep).join("/");
    return value.startsWith(".") ? value : `./${value}`;
  };
  const imports = [
    'import schema from "./schema";',
    'import convexSchema from "./convexSchema";',
  ];
  const moduleMap = Effect.fnUntraced(function* (directory: string) {
    const files = (yield* fs.readDirectory(directory, { recursive: true }))
      .filter(
        (file) =>
          /\.[cm]?[jt]s$/.test(file) &&
          !file.endsWith(".d.ts") &&
          !file.split(path.sep).includes("_generated") &&
          !file.includes(".config."),
      )
      .sort();
    return `{ "_generated/testing.ts": () => Promise.resolve({}),\n${files
      .map((file) => {
        const specifier = relative(path.join(directory, file));
        return `${quote(file.split(path.sep).join("/"))}: () => import(${quote(specifier.replace(/\.[cm]?[jt]s$/, ""))}),`;
      })
      .join("\n")}\n}`;
  });
  const components: Array<string> = [];
  const httpMounts: Array<string> = [];
  const kits = new Map<string, string>();
  const visit = Effect.fnUntraced(function* (
    directory: string,
    prefix: string,
    kind: "app" | "component",
    parentHttpPrefix: string | undefined,
  ): Effect.fn.Return<
    void,
    | PlatformError.PlatformError
    | BuildError
    | CodegenError.InvalidConvexConfigError,
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
      const resolved = path.isAbsolute(component.componentDefinitionPath)
        ? component.componentDefinitionPath
        : path.dirname(
            yield* ConvexConfig.resolveDefinition(
              `${component.componentDefinitionPath}/convex.config`,
              config,
              path,
            ).pipe(
              Effect.fromOption,
              Effect.mapError(
                () =>
                  new CodegenError.InvalidConvexConfigError({
                    configPath: relative(config),
                    reason: `Cannot resolve component ${component.componentDefinitionPath} for testing.`,
                  }),
              ),
            ),
          );
      const localPrefix =
        prefix === ""
          ? App.mounts(app).find((mount) => mount.name === component.name)
              ?.httpPrefix
          : component.httpPrefix;
      const httpPrefix =
        parentHttpPrefix === undefined || localPrefix === undefined
          ? undefined
          : `${parentHttpPrefix.replace(/\/+$/, "")}${localPrefix}`.replace(
              /\/+$/,
              "",
            ) || "/";
      if (
        httpPrefix !== undefined &&
        ((yield* fs.exists(path.join(resolved, "http.ts"))) ||
          (yield* fs.exists(path.join(resolved, "http.js"))))
      ) {
        httpMounts.push(
          `{ componentPath: ${quote(name)}, httpPrefix: ${quote(httpPrefix)} }`,
        );
      }
      let identifier = kits.get(resolved);
      if (identifier === undefined) {
        identifier = `component${kits.size}`;
        kits.set(resolved, identifier);
        imports.push(
          `import ${identifier}Schema from ${quote(relative(path.join(resolved, "schema")))};`,
        );
        imports.push(
          `const ${identifier} = { schema: ${identifier}Schema, modules: ${yield* moduleMap(resolved)} };`,
        );
      }
      components.push(`${quote(name)}: ${identifier},`);
      yield* visit(resolved, `${name}/`, "component", httpPrefix);
    }
  });
  yield* visit(convexDirectory, "", (yield* ConvexDirectory.target).kind, "");
  yield* writeFileStringAndLog(
    path.join(generated, "testing.ts"),
    [
      "// Generated by `confect codegen`. Test-only; do not import in backend functions.",
      ...imports,
      `export default { httpMounts: [${httpMounts.join(",")}], schema, convexSchema, modules: ${yield* moduleMap(convexDirectory)}, components: {${components.join("\n")}} };`,
    ].join("\n"),
  );
});
