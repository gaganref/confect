import { remove } from "@confect/cli/Remove";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Str from "effect/String";
import * as Rec from "effect/Record";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import { expect } from "@effect/vitest";
import { ProjectRoot } from "@confect/cli/ProjectRoot";
import { ConfectDirectory } from "@confect/cli/ConfectDirectory";
import { ConvexDirectory } from "@confect/cli/ConvexDirectory";

export const table = `import { Table } from "@confect/core";
import * as Schema from "effect/Schema";
import { Id } from "../_generated/id";
export default Table.make(() => Schema.Struct({ text: Schema.String, parent: Schema.optionalKey(Id("notes")) }));
`;

export const spec = `import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
import notes from "./_generated/tables/notes";
export default GroupSpec.make().addFunction(FunctionSpec.publicQuery({ name: "list", returns: () => Schema.Array(notes.Doc) }));
`;

export const impl = `import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import databaseSchema from "./_generated/schema";
import { DatabaseReader } from "./_generated/services";
import notes from "./notes.spec";
const list = FunctionImpl.make(databaseSchema, notes, "list", () => Effect.gen(function* () {
  const reader = yield* DatabaseReader;
  return yield* reader.table("notes").collect();
}).pipe(Effect.orDie));
export default GroupImpl.make(databaseSchema, notes).pipe(Layer.provide(list), GroupImpl.finalize);
`;

export const emptyImpl = `import { GroupImpl } from "@confect/server";
import databaseSchema from "./_generated/schema";
import notes from "./notes.spec";
export default GroupImpl.make(databaseSchema, notes).pipe(GroupImpl.finalize);
`;

/**
 * The files of a backend whose `authz` section names, for each `permissions/`
 * file it matches, the function of each spec in that file's `included`, found
 * by object identity among the functions codegen hands it. `render` writes the
 * names as `authz.ts`'s default export, and `verify.check` is `check`, called
 * with the names as JSON. `permissions/direct.ts` imports the specs, and
 * `permissions/indirect.ts` imports one through `shared/notes.ts`. A `node`
 * backend adds the Node-runtime group `jobs`, which `direct.ts` includes.
 *
 * @internal
 */
export const writeAuthz = (
  root: string,
  options: {
    readonly component: boolean;
    readonly node: boolean;
    readonly check: string;
  },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const [file, contents] of Rec.toEntries(authzFiles(options))) {
      yield* fs.makeDirectory(path.dirname(path.join(root, file)), {
        recursive: true,
      });
      yield* fs.writeFileString(path.join(root, file), contents);
    }
  });

const authzFiles = (options: {
  readonly component: boolean;
  readonly node: boolean;
  readonly check: string;
}): Readonly<Record<string, string>> => ({
  "confect/app.ts": `import { App, Env } from "@confect/core";
import { authz } from "./authz";
export default App.make({ ${options.component ? 'kind: "component", env: Env.make("ledger", {})' : 'env: Env.make("host", {})'}, manifestSections: [{ key: "authz", section: authz }] });
`,
  "confect/authz.ts": `const named = ({ modules, functions }) => JSON.stringify(Object.fromEntries(modules.map(({ relativePath, exports }) => [relativePath, exports.included.map((spec) => functions.find((fn) => fn.spec === spec)?.path ?? "unnamed")])));
const match = (path) => path.startsWith("permissions/");
const check = ${options.check};
export const authz = { owner: "test/authz", format: 1, describe: () => null, generate: { file: "authz.ts", match, render: (input) => ({ contents: \`export default \${named(input)};\\n\`, errors: [] }), verify: { match, check: (input) => check(named(input)) } } };
`,
  "confect/shared/notes.ts":
    'export { default as notes } from "../notes.spec";\n',
  "confect/permissions/direct.ts": options.node
    ? 'import notes from "../notes.spec";\nimport jobs from "../jobs.spec";\nexport const included = [notes.functions.list, jobs.functions.run];\n'
    : 'import notes from "../notes.spec";\nexport const included = [notes.functions.list];\n',
  "confect/permissions/indirect.ts":
    'import { notes } from "../shared/notes";\nexport const included = [notes.functions.list];\n',
  ...(options.node
    ? {
        "confect/jobs.spec.ts": `import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
export default GroupSpec.makeNode().addFunction(FunctionSpec.publicNodeAction({ name: "run", returns: () => Schema.String }));
`,
        "confect/jobs.impl.ts": `import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import databaseSchema from "./_generated/schema";
import jobs from "./jobs.spec";
const run = FunctionImpl.make(databaseSchema, jobs, "run", () => Effect.succeed("done"));
export default GroupImpl.make(databaseSchema, jobs).pipe(Layer.provide(run), GroupImpl.finalize);
`,
      }
    : {}),
});

/**
 * @internal
 */
export const writtenFiles = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const writes = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (file: string) =>
      pipe(file, Str.endsWith(".ts"))
        ? Ref.update(writes, (paths) => [...paths, file])
        : Effect.void;
    yield* effect.pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        writeFile: (...args) =>
          fs.writeFile(...args).pipe(Effect.tap(() => record(args[0]))),
        writeFileString: (...args) =>
          fs.writeFileString(...args).pipe(Effect.tap(() => record(args[0]))),
      }),
    );
    return yield* Ref.get(writes);
  });

/**
 * @internal
 */
export const installPackages = Effect.fnUntraced(function* (
  root: string,
  names: ReadonlyArray<string> = ["core", "server"],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const name of names) {
    const source = path.resolve(import.meta.dirname, "../../../", name);
    const installed = path.join(root, "node_modules", "@confect", name);
    yield* fs.makeDirectory(installed, { recursive: true });
    yield* fs.copyFile(
      path.join(source, "package.json"),
      path.join(installed, "package.json"),
    );
    yield* fs.copy(path.join(source, "dist"), path.join(installed, "dist"));
    yield* fs.symlink(
      path.join(source, "node_modules"),
      path.join(installed, "node_modules"),
    );
  }
});

/**
 * @internal
 */
export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* Effect.acquireRelease(
    fs.makeTempDirectory({
      directory: import.meta.dirname,
      prefix: "consumer-",
    }),
    (directory) =>
      remove(directory).pipe(
        Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
        Effect.orDie,
      ),
  );
  yield* installPackages(root);
  const write = (file: string, contents: string) =>
    fs.writeFileString(path.join(root, file), contents);
  yield* fs.makeDirectory(path.join(root, "confect", "tables"), {
    recursive: true,
  });
  yield* fs.makeDirectory(path.join(root, "convex"));
  yield* write("package.json", '{"type":"module"}');
  yield* write(
    "tsconfig.json",
    '{"compilerOptions":{"moduleResolution":"Bundler"}}',
  );
  yield* write("confect/tables/notes.ts", table);
  yield* write("confect/notes.spec.ts", spec);
  yield* write("confect/notes.impl.ts", impl);

  const start = Effect.fnUntraced(function* (
    command: "dev" | "codegen",
    args: ReadonlyArray<string> = [],
    env: Readonly<Record<string, string | undefined>> = {},
  ) {
    const spawner = yield* ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(
        process.execPath,
        [
          path.resolve(import.meta.dirname, "../../bin/confect.mjs"),
          command,
          ...args,
        ],
        { cwd: root, extendEnv: true, env: { ...env, NO_COLOR: "1" } },
      ),
    );
    const output = yield* Ref.make("");
    const lines = yield* Queue.unbounded<string>();
    yield* Stream.merge(
      handle.stdout.pipe(Stream.decodeText(), Stream.splitLines),
      handle.stderr.pipe(Stream.decodeText(), Stream.splitLines),
    ).pipe(
      Stream.runForEach((line) =>
        Ref.update(output, (previous) => `${previous}${line}\n`).pipe(
          Effect.andThen(Queue.offer(lines, line)),
        ),
      ),
      Effect.forkScoped,
    );
    const waitFor = (text: string) =>
      Queue.take(lines).pipe(
        Effect.repeat({ while: (line) => !pipe(line, Str.includes(text)) }),
        Effect.timeoutOption("15 seconds"),
        Effect.flatMap((result) =>
          Ref.get(output).pipe(
            Effect.map((log) => {
              expect(result._tag, `Waiting for ${text}:\n${log}`).toBe("Some");
            }),
          ),
        ),
      );
    return { handle, output, waitFor };
  });
  const generatedFiles = Effect.gen(function* () {
    const files = yield* Effect.forEach(
      ["confect/_generated", "convex"],
      (directory) =>
        fs.readDirectory(path.join(root, directory), { recursive: true }).pipe(
          Effect.map((entries) =>
            Arr.map(
              Arr.filter(entries, (entry) => pipe(entry, Str.endsWith(".ts"))),
              (entry) => path.join(directory, entry),
            ),
          ),
        ),
    );
    const actual = yield* Effect.forEach(files.flat(), (file) =>
      fs
        .readFileString(path.join(root, file))
        .pipe(Effect.map((contents) => [file, contents] as const)),
    );
    return Rec.fromEntries(actual);
  });
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(ProjectRoot, { get: Effect.succeed(root) }),
      Effect.provideService(ConfectDirectory, {
        get: Effect.succeed(path.join(root, "confect")),
      }),
      Effect.provideService(ConvexDirectory, {
        get: Effect.succeed(path.join(root, "convex")),
      }),
    );
  return { root, write, start, generatedFiles, provide };
});

/**
 * @internal
 */
export const makeNodeComponent = Effect.gen(function* () {
  const project = yield* make;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.remove(path.join(project.root, "confect"), { recursive: true });
  yield* fs.copy(
    path.join(import.meta.dirname, "../fixtures/node-component"),
    project.root,
    { overwrite: true },
  );
  return project;
});
