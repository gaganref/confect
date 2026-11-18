import {
  ConvexBundlerUnavailableError,
  PackagedComponentUnreadableError,
} from "@confect/cli/CodegenError";
import { ConfectDirectory } from "@confect/cli/ConfectDirectory";
import { ConvexDirectory } from "@confect/cli/ConvexDirectory";
import { quote } from "@confect/cli/Json";
import { ProjectRoot } from "@confect/cli/ProjectRoot";
import { codegenHandler } from "@confect/cli/confect/codegen";
import { Ref } from "@confect/core";
import type { DatabaseSchema } from "@confect/server";
import { createRequire } from "node:module";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { expect, layer } from "@effect/vitest";
import { componentsGeneric, type FunctionReference } from "convex/server";
import * as Array from "effect/Array";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as String from "effect/String";
import { type TestBackend, TestConfect } from "../../test/src";
import * as Project from "./integration/Project";
import { assertIs } from "./internal/assertIs";

// Every session in this file opens on the one `@confect/test` copy Vitest
// loads from the workspace source, which generated `testing.ts` imports too.

type Generated = {
  readonly default: TestConfect.Registry<DatabaseSchema.AnyWithProps>;
  readonly TestBackend: TestBackend.GeneratedBackend<
    unknown,
    Record<string, TestBackend.AnyGroup>,
    Record<string, TestBackend.AnyPort>
  >;
};

/**
 * A mount of the component `specifier` imports, defined as `component`.
 */
interface PackageMount {
  readonly specifier: string;
  readonly component: string;
  readonly name: string;
}

/**
 * A project whose `confect/app.ts` mounts each of `mounts`, and its codegen
 * run.
 */
const packagedProject = (mounts: ReadonlyArray<PackageMount>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const project = yield* Project.make;
    yield* project.write(
      "confect/env.ts",
      'import { Env } from "@confect/core";\nexport default Env.make("host", {});\n',
    );
    yield* project.write(
      "confect/app.ts",
      `import { App, Component, Mount } from "@confect/core";
${Array.join(
  Array.map(
    mounts,
    ({ specifier }, index) =>
      `import packaged${index} from ${quote(specifier)};`,
  ),
  "\n",
)}
import env from "./env";
const client = (native: unknown) => native;
export default App.make({
  env,
  components: [${Array.join(
    Array.map(mounts, (_, index) => `packaged${index}`),
    ", ",
  )}],
  mounts: [${Array.join(
    Array.map(
      mounts,
      ({ component, name }) =>
        `Mount.make(Component.make(${quote(component)}, { client }), { name: ${quote(name)} })`,
    ),
    ", ",
  )}],
});
`,
    );
    const run = codegenHandler.pipe(
      Effect.provideService(ProjectRoot, { get: Effect.succeed(project.root) }),
      Effect.provideService(ConfectDirectory, {
        get: Effect.succeed(path.join(project.root, "confect")),
      }),
      Effect.provideService(ConvexDirectory, {
        get: Effect.succeed(path.join(project.root, "convex")),
      }),
    );
    const read = (file: string) =>
      fs.readFileString(path.join(project.root, file));
    const exists = (file: string) => fs.exists(path.join(project.root, file));
    return { ...project, run, read, exists };
  });

type Packaged = Effect.Success<ReturnType<typeof packagedProject>>;

/**
 * A component directory defining "tool": a `surface` module, with a `"use
 * node"` directive when `node`, whose plain action reports whether its runtime
 * has Node's `setImmediate`.
 */
const toolComponent = (directory: string, node: boolean) => ({
  [`${directory}/convex.config.js`]:
    'import { defineComponent } from "convex/server";\nexport default defineComponent("tool");\n',
  [`${directory}/schema.js`]:
    'import { defineSchema } from "convex/server";\nexport default defineSchema({});\n',
  [`${directory}/_generated/api.js`]: "export {};\n",
  [`${directory}/surface.js`]: `${node ? '"use node";\n' : ""}import { actionGeneric } from "convex/server";\nexport const surface = actionGeneric({ args: {}, handler: () => typeof setImmediate });\n`,
});

/**
 * The package `name`, version 1.0.0, with `exports` and `files`, and a test kit
 * that registers `component/`'s modules without their sources, as a package's
 * kit does.
 */
const writePackage = (
  project: Packaged,
  name: string,
  exports: Readonly<Record<string, unknown>>,
  files: Readonly<Record<string, string>>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const manifest = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.Unknown),
    )({ name, version: "1.0.0", type: "module", exports });
    for (const [file, source] of Rec.toEntries({
      ...files,
      "package.json": manifest,
      "test.js": `import schema from "./component/schema.js";
const modules = {
  "./component/_generated/api.js": () => import("./component/_generated/api.js"),
  "./component/surface.js": () => import("./component/surface.js"),
};
export function register(t, name) {
  t.registerComponent(name, schema, modules);
}
`,
    })) {
      const target = path.join(project.root, "node_modules", name, file);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, source);
    }
  });

/**
 * The generated `testing.ts`, imported through Vitest, so a package's test kit
 * that globs its modules under Vite loads as it does in a product's test.
 */
const importTesting = (project: { readonly root: string }) =>
  Effect.promise(
    () =>
      import(
        /* @vite-ignore */ `${project.root}/confect/_generated/testing.ts`
      ) as Promise<Generated>,
  );

/**
 * The packaged `tool` mount's `surface` action.
 */
const toolSurface = Ref.fromFunctionReference(
  (
    componentsGeneric() as unknown as {
      readonly tool: {
        readonly surface: {
          readonly surface: FunctionReference<"action", "internal", {}, string>;
        };
      };
    }
  ).tool.surface.surface,
  "action",
);

/**
 * What `tool`'s surface action sees in a session `generated` opens, or what
 * opening it failed with.
 */
const surfaceIn = (
  generated: Generated,
  componentRuntimes?: TestConfect.ComponentRuntimes,
) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      generated.TestBackend.layer({
        config: {},
        ...(componentRuntimes === undefined ? {} : { componentRuntimes }),
      }),
    );
    return yield* Effect.gen(function* () {
      const test =
        yield* TestConfect.TestConfect<DatabaseSchema.AnyWithProps>();
      return yield* test.action(toolSurface);
    }).pipe(Effect.provideContext(services));
  }).pipe(
    Effect.exit,
    Effect.map((exit) =>
      Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit.value,
    ),
  );

/**
 * `"opened"` when `subject` builds, else the `PackagedComponentChanged` it
 * fails with, caught by its tag.
 */
const refusalOf = <A, E extends { readonly _tag: string }>(
  subject: Layer.Layer<A, E | TestConfect.PackagedRefusal>,
) =>
  Layer.build(subject).pipe(
    Effect.as("opened" as const),
    Effect.catchTag("PackagedComponentChanged", (error) =>
      Effect.succeed(error),
    ),
    Effect.orDie,
  );

const tool: PackageMount = {
  specifier: "node-tool/convex.config",
  component: "tool",
  name: "tool",
};

const plainExports = {
  "./convex.config": "./component/convex.config.js",
  "./test": "./test.js",
};

/**
 * A project mounting `node-tool`, whose `surface` module has a `"use node"`
 * directive, generated once.
 */
const generatedTool = Effect.gen(function* () {
  const project = yield* packagedProject([tool]);
  yield* writePackage(
    project,
    "node-tool",
    plainExports,
    toolComponent("component", true),
  );
  yield* project.run;
  return project;
});

layer(Layer.mergeAll(NodePath.layer, NodeFileSystem.layer))(
  "codegen's packaged component sources",
  (it) => {
    it.effect(
      "reads the modules of the official workpool and its nested batch worker from the files codegen read, so their plain actions open on the kernel",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const project = yield* packagedProject([
            {
              specifier: "@convex-dev/workpool/convex.config",
              component: "workpool",
              name: "pool",
            },
          ]);
          yield* project.run;
          const testing = yield* project.read("confect/_generated/testing.ts");
          expect(testing).not.toContain(".pnpm");
          expect(testing).not.toMatch(/node_modules[/\\]/);
          expect(testing).toMatch(
            /\{ package: "@convex-dev\/workpool", version: "0\.4\.14", manifest: "sha256:[0-9a-f]{64}", file: "dist\/component\/convex\.config\.js", digest: "sha256:[0-9a-f]{64}", absent: \["dist\/component\/convex\.config\.ts", "dist\/component\/http\.js", "dist\/component\/http\.ts"\], walked: \[\{ path: "dist", kind: "directory" \}, \{ path: "dist\/component", kind: "directory" \}, [^\]]*\{ path: "package\.json", kind: "file" \}\] \}/,
          );
          // workpool's definition imports only convex/server and batch
          // worker's definition, so it reaches no helper. batch worker's
          // imports convex/server, convex/values and ./logging, which
          // imports only convex/values, so its walk digests logging.js and
          // records as absent each other candidate esbuild would try, the
          // manifests the browser check looked for, the definition's sibling
          // of the other extension and the absent http modules. Each step
          // records every file it read and each directory above it as walked.
          expect(testing).toMatch(
            /\{ package: "@convex-dev\/batch-worker", version: "0\.2\.2", manifest: "sha256:[0-9a-f]{64}", file: "dist\/component\/convex\.config\.js", digest: "sha256:[0-9a-f]{64}", helpers: \[\{ file: "dist\/component\/logging\.js", digest: "sha256:[0-9a-f]{64}" \}\], absent: \["dist\/component\/convex\.config\.ts", "dist\/component\/http\.js", "dist\/component\/http\.ts", "dist\/component\/logging", "dist\/component\/logging\.css", "dist\/component\/logging\.json", "dist\/component\/logging\.jsx", "dist\/component\/logging\.ts", "dist\/component\/logging\.tsx", "dist\/component\/package\.json", "dist\/package\.json"\], walked: \[\{ path: "dist", kind: "directory" \}, \{ path: "dist\/component", kind: "directory" \}, [^\]]*\{ path: "package\.json", kind: "file" \}\] \}/,
          );
          const generated = yield* importTesting(project);
          const packagedSources = generated.default.packagedSources ?? {};
          expect(Rec.keys(packagedSources)).toEqual([
            "pool",
            "pool/batchWorker",
          ]);
          const workpool = yield* fs.realPath(
            path.join(
              import.meta.dirname,
              "../node_modules/@convex-dev/workpool",
            ),
          );
          const batchWorker = yield* fs.realPath(
            path.join(workpool, "../batch-worker"),
          );
          for (const [mount, root, module] of [
            ["pool", workpool, "worker.js"],
            ["pool/batchWorker", batchWorker, "loop.js"],
          ] as const) {
            const read = packagedSources[mount];
            // The official workpool is the layout the registry reads.
            assertIs(read, Predicate.isFunction);
            const found = yield* Effect.promise(read);
            const bytes = Option.getOrUndefined(
              Array.findFirst(found.files, ({ file }) => file === module),
            )?.bytes;
            assertIs(bytes, Predicate.isNotUndefined);
            const installed = yield* fs.readFile(
              path.join(root, "dist/component", module),
            );
            expect(new Uint8Array(bytes)).toEqual(new Uint8Array(installed));
          }
          const opened = yield* refusalOf(
            generated.TestBackend.layer({ config: {} }),
          );
          expect(opened).toBe("opened");
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "reads a packaged component's \"use node\" module as Convex does, unless the layer declares the component's runtime",
      () =>
        Effect.gen(function* () {
          const project = yield* generatedTool;
          const generated = yield* importTesting(project);
          const fromSources = yield* surfaceIn(generated);
          const declared = yield* surfaceIn(generated, { tool: "isolate" });
          expect(fromSources).toBe("function");
          expect(declared).toBe("undefined");
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "reads the config branch Convex's deploy bundler picks, here a convex branch before an import branch",
      () =>
        Effect.gen(function* () {
          const project = yield* packagedProject([tool]);
          // The deploy resolves under convex and module, Node under import.
          yield* writePackage(
            project,
            "node-tool",
            {
              "./convex.config": {
                convex: "./component/convex.config.js",
                import: "./node/convex.config.js",
              },
              "./test": "./test.js",
            },
            {
              ...toolComponent("component", false),
              ...toolComponent("node", true),
            },
          );
          yield* project.run;
          const testing = yield* project.read("confect/_generated/testing.ts");
          expect(testing).toContain('file: "component/convex.config.js"');
          const generated = yield* importTesting(project);
          const surface = yield* surfaceIn(generated);
          expect(surface).toBe("undefined");
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "reads the directory codegen read when the test process resolves the package's exports under other conditions",
      () =>
        Effect.gen(function* () {
          const project = yield* packagedProject([tool]);
          // Vitest resolves under the `development` condition, which neither
          // codegen nor Convex's deploy bundler does.
          yield* writePackage(
            project,
            "node-tool",
            {
              "./convex.config": {
                development: "./dev/convex.config.js",
                default: "./component/convex.config.js",
              },
              "./test": "./test.js",
            },
            {
              ...toolComponent("component", true),
              ...toolComponent("dev", false),
            },
          );
          yield* project.run;
          const generated = yield* importTesting(project);
          const surface = yield* surfaceIn(generated);
          expect(surface).toBe("function");
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "keeps the spelling of a config import, here one only an import condition exports with its extension",
      () =>
        Effect.gen(function* () {
          const project = yield* packagedProject([
            { ...tool, specifier: "node-tool/convex.config.js" },
          ]);
          yield* writePackage(
            project,
            "node-tool",
            {
              "./convex.config.js": { import: "./component/convex.config.js" },
              "./test": "./test.js",
            },
            toolComponent("component", true),
          );
          yield* project.run;
          const generated = yield* importTesting(project);
          const surface = yield* surfaceIn(generated);
          expect(surface).toBe("function");
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "reads every regular file whose name Convex registers, and nothing a link or a directory with a module's name holds",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const project = yield* packagedProject([tool]);
          yield* writePackage(project, "node-tool", plainExports, {
            ...toolComponent("component", true),
            "component/empty.ts": "const unused = 1;\n",
            "shared/extra.js": "export const extra = 1;\n",
          });
          const component = `${project.root}/node_modules/node-tool/component`;
          yield* fs.makeDirectory(`${component}/folder.js`);
          // Windows creates a link only with a privilege CI lacks.
          if (process.platform !== "win32") {
            yield* fs.symlink(
              `${component}/surface.js`,
              `${component}/linked.js`,
            );
            yield* fs.symlink(
              `${project.root}/node_modules/node-tool/shared`,
              `${component}/linkedDirectory`,
            );
          }
          yield* project.run;
          const testing = yield* project.read("confect/_generated/testing.ts");
          const files = Array.map(
            [
              ...String.matchAll(/\{ file: "([^"]+)", digest: "sha256:/g)(
                testing,
              ),
            ],
            ([, file]) => file,
          );
          // The kernel reads empty.ts's text and leaves it unregistered.
          expect(files).toEqual(["empty.ts", "schema.js", "surface.js"]);
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "registers no TypeScript file of a kit's glob without an import or export, as Convex does, so the session opens",
      () =>
        Effect.gen(function* () {
          const project = yield* packagedProject([tool]);
          yield* writePackage(project, "node-tool", plainExports, {
            ...toolComponent("component", false),
            "component/empty.ts":
              'const unused = 1;\nthrow new Error("Convex never registers empty.ts, so nothing loads it");\n',
          });
          // A kit that registers every module its glob finds, as official
          // kits do, in TypeScript, which Vitest transforms below
          // node_modules too.
          const manifest = yield* Schema.encodeEffect(
            Schema.fromJsonString(Schema.Unknown),
          )({
            name: "node-tool",
            version: "1.0.0",
            type: "module",
            exports: { ...plainExports, "./test": "./test.ts" },
          });
          yield* project.write("node_modules/node-tool/package.json", manifest);
          yield* project.write(
            "node_modules/node-tool/test.ts",
            `import schema from "./component/schema.js";
const modules = import.meta.glob("./component/**/*.{js,ts}");
export function register(t: any, name: string) {
  t.registerComponent(name, schema, modules);
}
`,
          );
          yield* project.run;
          const generated = yield* importTesting(project);
          const surface = yield* surfaceIn(generated);
          expect(surface).toBe("undefined");
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "refuses a session when package.json changed at the same version, as a link: rebuild that points the export at another directory does",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const project = yield* generatedTool;
          // The rebuild keeps component/ and its files, unchanged.
          for (const [file, source] of Rec.toEntries(
            toolComponent("rebuilt", false),
          )) {
            const target = `${project.root}/node_modules/node-tool/${file}`;
            yield* fs.makeDirectory(path.dirname(target), { recursive: true });
            yield* fs.writeFileString(target, source);
          }
          const rebuilt = yield* Schema.encodeEffect(
            Schema.fromJsonString(Schema.Unknown),
          )({
            name: "node-tool",
            version: "1.0.0",
            type: "module",
            exports: {
              ...plainExports,
              "./convex.config": "./rebuilt/convex.config.js",
            },
          });
          yield* project.write("node_modules/node-tool/package.json", rebuilt);
          const generated = yield* importTesting(project);
          const refused = yield* refusalOf(
            generated.TestBackend.layer({ config: {} }),
          );
          expect(refused).toMatchObject({
            _tag: "PackagedComponentChanged",
            mount: "tool",
            package: "node-tool",
            file: "package.json",
            reason: expect.stringContaining("its bytes differ"),
          });
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "refuses at codegen when the installed convex cannot load the esbuild it pins",
      () =>
        Effect.gen(function* () {
          const project = yield* packagedProject([tool]);
          yield* writePackage(
            project,
            "node-tool",
            plainExports,
            toolComponent("component", true),
          );
          // A convex whose own esbuild is missing, so Node's lookup from it
          // walks up to the CLI's newer one.
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(`${project.root}/node_modules/convex`, {
            recursive: true,
          });
          const path = yield* Path.Path;
          const installed = path.dirname(
            createRequire(import.meta.url).resolve("convex/package.json"),
          );
          const manifest = yield* Schema.encodeEffect(
            Schema.fromJsonString(Schema.Unknown),
          )({
            name: "convex",
            version: "1.49.0",
            type: "module",
            dependencies: { esbuild: "0.27.0" },
            exports: {
              "./package.json": "./package.json",
              "./server": "./server.js",
              "./values": "./values.js",
            },
          });
          yield* project.write("node_modules/convex/package.json", manifest);
          for (const entry of ["server", "values"])
            yield* project.write(
              `node_modules/convex/${entry}.js`,
              `export * from ${quote(path.join(installed, "dist/esm", entry, "index.js"))};\n`,
            );
          const error = yield* Effect.flip(project.run);
          expect(error).toBeInstanceOf(ConvexBundlerUnavailableError);
          expect(error).toMatchObject({
            mount: "tool",
            reason: expect.stringMatching(
              /pins esbuild 0\.27\.0.*esbuild 0\.28/,
            ),
          });
          const written = yield* project.exists(
            "confect/_generated/testing.ts",
          );
          expect(written).toBe(false);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "refuses at codegen a packaged component Convex's deploy bundler cannot resolve, naming the package",
      () =>
        Effect.gen(function* () {
          const project = yield* packagedProject([tool]);
          yield* writePackage(
            project,
            "node-tool",
            {
              "./convex.config": { node: "./component/convex.config.js" },
              "./test": "./test.js",
            },
            toolComponent("component", true),
          );
          const error = yield* Effect.flip(project.run);
          expect(error).toBeInstanceOf(PackagedComponentUnreadableError);
          expect(error).toMatchObject({
            mount: "tool",
            component: "node-tool",
            reason: expect.stringContaining("Convex's deploy bundler"),
          });
          const written = yield* project.exists(
            "confect/_generated/testing.ts",
          );
          expect(written).toBe(false);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "refuses a session in its typed channel when the installed version changed since codegen",
      () =>
        Effect.gen(function* () {
          const project = yield* generatedTool;
          const upgraded = yield* Schema.encodeEffect(
            Schema.fromJsonString(Schema.Unknown),
          )({
            name: "node-tool",
            version: "2.0.0",
            type: "module",
            exports: plainExports,
          });
          yield* project.write("node_modules/node-tool/package.json", upgraded);
          const generated = yield* importTesting(project);
          const refused = yield* refusalOf(
            generated.TestBackend.layer({ config: {} }),
          );
          expect(refused).toMatchObject({
            _tag: "PackagedComponentChanged",
            mount: "tool",
            package: "node-tool",
            file: "package.json",
            reason: expect.stringMatching(/2\.0\.0.*1\.0\.0/),
          });
          expect((refused as Error).message).toContain(
            "Run confect codegen again",
          );
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect.each([
      {
        changed: "component/surface.js",
        source:
          'import { actionGeneric } from "convex/server";\nexport const surface = actionGeneric({ args: {}, handler: () => typeof setImmediate });\n',
      },
      {
        changed: "component/convex.config.js",
        source:
          'import { defineComponent } from "convex/server";\nexport default defineComponent("tool");\n// rebuilt\n',
      },
    ])(
      "refuses a session when $changed changed at the same version",
      ({ changed, source }) =>
        Effect.gen(function* () {
          const project = yield* generatedTool;
          yield* project.write(`node_modules/node-tool/${changed}`, source);
          const generated = yield* importTesting(project);
          const refused = yield* refusalOf(
            generated.TestBackend.layer({ config: {} }),
          );
          expect(refused).toMatchObject({
            _tag: "PackagedComponentChanged",
            mount: "tool",
            package: "node-tool",
            file: changed,
            reason: "its bytes differ from the ones codegen read",
          });
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "refuses a session when a relative file the definition imports changed since codegen walked it",
      () =>
        Effect.gen(function* () {
          const project = yield* packagedProject([tool]);
          yield* writePackage(project, "node-tool", plainExports, {
            ...toolComponent("component", true),
            "component/convex.config.js":
              'import { defineComponent } from "convex/server";\nimport { name } from "../shared/name.js";\nexport default defineComponent(name);\n',
            "shared/name.js":
              'import { v } from "convex/values";\nvoid v;\nexport const name = "tool";\n',
          });
          yield* project.run;
          const testing = yield* project.read("confect/_generated/testing.ts");
          expect(testing).toContain('helpers: [{ file: "shared/name.js"');
          yield* project.write(
            "node_modules/node-tool/shared/name.js",
            'export const name = "tool";\n// rebuilt\n',
          );
          const generated = yield* importTesting(project);
          const refused = yield* refusalOf(
            generated.TestBackend.layer({ config: {} }),
          );
          expect(refused).toMatchObject({
            _tag: "PackagedComponentChanged",
            mount: "tool",
            package: "node-tool",
            file: "shared/name.js",
            reason: "its bytes differ from the ones codegen read",
          });
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "refuses a session when a nested package.json the walk read gains a browser field since codegen",
      () =>
        Effect.gen(function* () {
          const project = yield* packagedProject([tool]);
          yield* writePackage(project, "node-tool", plainExports, {
            ...toolComponent("component", true),
            "component/convex.config.js":
              'import { defineComponent } from "convex/server";\nimport { name } from "../shared/name.js";\nexport default defineComponent(name);\n',
            "shared/package.json": '{ "type": "module" }\n',
            "shared/name.js": 'export const name = "tool";\n',
          });
          yield* project.run;
          const testing = yield* project.read("confect/_generated/testing.ts");
          expect(testing).toContain(
            '{ file: "shared/package.json", digest: "sha256:',
          );
          // Convex's esbuild follows a browser redirect added after codegen.
          yield* project.write(
            "node_modules/node-tool/shared/package.json",
            '{ "type": "module", "browser": { "./name.js": "./other.js" } }\n',
          );
          const generated = yield* importTesting(project);
          const refused = yield* refusalOf(
            generated.TestBackend.layer({ config: {} }),
          );
          expect(refused).toMatchObject({
            _tag: "PackagedComponentChanged",
            mount: "tool",
            package: "node-tool",
            file: "shared/package.json",
            reason: "its bytes differ from the ones codegen read",
          });
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "refuses a session when a convex.config.ts appears beside the recorded convex.config.js, which Convex would deploy instead",
      () =>
        Effect.gen(function* () {
          const project = yield* generatedTool;
          yield* project.write(
            "node_modules/node-tool/component/convex.config.ts",
            'import { defineComponent } from "convex/server";\nexport default defineComponent("tool");\n',
          );
          const generated = yield* importTesting(project);
          const refused = yield* refusalOf(
            generated.TestBackend.layer({ config: {} }),
          );
          expect(refused).toMatchObject({
            _tag: "PackagedComponentChanged",
            mount: "tool",
            package: "node-tool",
            file: "component/convex.config.ts",
            reason: expect.stringContaining(
              "codegen found nothing at this path",
            ),
          });
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect.each([
      {
        // Inside node_modules, esbuild tries `.jsx` before `.js`, so Convex
        // would now deploy the new file, which mounts a child.
        added: "component/logging.jsx",
        source:
          'import { defineComponent } from "convex/server";\nimport child from "other/convex.config";\nexport const install = (component) => component.use(child);\nexport const label = "tool";\nvoid defineComponent;\n',
      },
      {
        // A manifest the browser check looked for and found nothing at.
        added: "component/package.json",
        source: '{ "browser": { "./logging.js": "./other.js" } }\n',
      },
    ])(
      "refuses a session when $added appears where codegen found nothing while resolving a relative import",
      ({ added, source }) =>
        Effect.gen(function* () {
          const project = yield* packagedProject([tool]);
          yield* writePackage(project, "node-tool", plainExports, {
            ...toolComponent("component", true),
            "component/convex.config.js":
              'import { defineComponent } from "convex/server";\nimport { label } from "./logging";\nexport default defineComponent(label);\n',
            "component/logging.js": 'export const label = "tool";\n',
          });
          yield* project.run;
          const testing = yield* project.read("confect/_generated/testing.ts");
          expect(testing).toContain('helpers: [{ file: "component/logging.js"');
          expect(testing).toContain(quote(added));
          const generated = yield* importTesting(project);
          const before = yield* refusalOf(
            generated.TestBackend.layer({ config: {} }),
          );
          yield* project.write(`node_modules/node-tool/${added}`, source);
          const after = yield* refusalOf(
            generated.TestBackend.layer({ config: {} }),
          );
          expect(before).toBe("opened");
          expect(after).toMatchObject({
            _tag: "PackagedComponentChanged",
            mount: "tool",
            package: "node-tool",
            file: added,
            reason: expect.stringContaining(
              "codegen found nothing at this path",
            ),
          });
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "refuses a session when the file a relative import resolved to is gone, as esbuild would try the next candidate",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const project = yield* packagedProject([tool]);
          yield* writePackage(project, "node-tool", plainExports, {
            ...toolComponent("component", true),
            "component/convex.config.js":
              'import { defineComponent } from "convex/server";\nimport { label } from "./logging";\nexport default defineComponent(label);\n',
            "component/logging.js": 'export const label = "tool";\n',
          });
          yield* project.run;
          yield* fs.remove(
            `${project.root}/node_modules/node-tool/component/logging.js`,
          );
          const generated = yield* importTesting(project);
          const refused = yield* refusalOf(
            generated.TestBackend.layer({ config: {} }),
          );
          expect(refused).toMatchObject({
            _tag: "PackagedComponentChanged",
            mount: "tool",
            package: "node-tool",
            file: "component/logging.js",
            reason: expect.stringContaining("ENOENT"),
          });
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    /**
     * `node-tool`, whose definition imports `./logging`, which imports
     * `./levels`, so the walk reaches two relative files, at depth 1 and 2.
     */
    const chainedTool = Effect.gen(function* () {
      const project = yield* packagedProject([tool]);
      yield* writePackage(project, "node-tool", plainExports, {
        ...toolComponent("component", true),
        "component/convex.config.js":
          'import { defineComponent } from "convex/server";\nimport { label } from "./logging";\nexport default defineComponent(label);\n',
        "component/logging.js": 'export { label } from "./levels";\n',
        "component/levels.js": 'export const label = "tool";\n',
        "shared/name.js": 'export const name = "tool";\n',
      });
      yield* project.run;
      return project;
    });

    it.effect.each([
      {
        depth: 1,
        added: "component/logging.jsx",
      },
      {
        depth: 2,
        added: "component/levels.jsx",
      },
    ])(
      "refuses a session when a dangling link appears at a candidate of the depth $depth import, as lstat sees it",
      ({ added }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const project = yield* chainedTool;
          const testing = yield* project.read("confect/_generated/testing.ts");
          expect(testing).toContain(quote(added));
          const generated = yield* importTesting(project);
          yield* fs.symlink(
            "./nowhere.jsx",
            `${project.root}/node_modules/node-tool/${added}`,
          );
          const refused = yield* refusalOf(
            generated.TestBackend.layer({ config: {} }),
          );
          expect(refused).toMatchObject({
            _tag: "PackagedComponentChanged",
            mount: "tool",
            package: "node-tool",
            file: added,
            reason: expect.stringContaining(
              "codegen found nothing at this path",
            ),
          });
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "refuses a session when a walked helper becomes a link to identical text in another directory, whose own relative import resolves elsewhere",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const project = yield* chainedTool;
          const generated = yield* importTesting(project);
          const installed = `${project.root}/node_modules/node-tool`;
          // The same bytes, beside a levels.js that mounts nothing the same.
          yield* fs.makeDirectory(`${installed}/elsewhere`);
          yield* project.write(
            "node_modules/node-tool/elsewhere/logging.js",
            'export { label } from "./levels";\n',
          );
          yield* project.write(
            "node_modules/node-tool/elsewhere/levels.js",
            'export const label = "other";\n',
          );
          yield* fs.remove(`${installed}/component/logging.js`);
          yield* fs.symlink(
            "../elsewhere/logging.js",
            `${installed}/component/logging.js`,
          );
          const refused = yield* refusalOf(
            generated.TestBackend.layer({ config: {} }),
          );
          expect(refused).toMatchObject({
            _tag: "PackagedComponentChanged",
            mount: "tool",
            package: "node-tool",
            file: "component/logging.js",
            reason:
              "codegen walked a file here, and it holds a symbolic link now",
          });
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "refuses a session when a walked directory becomes a link to a copy with the same files",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const project = yield* chainedTool;
          const generated = yield* importTesting(project);
          const installed = `${project.root}/node_modules/node-tool`;
          yield* fs.copy(`${installed}/component`, `${installed}/copy`);
          yield* fs.remove(`${installed}/component`, { recursive: true });
          yield* fs.symlink("./copy", `${installed}/component`);
          const refused = yield* refusalOf(
            generated.TestBackend.layer({ config: {} }),
          );
          expect(refused).toMatchObject({
            _tag: "PackagedComponentChanged",
            mount: "tool",
            package: "node-tool",
            file: "component",
            reason:
              "codegen walked a directory here, and it holds a symbolic link now",
          });
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "refuses a session when the convex Node finds from the registry is not the one whose esbuild codegen resolved with",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const project = yield* generatedTool;
          const testing = yield* project.read("confect/_generated/testing.ts");
          expect(testing).toMatch(
            /\], \{ manifest: "sha256:[0-9a-f]{64}" \}\),/,
          );
          const generated = yield* importTesting(project);
          // A nearer convex, whose manifest pins another esbuild.
          yield* fs.makeDirectory(`${project.root}/node_modules/convex`, {
            recursive: true,
          });
          yield* project.write(
            "node_modules/convex/package.json",
            '{ "name": "convex", "version": "9.9.9", "dependencies": { "esbuild": "0.99.0" } }\n',
          );
          const refused = yield* refusalOf(
            generated.TestBackend.layer({ config: {} }),
          );
          expect(refused).toMatchObject({
            _tag: "PackagedComponentChanged",
            mount: "tool",
            package: "convex",
            file: "package.json",
            reason: expect.stringContaining("pin the esbuild"),
          });
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "checks the files again on every open, so a change after one session refuses the next",
      () =>
        Effect.gen(function* () {
          const project = yield* generatedTool;
          const generated = yield* importTesting(project);
          const first = yield* refusalOf(
            generated.TestBackend.layer({ config: {} }),
          );
          yield* project.write(
            "node_modules/node-tool/component/surface.js",
            'import { actionGeneric } from "convex/server";\nexport const surface = actionGeneric({ args: {}, handler: () => "changed" });\n',
          );
          const second = yield* refusalOf(
            generated.TestBackend.layer({ config: {} }),
          );
          expect(first).toBe("opened");
          expect(second).toMatchObject({
            _tag: "PackagedComponentChanged",
            file: "component/surface.js",
          });
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "refuses a missing module in the typed channel of TestBackend.layer and TestConfect.layer, naming the file",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const project = yield* generatedTool;
          yield* fs.remove(
            `${project.root}/node_modules/node-tool/component/surface.js`,
          );
          const generated = yield* importTesting(project);
          const fromBackend = yield* refusalOf(
            generated.TestBackend.layer({ config: {} }),
          );
          const fromLayer = yield* refusalOf(
            TestConfect.layer(
              generated.default as TestConfect.DeclaredApp<DatabaseSchema.AnyWithProps>,
              { target: "kernel" },
            ),
          );
          for (const refused of [fromBackend, fromLayer]) {
            expect(refused).toMatchObject({
              _tag: "PackagedComponentChanged",
              mount: "tool",
              package: "node-tool",
              file: "component/surface.js",
              reason: expect.stringContaining("ENOENT"),
            });
          }
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "keeps a registry without the test subject free of @confect/test imports",
      () =>
        Effect.gen(function* () {
          const project = yield* packagedProject([tool]);
          yield* writePackage(
            project,
            "node-tool",
            plainExports,
            toolComponent("component", true),
          );
          // A package that exports nothing, so codegen cannot import it.
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(
            `${project.root}/node_modules/@confect/test`,
            {
              recursive: true,
            },
          );
          yield* project.write(
            "node_modules/@confect/test/package.json",
            '{ "name": "@confect/test", "type": "module", "exports": {} }\n',
          );
          yield* project.run;
          const testing = yield* project.read("confect/_generated/testing.ts");
          expect(testing).toContain('packagedSources: {"tool": packageRead(');
          expect(testing).not.toContain("@confect/test");
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );
  },
);
