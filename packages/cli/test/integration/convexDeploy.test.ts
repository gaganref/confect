import { ConfectDirectory } from "@confect/cli/ConfectDirectory";
import { ConvexDirectory } from "@confect/cli/ConvexDirectory";
import { quote } from "@confect/cli/Json";
import { ProjectRoot } from "@confect/cli/ProjectRoot";
import { codegenHandler } from "@confect/cli/confect/codegen";
import { DeployedModule } from "@confect/core";
import type { DatabaseSchema } from "@confect/server";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "@effect/vitest";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Order from "effect/Order";
import * as Str from "effect/String";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import type { TestConfect } from "../../../test/src";
import { cases, corpus, type Fixture } from "./convexDeploy/corpus";
import * as Project from "./Project";

/**
 * What a deploy, or codegen's registry, holds for one mount: its definition
 * file and component directory, real paths, and its modules below the
 * directory. Codegen does not record a local mount's definition, but every
 * mount in the corpus is packaged.
 */
const Mount = Schema.Struct({
  directory: Schema.String,
  definition: Schema.String,
  modules: Schema.Array(Schema.String),
});

const Deployed = Schema.Union([
  Schema.Struct({
    deploys: Schema.Literal(true),
    app: Schema.Array(Schema.String),
    mounts: Schema.Record(Schema.String, Mount),
  }),
  Schema.Struct({ deploys: Schema.Literal(false), reason: Schema.String }),
]);

const DeployedJson = Schema.fromJsonString(Deployed);

/**
 * What `convex deploy` would deploy for the project at `root`, as
 * `convexDeploy/deploy.mjs` reads it from convex's own code.
 */
const deployOf = (root: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(
        process.execPath,
        [path.join(import.meta.dirname, "convexDeploy", "deploy.mjs")],
        { cwd: root, extendEnv: true, env: { NO_COLOR: "1" } },
      ),
    );
    const output = yield* handle.stdout.pipe(
      Stream.decodeText(),
      Stream.mkString,
    );
    return yield* Schema.decodeEffect(DeployedJson)(Str.trim(output));
  }).pipe(Effect.scoped);

/**
 * The app's `convex/convex.config.ts` as codegen writes it for `mounts`, for a
 * deploy of a fixture codegen refused.
 */
const convexConfig = (fixture: Fixture) =>
  Array.join(
    [
      'import { defineApp } from "convex/server";',
      ...Array.map(
        fixture.mounts,
        ({ specifier }, index) =>
          `import mounted${index} from ${quote(specifier)};`,
      ),
      "const app = defineApp();",
      ...Array.map(
        fixture.mounts,
        ({ name }, index) =>
          `app.use(mounted${index}, { name: ${quote(name)} });`,
      ),
      "export default app;",
      "",
    ],
    "\n",
  );

/**
 * A project declaring `fixture`'s mounts, with its files below `node_modules`.
 */
const projectOf = (fixture: Fixture) =>
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
      Array.join(
        [
          'import { App, Component, Mount } from "@confect/core";',
          ...Array.map(
            fixture.mounts,
            ({ specifier }, index) =>
              `import packaged${index} from ${quote(specifier)};`,
          ),
          'import env from "./env";',
          "const client = (native: unknown) => native;",
          `export default App.make({ env, components: [${Array.join(
            Array.map(fixture.mounts, (_, index) => `packaged${index}`),
            ", ",
          )}], mounts: [${Array.join(
            Array.map(
              fixture.mounts,
              ({ component, name }) =>
                `Mount.make(Component.make(${quote(component)}, { client }), { name: ${quote(name)} })`,
            ),
            ", ",
          )}] });`,
          "",
        ],
        "\n",
      ),
    );
    const modules = path.join(project.root, "node_modules");
    for (const [file, content] of Rec.toEntries(fixture.files)) {
      const source = Predicate.isString(content)
        ? content
        : yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
            content,
          );
      yield* fs.makeDirectory(path.dirname(path.join(modules, file)), {
        recursive: true,
      });
      yield* fs.writeFileString(path.join(modules, file), source);
    }
    for (const [link, target] of Rec.toEntries(fixture.links ?? {})) {
      yield* fs.symlink(path.join(modules, target), path.join(modules, link));
    }
    const run = codegenHandler.pipe(
      Effect.provideService(ProjectRoot, { get: Effect.succeed(project.root) }),
      Effect.provideService(ConfectDirectory, {
        get: Effect.succeed(path.join(project.root, "confect")),
      }),
      Effect.provideService(ConvexDirectory, {
        get: Effect.succeed(path.join(project.root, "convex")),
      }),
    );
    return { ...project, run };
  });

type Registry = {
  readonly default: TestConfect.Registry<DatabaseSchema.AnyWithProps>;
};

const decoder = new TextDecoder();

/**
 * What codegen's registry for the project at `root` records, in a deploy's
 * terms: the app's modules, and each packaged mount's definition, directory and
 * the modules the test kernel registers from the files the registry reads, by
 * `@confect/core`'s one rule.
 */
const recordedOf = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { default: registry } = yield* Effect.promise(
      () =>
        import(
          /* @vite-ignore */ `${root}/confect/_generated/testing.ts`
        ) as Promise<Registry>,
    );
    const mounts: Record<string, typeof Mount.Type> = {};
    for (const [name, read] of Rec.toEntries(registry.packagedSources ?? {})) {
      const found = yield* Effect.promise(read);
      const last = found.steps.at(-1);
      expect(last?.found, `the reader finds ${name}'s package`).toBeDefined();
      const definition = yield* fs.realPath(
        path.join(last?.found ?? "", last?.file ?? ""),
      );
      mounts[name] = {
        directory: path.dirname(definition),
        definition,
        modules: Array.sort(
          Array.map(
            Array.filter(
              found.files,
              ({ file, bytes }) =>
                bytes !== undefined &&
                DeployedModule.admits(file, decoder.decode(bytes)),
            ),
            ({ file }) => file,
          ),
          Order.String,
        ),
      };
    }
    for (const name of Rec.keys(registry.components)) {
      expect(mounts[name], `${name} is a packaged mount`).toBeDefined();
    }
    return {
      deploys: true as const,
      app: Array.sort(
        Array.filter(
          Rec.keys(registry.modules),
          (file) => file !== "_generated/testing.ts",
        ),
        Order.String,
      ),
      mounts,
    };
  });

layer(NodeServices.layer)("the deploy differential", (it) => {
  it("covers every resolver and walk case Confect has broken on", () => {
    expect(new Set(Array.flatMap(corpus, (fixture) => fixture.covers))).toEqual(
      new Set(cases),
    );
  });

  it.effect.each(
    Array.filter(
      corpus,
      (fixture) =>
        process.platform !== "win32" || Rec.isEmptyRecord(fixture.links ?? {}),
    ),
  )(
    "records what convex deploy deploys: $name",
    (fixture) =>
      Effect.gen(function* () {
        const project = yield* projectOf(fixture);
        const generated = yield* Effect.exit(project.run);
        if (Exit.isFailure(generated)) {
          // Codegen refused, so the deploy reads the config codegen would
          // have written.
          yield* project.write(
            "convex/convex.config.ts",
            convexConfig(fixture),
          );
        }
        const deployed = yield* deployOf(project.root);
        expect(
          deployed.deploys,
          deployed.deploys ? "convex deploys it" : deployed.reason,
        ).toBe(fixture.deploys);
        if (!deployed.deploys) {
          expect(Exit.isFailure(generated), "codegen refuses it too").toBe(
            true,
          );
          return;
        }
        expect(
          Exit.isSuccess(generated),
          `codegen generates it: ${Exit.isFailure(generated) ? String(generated.cause) : ""}`,
        ).toBe(true);
        const recorded = yield* recordedOf(project.root);
        expect(recorded).toEqual(deployed);
      }).pipe(Effect.scoped),
    { timeout: 120_000 },
  );
});
