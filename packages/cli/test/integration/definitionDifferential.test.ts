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
import { pipe } from "effect/Function";
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
import * as Cause from "effect/Cause";
import * as Layer from "effect/Layer";
import type { TestBackend, TestConfect } from "../../../test/src";
import {
  cases,
  corpus,
  type Fixture,
  type UnsupportedMount,
} from "./definitionDifferential/corpus";
import * as Project from "./Project";

/**
 * What Convex's definition bundling, or codegen's registry, holds for one
 * mount: its definition file and component directory, real paths, and its
 * modules below the directory. Codegen does not record a local mount's
 * definition, but every mount in the corpus is packaged.
 */
const Mount = Schema.Struct({
  directory: Schema.String,
  definition: Schema.String,
  modules: Schema.Array(Schema.String),
});

const Bundled = Schema.Union([
  Schema.Struct({
    bundles: Schema.Literal(true),
    app: Schema.Array(Schema.String),
    mounts: Schema.Record(Schema.String, Mount),
  }),
  Schema.Struct({ bundles: Schema.Literal(false), reason: Schema.String }),
]);

const BundledJson = Schema.fromJsonString(Bundled);

/**
 * The definition tree and module sets Convex's definition bundling gives for
 * the project at `root`, as `definitionDifferential/bundleDefinitions.mjs`
 * reads them from convex's own code.
 */
const bundledOf = (root: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(
        process.execPath,
        [
          path.join(
            import.meta.dirname,
            "definitionDifferential",
            "bundleDefinitions.mjs",
          ),
        ],
        { cwd: root, extendEnv: true, env: { NO_COLOR: "1" } },
      ),
    );
    const output = yield* handle.stdout.pipe(
      Stream.decodeText(),
      Stream.mkString,
    );
    return yield* Schema.decodeEffect(BundledJson)(Str.trim(output));
  }).pipe(Effect.scoped);

/**
 * The app's `convex/convex.config.ts` as codegen writes it for `mounts`, for
 * Convex to bundle a fixture codegen refused.
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
              ({ component, name, testing }) =>
                `Mount.make(Component.make(${quote(component)}, { client${testing === undefined ? "" : `, testing: ${quote(testing)}`} }), { name: ${quote(name)} })`,
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

type Generated = {
  readonly default: TestConfect.Registry<DatabaseSchema.AnyWithProps>;
  readonly TestBackend: TestBackend.GeneratedBackend<
    unknown,
    Record<string, TestBackend.AnyGroup>,
    Record<string, TestBackend.AnyPort>
  >;
};

const importGenerated = (root: string) =>
  Effect.promise(
    () =>
      import(
        /* @vite-ignore */ `${root}/confect/_generated/testing.ts`
      ) as Promise<Generated>,
  );

const decoder = new TextDecoder();

/**
 * What codegen's registry records, in the terms of Convex's definition
 * bundling: the app's modules, each packaged mount it reads with its
 * definition, directory and the modules the test kernel registers from the
 * files the registry reads, by `@confect/core`'s one rule, and each mount it
 * records as a layout it does not read.
 */
const recordedOf = (registry: Generated["default"]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const mounts: Record<string, typeof Mount.Type> = {};
    const unsupported: Record<string, UnsupportedMount> = {};
    for (const [name, entry] of Rec.toEntries(registry.packagedSources ?? {})) {
      if (!Predicate.isFunction(entry)) {
        unsupported[name] = { reason: entry.reason, package: entry.package };
        continue;
      }
      const found = yield* Effect.promise(entry);
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
      expect(
        mounts[name] ?? unsupported[name],
        `${name} is a packaged mount`,
      ).toBeDefined();
    }
    return {
      unsupported,
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

/**
 * `"opened"` when `subject` builds, else what it fails with, squashed.
 */
const openOf = <A, E>(subject: Layer.Layer<A, E>) =>
  Layer.build(subject).pipe(
    Effect.as("opened" as const),
    Effect.scoped,
    Effect.exit,
    Effect.map((exit) =>
      Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit.value,
    ),
  );

/**
 * Whether `mount` is `under` or below it.
 */
const within = (mount: string, under: string) =>
  mount === under || pipe(mount, Str.startsWith(`${under}/`));

layer(NodeServices.layer)(
  "the definition differential: the definition tree and module sets Convex's definition bundling gives, against codegen's registry",
  (it) => {
    it("covers every case the corpus must cover", () => {
      expect(
        new Set(Array.flatMap(corpus, (fixture) => fixture.covers)),
      ).toEqual(new Set(cases));
    });

    it.effect.each(
      Array.filter(
        corpus,
        (fixture) =>
          process.platform !== "win32" ||
          Rec.isEmptyRecord(fixture.links ?? {}),
      ),
    )(
      "records the definition tree and module sets Convex's definition bundling gives, or the layout it does not read: $name",
      (fixture) =>
        Effect.gen(function* () {
          const project = yield* projectOf(fixture);
          const generated = yield* Effect.exit(project.run);
          if (Exit.isFailure(generated)) {
            // Codegen refused, so Convex bundles the config codegen would
            // have written.
            yield* project.write(
              "convex/convex.config.ts",
              convexConfig(fixture),
            );
          }
          const bundled = yield* bundledOf(project.root);
          expect(
            bundled.bundles,
            bundled.bundles ? "convex bundles it" : bundled.reason,
          ).toBe(fixture.bundles);
          if (fixture.confect === "refuses") {
            expect(Exit.isFailure(generated), "codegen refuses it").toBe(true);
            return;
          }
          expect(
            Exit.isSuccess(generated),
            `codegen generates it: ${Exit.isFailure(generated) ? String(generated.cause) : ""}`,
          ).toBe(true);
          const testing = yield* importGenerated(project.root);
          const recorded = yield* recordedOf(testing.default);
          const expected =
            fixture.confect === "reads" ? {} : fixture.confect.unsupported;
          expect(recorded.unsupported).toEqual(expected);
          const unread = Rec.keys(expected);
          if (bundled.bundles)
            for (const mount of fixture.deploys ?? [])
              expect(Rec.keys(bundled.mounts), "convex deploys it").toContain(
                mount,
              );
          if (bundled.bundles) {
            // Every mount Convex bundles that Confect reads matches it.
            expect({ app: recorded.app, mounts: recorded.mounts }).toEqual({
              app: bundled.app,
              mounts: Rec.filter(
                bundled.mounts,
                (_, mount) =>
                  !Array.some(unread, (under) => within(mount, under)),
              ),
            });
          } else {
            // Where Convex gives no tree, Confect reads no layout of it.
            expect(unread.length).toBeGreaterThan(0);
          }
          const opened = yield* openOf(
            testing.TestBackend.layer({ config: {} }),
          );
          if (unread.length > 0) {
            // A layout codegen does not read refuses until the test declares
            // each unread mount's runtime, and then opens.
            expect(opened).toMatchObject({
              _tag: "PackagedLayoutUnsupported",
              mount: unread[0],
              reason: expected[unread[0] ?? ""]?.reason,
            });
            const declared = yield* openOf(
              testing.TestBackend.layer({
                config: {},
                componentRuntimes: Rec.map(expected, () => "isolate" as const),
              }),
            );
            expect(declared).toBe("opened");
          } else if (fixture.failsToOpen !== undefined) {
            expect(opened).toMatchObject({
              code: fixture.failsToOpen.code,
              message: expect.stringMatching(fixture.failsToOpen.message),
            });
          } else {
            expect(opened).toBe("opened");
          }
        }).pipe(Effect.scoped),
      { timeout: 120_000 },
    );
  },
);
