import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { pipe } from "effect/Function";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Match from "effect/Match";
import { UnownedConvexEntrypointError } from "./CodegenError.js";
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

const RESERVED_CONVEX_TS_FILE_NAMES = new Set([
  "schema.ts",
  "http.ts",
  "crons.ts",
  "auth.config.ts",
  "convex.config.ts",
]);

// Keep ownership and removal aligned with Convex's bundler entryPoints filter.
const getEntrypoints = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const convex = yield* ConvexDirectory.get;
  const files = yield* fs.readDirectory(convex, { recursive: true });
  const components = files
    .filter(
      (file) =>
        path.basename(file) === "convex.config.ts" &&
        path.dirname(file) !== ".",
    )
    .map((file) => path.dirname(file) + path.sep);
  return files.filter((file) => {
    const base = path.basename(file);
    return (
      !file.startsWith("_generated" + path.sep) &&
      !components.some((component) => file.startsWith(component)) &&
      /\.(?:js|mjs|cjs|ts|tsx|mts|cts|jsx)$/.test(base) &&
      !base.startsWith(".") &&
      !base.startsWith("#") &&
      (base.match(/\./g)?.length ?? 0) === 1 &&
      base !== "schema.ts" &&
      base !== "schema.js" &&
      !file.includes(" ")
    );
  });
});

const tokenize = (
  source: string,
  modulePath: string,
  path: Path.Path,
): string[] | undefined => {
  const token =
    /\s+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[$A-Z_a-z][$\w]*|[{}()[\].,:;=]/y;
  const tokens: string[] = [];
  while (token.lastIndex < source.length) {
    const match = token.exec(source);
    if (match === null) return undefined;
    const value = match[0];
    if (/^\s|^\//.test(value)) continue;
    if (value.startsWith('"') || value.startsWith("'")) {
      const literal = value.slice(1, -1);
      tokens.push(
        JSON.stringify(
          literal.startsWith(".")
            ? path.resolve(
                path.dirname(modulePath),
                literal.replace(/\.js$/, ""),
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

export const assertOwnedEntrypoints = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const convex = yield* ConvexDirectory.get;
  const confect = yield* ConfectDirectory.get;
  const projectRoot = yield* ProjectRoot.get;
  const importFromConvex = (file: string) =>
    toModuleImportPath(path.relative(convex, path.join(confect, file)));
  const optional = new Map([
    [
      "http.ts",
      [
        yield* templates.http({
          httpImportPath: yield* importFromConvex("http.ts"),
        }),
        yield* templates.declaredHttp({
          schemaImportPath: yield* importFromConvex("_generated/schema.ts"),
          httpImportPath: yield* importFromConvex("http.ts"),
        }),
        yield* templates.declaredHttp({
          schemaImportPath: yield* importFromConvex("_generated/schema.ts"),
          httpImportPath: yield* importFromConvex("http.ts"),
          runtimeImportPath: yield* importFromConvex("runtime.ts"),
        }),
      ],
    ],
    [
      "crons.ts",
      [
        yield* templates.crons({
          cronsImportPath: yield* importFromConvex("crons.ts"),
        }),
      ],
    ],
  ]);
  const refused: string[] = [];
  for (const relative of yield* getEntrypoints) {
    const absolute = path.join(convex, relative);
    const tokens = tokenize(yield* fs.readFileString(absolute), absolute, path);
    if (tokens !== undefined) {
      if (
        optional
          .get(relative)
          ?.some((template) =>
            matchesShape(tokens, tokenize(template, absolute, path)!),
          )
      )
        continue;
      if (path.extname(relative) === ".ts") {
        const names = tokens.flatMap((token, index) =>
          token === "export" && tokens[index + 1] === "const"
            ? [tokens[index + 2]!]
            : [],
        );
        const group = yield* GroupPath.fromGroupModulePath(relative);
        const template = yield* render({
          functionNames: names,
          registeredFunctionsImportPath:
            yield* registeredFunctionsImportPathForGroup(group, absolute),
          useNode: tokens[0] === '"use node"',
        });
        if (
          names.length > 0 &&
          new Set(names).size === names.length &&
          matchesShape(tokens, tokenize(template, absolute, path)!)
        )
          continue;
      }
    }
    refused.push(toPosixPath(path, path.relative(projectRoot, absolute)));
  }
  if (refused.length > 0)
    return yield* new UnownedConvexEntrypointError({
      filePaths: refused.sort(),
    });
});

export const render = ({
  functionNames,
  registeredFunctionsImportPath,
  useNode = false,
}: Parameters<typeof renderEffect>[0]) =>
  renderEffect({ functionNames, registeredFunctionsImportPath, useNode });

const renderEffect = Effect.fnUntraced(function* ({
  functionNames,
  registeredFunctionsImportPath,
  useNode = false,
}: {
  functionNames: ReadonlyArray<string>;
  registeredFunctionsImportPath: string;
  useNode?: boolean;
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
  yield* Effect.forEach(functionNames, (name) =>
    cbw.writeLine(`export const ${name} = registeredFunctions.${name};`),
  );

  return yield* cbw.toString();
});

export const generateGroupModule = ({
  groupPath,
  functionNames,
  registeredFunctionsImportPath,
  useNode = false,
}: Parameters<typeof generateGroupModuleEffect>[0]) =>
  generateGroupModuleEffect({
    groupPath,
    functionNames,
    registeredFunctionsImportPath,
    useNode,
  });

const generateGroupModuleEffect = Effect.fnUntraced(function* ({
  groupPath,
  functionNames,
  registeredFunctionsImportPath,
  useNode = false,
}: {
  groupPath: GroupPath.GroupPath;
  functionNames: ReadonlyArray<string>;
  registeredFunctionsImportPath: string;
  useNode?: boolean;
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

export const generateFunctions = Effect.fnUntraced(function* (
  snapshot: GenerationSnapshot.GenerationSnapshot,
) {
  const groupPathsFromFs = yield* getGroupPathsFromFs;
  yield* applyFunctionPlan(GenerationSnapshot.plan(snapshot, groupPathsFromFs));
  return GenerationSnapshot.functionPaths(snapshot);
});

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
        !RESERVED_CONVEX_TS_FILE_NAMES.has(path.basename(convexPath)),
    ),
    Effect.forEach((groupModulePath) =>
      GroupPath.fromGroupModulePath(groupModulePath),
    ),
  );
  return GroupPaths.GroupPaths.make(HashSet.fromIterable(groupPathArray));
});

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
      });
      yield* Match.value(change).pipe(
        Match.when("Added", () => logFileAdded(modulePath)),
        Match.when("Modified", () => logFileModified(modulePath)),
        Match.when("Unchanged", () => Effect.void),
        Match.exhaustive,
      );
    }),
  );
