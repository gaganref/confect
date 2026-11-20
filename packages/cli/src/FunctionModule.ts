import { DeployedModule } from "@confect/core";
import * as FileSystem from "effect/FileSystem";
import type * as PlatformError from "effect/PlatformError";
import * as Path from "effect/Path";
import { pipe } from "effect/Function";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Match from "effect/Match";
import * as String from "effect/String";
import { UnownedConvexEntrypointError } from "./CodegenError.js";
import * as Declaration from "./Declaration.js";
import * as SectionFiles from "./SectionFiles.js";
import * as templates from "./templates.js";
import * as GenerationSnapshot from "./GenerationSnapshot.js";
import * as GroupPath from "./GroupPath.js";
import * as GroupPaths from "./GroupPaths.js";
import { CodeBlockWriter } from "./CodeBlockWriter.js";
import { logFileAdded, logFileModified, logFileRemoved } from "./log.js";
import { ConfectDirectory } from "./ConfectDirectory.js";
import { ConvexDirectory } from "./ConvexDirectory.js";
import {
  removePathIfExists,
  toModuleImportPath,
  toPosixPath,
} from "./utils.js";
import { ProjectRoot } from "./ProjectRoot.js";
import * as Option from "effect/Option";
import { quote } from "./Json.js";

const RESERVED_CONVEX_TS_FILE_NAMES = new Set([
  "schema.ts",
  "http.ts",
  "crons.ts",
  "auth.config.ts",
  "convex.config.ts",
]);

// Only the root modules are codegen's; a nested group may take the names.
const GENERATED_MODULES: ReadonlySet<string> = new Set([
  "confectDeploy.ts",
  "confectHealth.ts",
]);

/**
 * Every file below `directory` that Convex's bundler walks, relative to it: the
 * walk `walkDir` makes (convex 1.49 `src/bundler/index.ts:27-46`), which reads
 * directory entries without following links, so a symbolic link to a file or a
 * directory is neither and is skipped, and which skips a component directory
 * inside it, one that holds a `convex.config.ts` (`entryPoints`, `:409-419`).
 */
const walked = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const visit = (
    relative: string,
  ): Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError> =>
    Effect.gen(function* () {
      const found: Array<string> = [];
      const names = yield* fs.readDirectory(path.join(directory, relative));
      for (const name of [...names].sort()) {
        const child = relative === "" ? name : path.join(relative, name);
        const absolute = path.join(directory, child);
        const linked = yield* fs.readLink(absolute).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (linked) continue;
        const info = yield* fs.stat(absolute).pipe(Effect.option);
        if (Option.isNone(info)) continue;
        if (info.value.type === "Directory") {
          if (yield* fs.exists(path.join(absolute, "convex.config.ts")))
            continue;
          const nested = yield* visit(child);
          found.push(...nested);
        } else if (info.value.type === "File") found.push(child);
      }
      return found;
    });
  return yield* visit("");
});

/**
 * The files below a Convex directory whose names Convex's bundler registers, by
 * the first half of `@confect/core`'s {@link DeployedModule} rule. The test
 * registry reads each of a packaged component's candidates, so the test kernel
 * decides the rule's second half, on the same text, for every module a kit's
 * glob loads.
 *
 * @internal
 */
export const candidateModules = Effect.fnUntraced(function* (
  directory: string,
) {
  const path = yield* Path.Path;
  const files = yield* walked(directory);
  return Array.filter(files, (file) =>
    DeployedModule.admitsName(
      Array.join(pipe(file, String.split(path.sep)), "/"),
    ),
  );
});

/**
 * The files of a Convex directory that a push registers as modules, schemas
 * included, by `@confect/core`'s {@link DeployedModule} rule, so ownership,
 * removal and the test subject see the same modules as production.
 *
 * @internal
 */
export const registeredModules = Effect.fnUntraced(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const modules: Array<string> = [];
  for (const file of yield* candidateModules(directory)) {
    const posix = Array.join(pipe(file, String.split(path.sep)), "/");
    if (DeployedModule.needsSource(posix)) {
      // A file removed since the walk is no module.
      const source = yield* fs.readFileString(path.join(directory, file)).pipe(
        Effect.asSome,
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeedNone,
        ),
      );
      if (
        Option.isNone(source) ||
        !DeployedModule.admitsSource(posix, source.value)
      )
        continue;
    }
    modules.push(file);
  }
  return modules;
});

const getEntrypoints = Effect.gen(function* () {
  const path = yield* Path.Path;
  const convex = yield* ConvexDirectory.get;
  const modules = yield* registeredModules(convex);
  return Array.filter(
    modules,
    (file) => !DeployedModule.isSchema(path.basename(file)),
  );
});

const tokenize = (
  source: string,
  modulePath: string,
  path: Path.Path,
): string[] | undefined => {
  const token =
    /\s+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[$A-Z_a-z][$\w]*|=>|[{}()[\].,:;=<>*]/y;
  const tokens: string[] = [];
  while (token.lastIndex < source.length) {
    const match = token.exec(source);
    if (match === null) return undefined;
    const value = match[0];
    if (/^\s|^\//.test(value)) continue;
    if (
      pipe(value, String.startsWith('"')) ||
      pipe(value, String.startsWith("'"))
    ) {
      const literal = pipe(value, String.slice(1, -1));
      tokens.push(
        quote(
          pipe(literal, String.startsWith("."))
            ? path.resolve(
                path.dirname(modulePath),
                pipe(literal, String.replace(/\.js$/, "")),
              )
            : literal,
        ),
      );
    } else tokens.push(value);
  }
  return tokens;
};

const matchesShape = (
  actual: readonly string[],
  expected: readonly string[],
) => {
  let index = 0;
  for (const token of expected) {
    if (token === ";" && actual[index] !== ";") continue;
    if (actual[index] === "," && (token === "}" || token === ")")) index++;
    if (actual[index++] !== token) return false;
  }
  return index === actual.length;
};

// Before the schema-first HttpRouter.make, codegen emitted forSchema; codegen
// owns that output so it can rewrite it.
const legacyRouter = String.replace(
  "HttpRouter.make(schema, http.routes, ",
  "HttpRouter.forSchema(schema)(http.routes, ",
);

// @gaganref/confect-cli 10.6.0-fork.12 wrote `wraps.reduce(` without the type
// argument. Codegen owns that output so it can rewrite it. Drop this once no
// consumer pins a release before the type argument.
const legacyCrons = String.replace(
  "wraps.reduce<CronJobs.CronJobs>(",
  "wraps.reduce(",
);

/**
 * @internal
 */
export const assertOwnedEntrypoints = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const convex = yield* ConvexDirectory.get;
  const confect = yield* ConfectDirectory.get;
  const projectRoot = yield* ProjectRoot.get;
  const importFromConvex = (file: string) =>
    toModuleImportPath(path.relative(convex, path.join(confect, file)));
  const schemaImportPath = yield* importFromConvex("_generated/schema.ts");
  const httpImportPath = yield* importFromConvex("http.ts");
  const runtimeImportPath = yield* importFromConvex("runtime.ts");
  const routesImportPath = yield* importFromConvex("_generated/routes.ts");
  const httpTemplates = [
    yield* templates.http({ httpImportPath }),
    ...(yield* Effect.forEach([undefined, routesImportPath], (routes) =>
      Effect.forEach([undefined, runtimeImportPath], (runtime) =>
        templates.declaredHttp({
          schemaImportPath,
          httpImportPath,
          routesImportPath: routes,
          runtimeImportPath: runtime,
        }),
      ),
    )).flat(),
  ];
  const optional = new Map([
    [
      "http.ts",
      Array.flatMap(httpTemplates, (template) => [
        template,
        legacyRouter(template),
      ]),
    ],
  ]);
  const written2 = yield* SectionFiles.written;
  // The declared HTTP router first imports each file a manifest section wrote.
  const sectionImports = new Map(
    Array.map(written2, (file) => [
      quote(path.join(confect, "_generated", path.basename(file, ".ts"))),
      file,
    ]),
  );
  // This check only keeps codegen from overwriting hand-written code, and later
  // in the same run codegen writes `convex/crons.ts` with exactly this run's
  // wrappers. So the crons template holds nothing to lose when it wraps
  // distinct files a section wrote, in any order, even ones that no longer
  // wrap. The same-run rewrite holds for declared backends; an undeclared
  // backend without `confect/crons.ts` keeps a leftover entry, as before.
  const cronsShapes = Effect.fnUntraced(function* (
    tokens: ReadonlyArray<string>,
  ) {
    const wrapped = Array.flatMap(tokens, (token, index) => {
      const file = sectionImports.get(token);
      return tokens[index - 1] === "from" && file !== undefined ? [file] : [];
    });
    if (new Set(wrapped).size !== wrapped.length) return [];
    const template = yield* templates.crons({
      cronsImportPath: yield* importFromConvex("crons.ts"),
      sectionImportPaths: yield* Effect.forEach(wrapped, (file) =>
        importFromConvex(`_generated/${file}`),
      ),
    });
    return [template, legacyCrons(template)];
  });
  const withoutSectionImports = (
    tokens: ReadonlyArray<string>,
  ): ReadonlyArray<string> =>
    tokens[0] === "import" && sectionImports.has(tokens[1] ?? "")
      ? withoutSectionImports(tokens.slice(tokens[2] === ";" ? 3 : 2))
      : tokens;
  // The section files a router's leading imports name, in order, and the ones
  // among them whose `pushCheck` it binds, as `declaredHttp` writes them.
  const leadingSectionImports = (
    tokens: ReadonlyArray<string>,
    files: ReadonlyArray<string> = [],
    checked: ReadonlyArray<string> = [],
  ): {
    readonly files: ReadonlyArray<string>;
    readonly checked: ReadonlyArray<string>;
  } => {
    if (tokens[0] !== "import") return { files, checked };
    const plain = sectionImports.get(tokens[1] ?? "");
    if (plain !== undefined)
      return leadingSectionImports(
        tokens.slice(tokens[2] === ";" ? 3 : 2),
        [...files, plain],
        checked,
      );
    const bound = sectionImports.get(tokens[7] ?? "");
    if (
      tokens[1] === "{" &&
      tokens[2] === "pushCheck" &&
      tokens[3] === "as" &&
      tokens[5] === "}" &&
      tokens[6] === "from" &&
      bound !== undefined
    )
      return leadingSectionImports(
        tokens.slice(tokens[8] === ";" ? 9 : 8),
        [...files, bound],
        [...checked, bound],
      );
    return { files, checked };
  };
  // A router that runs push checks, with the section imports it leads with.
  const checkedHttpShapes = Effect.fnUntraced(function* (
    tokens: ReadonlyArray<string>,
  ) {
    const { files, checked } = leadingSectionImports(tokens.slice(0));
    if (checked.length === 0 || new Set(files).size !== files.length) return [];
    const sectionImportPaths = yield* Effect.forEach(files, (file) =>
      importFromConvex(`_generated/${file}`),
    );
    const pushCheckImportPaths = yield* Effect.forEach(checked, (file) =>
      importFromConvex(`_generated/${file}`),
    );
    return (yield* Effect.forEach([undefined, routesImportPath], (routes) =>
      Effect.forEach([undefined, runtimeImportPath], (runtime) =>
        templates.declaredHttp({
          schemaImportPath,
          httpImportPath,
          routesImportPath: routes,
          runtimeImportPath: runtime,
          sectionImportPaths,
          pushCheckImportPaths,
        }),
      ),
    )).flat();
  });
  const refused: string[] = [];
  for (const relative of yield* getEntrypoints) {
    const absolute = path.join(convex, relative);
    const contents = yield* fs.readFileString(absolute);
    if (
      GENERATED_MODULES.has(relative) &&
      Declaration.isGenerated(contents, [])
    )
      continue;
    const tokens = tokenize(contents, absolute, path);
    if (tokens !== undefined) {
      const shapes =
        relative === "crons.ts"
          ? yield* cronsShapes(tokens)
          : optional.get(relative);
      if (
        shapes !== undefined &&
        Array.some(shapes, (template) =>
          matchesShape(
            relative === "http.ts" ? withoutSectionImports(tokens) : tokens,
            tokenize(template, absolute, path)!,
          ),
        )
      )
        continue;
      const checkedShapes =
        relative === "http.ts" ? yield* checkedHttpShapes(tokens) : [];
      if (
        Array.some(checkedShapes, (template) =>
          matchesShape(tokens, tokenize(template, absolute, path)!),
        )
      )
        continue;
      if (path.extname(relative) === ".ts") {
        const names = Array.flatMap(tokens, (token, index) =>
          token === "export" && tokens[index + 1] === "const"
            ? [tokens[index + 2]!]
            : [],
        );
        const group = yield* GroupPath.fromGroupModulePath(relative);
        const reusesContext = names.includes("experimental_reuseContext");
        const functionNames = Array.filter(
          names,
          (name) => name !== "experimental_reuseContext",
        );
        const template = yield* render({
          functionNames,
          registeredFunctionsImportPath:
            yield* registeredFunctionsImportPathForGroup(group, absolute),
          useNode: tokens[0] === '"use node"',
          experimental_reuseContext: reusesContext,
        });
        if (
          functionNames.length > 0 &&
          new Set(functionNames).size === functionNames.length &&
          matchesShape(tokens, tokenize(template, absolute, path)!)
        )
          continue;
      }
    }
    refused.push(toPosixPath(path, path.relative(projectRoot, absolute)));
  }
  if (refused.length > 0)
    return yield* UnownedConvexEntrypointError.make({
      filePaths: refused.sort(),
    });
});

export const render = ({
  functionNames,
  registeredFunctionsImportPath,
  useNode = false,
  experimental_reuseContext = false,
}: Parameters<typeof renderEffect>[0]) =>
  renderEffect({
    functionNames,
    registeredFunctionsImportPath,
    useNode,
    experimental_reuseContext,
  });

const renderEffect = Effect.fnUntraced(function* ({
  functionNames,
  registeredFunctionsImportPath,
  useNode = false,
  experimental_reuseContext = false,
}: {
  functionNames: ReadonlyArray<string>;
  registeredFunctionsImportPath: string;
  useNode?: boolean;
  experimental_reuseContext?: boolean;
}) {
  const cbw = new CodeBlockWriter({ indentNumberOfSpaces: 2 });

  if (useNode) {
    yield* cbw.writeLine(`"use node";`);
    yield* cbw.blankLine();
  }

  yield* cbw.writeLine(
    `import registeredFunctions from "${registeredFunctionsImportPath}";`,
  );
  yield* cbw.newLine();
  if (experimental_reuseContext) {
    yield* cbw.writeLine("export const experimental_reuseContext = true;");
    yield* cbw.newLine();
  }
  yield* Effect.forEach(functionNames, (name) =>
    cbw.writeLine(`export const ${name} = registeredFunctions.${name};`),
  );

  return yield* cbw.toString();
});

/**
 * @internal
 */
export const generateGroupModule = ({
  groupPath,
  functionNames,
  registeredFunctionsImportPath,
  useNode = false,
  experimental_reuseContext = false,
}: Parameters<typeof generateGroupModuleEffect>[0]) =>
  generateGroupModuleEffect({
    groupPath,
    functionNames,
    registeredFunctionsImportPath,
    useNode,
    experimental_reuseContext,
  });

const generateGroupModuleEffect = Effect.fnUntraced(function* ({
  groupPath,
  functionNames,
  registeredFunctionsImportPath,
  useNode = false,
  experimental_reuseContext = false,
}: {
  groupPath: GroupPath.GroupPath;
  functionNames: ReadonlyArray<string>;
  registeredFunctionsImportPath: string;
  useNode?: boolean;
  experimental_reuseContext?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const convexDirectory = yield* ConvexDirectory.get;

  const relativeModulePath = yield* GroupPath.modulePath(groupPath);
  const modulePath = path.join(convexDirectory, relativeModulePath);

  const directoryPath = path.dirname(modulePath);
  if (!(yield* fs.exists(directoryPath))) {
    yield* fs.makeDirectory(directoryPath, { recursive: true });
  }

  const functionsContentsString = yield* render({
    functionNames,
    registeredFunctionsImportPath,
    useNode,
    experimental_reuseContext,
  });

  if (!(yield* fs.exists(modulePath))) {
    yield* fs.writeFileString(modulePath, functionsContentsString);
    return "Added" as const;
  }
  const existing = yield* fs.readFileString(modulePath);
  if (existing !== functionsContentsString) {
    yield* fs.writeFileString(modulePath, functionsContentsString);
    return "Modified" as const;
  }
  return "Unchanged" as const;
});

/**
 * Compute the module import specifier (relative to `modulePath`) for a group's
 * registry file under `confect/_generated/registeredFunctions/`. The registry
 * path mirrors the group's path one-to-one (see
 * `registeredFunctionsRelativePath` in `LeafModule.ts`) for both Convex and
 * Node groups.
 *
 * @internal
 */
export const registeredFunctionsImportPathForGroup = Effect.fnUntraced(
  function* (groupPath: GroupPath.GroupPath, modulePath: string) {
    const path = yield* Path.Path;
    const confectDirectory = yield* ConfectDirectory.get;

    const registeredFunctionsPath =
      path.join(
        confectDirectory,
        "_generated",
        "registeredFunctions",
        ...groupPath.pathSegments,
      ) + ".ts";

    return yield* toModuleImportPath(
      path.relative(path.dirname(modulePath), registeredFunctionsPath),
    );
  },
);

const logGroupPaths = Effect.fnUntraced(function* <R>(
  groupPaths: GroupPaths.GroupPaths,
  logFn: (fullPath: string) => Effect.Effect<void, never, R>,
): Effect.fn.Return<void, never, R | Path.Path | ConvexDirectory> {
  const path = yield* Path.Path;
  const convexDirectory = yield* ConvexDirectory.get;

  yield* Effect.forEach(
    groupPaths,
    Effect.fnUntraced(function* (gp: GroupPath.GroupPath) {
      const relativeModulePath = yield* GroupPath.modulePath(gp);
      yield* logFn(path.join(convexDirectory, relativeModulePath));
    }),
  );
});

/**
 * @internal
 */
export const generateFunctions = Effect.fnUntraced(function* (
  snapshot: GenerationSnapshot.GenerationSnapshot,
) {
  const groupPathsFromFs = yield* getGroupPathsFromFs;
  yield* applyFunctionPlan(GenerationSnapshot.plan(snapshot, groupPathsFromFs));
  return GenerationSnapshot.functionPaths(snapshot);
});

/**
 * @internal
 */
export const applyFunctionPlan = Effect.fnUntraced(function* (
  plan: GenerationSnapshot.ModulePlan,
) {
  const removed = GroupPaths.GroupPaths.make(
    HashSet.fromIterable(plan.removed),
  );
  yield* removeGroups(removed);
  yield* logGroupPaths(removed, logFileRemoved);
  yield* writeGroups(plan.changed);
});

const getGroupPathsFromFs = Effect.gen(function* () {
  const path = yield* Path.Path;
  const allConvexPaths = yield* getEntrypoints;
  const groupPathArray = yield* pipe(
    allConvexPaths,
    Array.filter(
      (convexPath) =>
        path.extname(convexPath) === ".ts" &&
        !RESERVED_CONVEX_TS_FILE_NAMES.has(path.basename(convexPath)) &&
        !GENERATED_MODULES.has(convexPath),
    ),
    Effect.forEach((groupModulePath) =>
      GroupPath.fromGroupModulePath(groupModulePath),
    ),
  );
  return GroupPaths.GroupPaths.make(HashSet.fromIterable(groupPathArray));
});

/**
 * @internal
 */
export const removeGroups = Effect.fnUntraced(function* (
  groupPaths: GroupPaths.GroupPaths,
) {
  const path = yield* Path.Path;
  const convexDirectory = yield* ConvexDirectory.get;

  yield* Effect.all(
    HashSet.map(groupPaths, (groupPath) =>
      Effect.gen(function* () {
        const relativeModulePath = yield* GroupPath.modulePath(groupPath);
        const modulePath = path.join(convexDirectory, relativeModulePath);

        yield* Effect.logDebug(`Removing group '${relativeModulePath}'...`);

        yield* removePathIfExists(modulePath);
        yield* Effect.logDebug(`Group '${relativeModulePath}' removed`);
      }),
    ),
    { concurrency: "unbounded" },
  );
});

/**
 * @internal
 */
export const writeGroups = (
  groups: ReadonlyArray<GenerationSnapshot.GroupSummary>,
) =>
  Effect.forEach(
    groups,
    Effect.fnUntraced(function* (group: GenerationSnapshot.GroupSummary) {
      const path = yield* Path.Path;
      const convexDirectory = yield* ConvexDirectory.get;
      const relativeModulePath = yield* GroupPath.modulePath(group.path);
      const modulePath = path.join(convexDirectory, relativeModulePath);
      const registeredFunctionsImportPath =
        yield* registeredFunctionsImportPathForGroup(group.path, modulePath);
      const change = yield* generateGroupModule({
        groupPath: group.path,
        functionNames: group.functionNames,
        registeredFunctionsImportPath,
        useNode: group.runtime === "Node",
        experimental_reuseContext: group.experimental_reuseContext === true,
      });
      yield* Match.value(change).pipe(
        Match.when("Added", () => logFileAdded(modulePath)),
        Match.when("Modified", () => logFileModified(modulePath)),
        Match.when("Unchanged", () => Effect.void),
        Match.exhaustive,
      );
    }),
  );
