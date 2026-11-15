import { PackagedComponentUnreadableError } from "@confect/cli/CodegenError";
import { ConfectDirectory } from "@confect/cli/ConfectDirectory";
import { ConvexDirectory } from "@confect/cli/ConvexDirectory";
import { quote } from "@confect/cli/Json";
import { ProjectRoot } from "@confect/cli/ProjectRoot";
import { codegenHandler } from "@confect/cli/confect/codegen";
import { Ref } from "@confect/core";
import type { DatabaseSchema } from "@confect/server";
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
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
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

const tool: PackageMount = {
  specifier: "node-tool/convex.config",
  component: "tool",
  name: "tool",
};

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
          expect(testing).toContain(
            '{ package: "@convex-dev/workpool", version: "0.4.14", file: "dist/component/convex.config.js" }',
          );
          const generated = yield* importTesting(project);
          const componentSources = generated.default.componentSources ?? {};
          expect(Rec.keys(componentSources)).toEqual([
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
            const read = componentSources[mount]?.[module];
            assertIs(read, Predicate.isNotUndefined);
            const source = yield* Effect.promise(read);
            const installed = yield* fs.readFileString(
              path.join(root, "dist/component", module),
            );
            expect(source).toBe(installed);
          }
          const opened = yield* Layer.build(
            generated.TestBackend.layer({ config: {} }),
          ).pipe(
            Effect.exit,
            Effect.map((exit) =>
              Exit.isFailure(exit) ? Cause.squash(exit.cause) : "opened",
            ),
          );
          expect(opened).toBe("opened");
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "reads a packaged component's \"use node\" module as Convex does, unless the layer declares the component's runtime",
      () =>
        Effect.gen(function* () {
          const project = yield* packagedProject([tool]);
          yield* writePackage(
            project,
            "node-tool",
            {
              "./convex.config": "./component/convex.config.js",
              "./test": "./test.js",
            },
            toolComponent("component", true),
          );
          yield* project.run;
          const generated = yield* importTesting(project);
          const fromSources = yield* surfaceIn(generated);
          const declared = yield* surfaceIn(generated, { tool: "isolate" });
          expect(fromSources).toBe("function");
          expect(declared).toBe("undefined");
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "reads the directory codegen read when the test process resolves the package's exports under other conditions",
      () =>
        Effect.gen(function* () {
          const project = yield* packagedProject([tool]);
          // Vitest resolves under the `development` condition, codegen and
          // Convex's bundler under `default`.
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
      "refuses a session when the installed package changed since codegen, naming the mount, the package and both locations",
      () =>
        Effect.gen(function* () {
          const project = yield* packagedProject([tool]);
          const exports = {
            "./convex.config": "./component/convex.config.js",
            "./test": "./test.js",
          };
          yield* writePackage(
            project,
            "node-tool",
            exports,
            toolComponent("component", true),
          );
          yield* project.run;
          const upgraded = yield* Schema.encodeEffect(
            Schema.fromJsonString(Schema.Unknown),
          )({ name: "node-tool", version: "2.0.0", type: "module", exports });
          yield* project.write("node_modules/node-tool/package.json", upgraded);
          const generated = yield* importTesting(project);
          const refused = yield* surfaceIn(generated);
          expect(refused).toMatchObject({
            _tag: "PackagedComponentChanged",
            mount: "tool",
            package: "node-tool",
            codegen: "node-tool@1.0.0/component/convex.config.js",
            found: expect.stringMatching(/^node-tool@2\.0\.0 at .*node-tool$/),
          });
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "refuses at codegen a packaged component whose modules cannot be read, naming the package",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const project = yield* packagedProject([tool]);
          yield* writePackage(
            project,
            "node-tool",
            {
              "./convex.config": "./component/convex.config.js",
              "./test": "./test.js",
            },
            toolComponent("component", true),
          );
          // A directory where a module belongs, which no read returns.
          yield* fs.makeDirectory(
            `${project.root}/node_modules/node-tool/component/broken.js`,
          );
          const error = yield* Effect.flip(project.run);
          expect(error).toMatchObject({
            _tag: "PackagedComponentUnreadableError",
            mount: "tool",
            component: "node-tool",
          });
          expect(error).toBeInstanceOf(PackagedComponentUnreadableError);
          const written = yield* project.exists(
            "confect/_generated/testing.ts",
          );
          expect(written).toBe(false);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );
  },
);
