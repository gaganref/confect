import { fileURLToPath } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Rec from "effect/Record";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import { codegenHandler } from "@confect/cli/confect/codegen";
import * as DirectoryOptions from "@confect/cli/DirectoryOptions";
import { stringify } from "@confect/cli/Json";
import { toPosixPath } from "@confect/cli/utils";
import * as Project from "./integration/Project";

const DECLARATIONS = "declarations";

const notesImpl = `import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import databaseSchema from "./_generated/schema";
import notes from "./notes.spec";
const list = FunctionImpl.make(databaseSchema, notes, "list", () => Effect.succeed([]));
export default GroupImpl.make(databaseSchema, notes).pipe(Layer.provide(list), GroupImpl.finalize);
`;

const hostApp = `import { App, Env } from "@confect/core";
export default App.make({ env: Env.make("host", {}) });
`;

const componentApp = `import { App, Env } from "@confect/core";
export default App.make({ kind: "component", env: Env.make("counter", {}) });
`;

const componentPackage = '{"name":"@confect-fixtures/counter","type":"module"}';

const mountedApp = `import { App, Component, Env, Mount } from "@confect/core";
import counter from "../components/counter/convex/convex.config";
const Counter = Component.make("counter", { client: (native: unknown) => native });
export default App.make({
  env: Env.make("host", {}),
  components: [counter],
  mounts: [Mount.make(Counter, { name: "first" })],
});
`;

const counterFiles = {
  "components/counter/convex/convex.config.ts": `import { defineComponent } from "convex/server";
export default defineComponent("counter");
`,
  "components/counter/convex/schema.ts": `import { defineSchema } from "convex/server";
export default defineSchema({});
`,
  // What `convex codegen` writes for a component's directory.
  "components/counter/convex/_generated/component.ts":
    "export type ComponentApi<Name extends string | undefined = string | undefined> = { readonly name: Name };\n",
};

const http = `import { Guard, Http } from "@confect/core";
export default Http.make({ guard: Guard.none });
`;

const echoSpec = `import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
export default GroupSpec.make().addFunction(
  FunctionSpec.httpAction({ name: "say", method: "POST", path: "/echo", args: () => ({ text: Schema.String }), returns: () => Schema.String }),
);
`;

const echoImpl = `import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import databaseSchema from "./_generated/schema";
import echo from "./echo.spec";
const say = FunctionImpl.make(databaseSchema, echo, "say", () => Effect.succeed("said"));
export default GroupImpl.make(databaseSchema, echo).pipe(Layer.provide(say), GroupImpl.finalize);
`;

interface Scenario {
  readonly name: string;
  readonly kit: boolean;
  readonly component: boolean;
  readonly files: Readonly<Record<string, string>>;
}

const scenarios: ReadonlyArray<Scenario> = [
  {
    name: "an app",
    kit: true,
    component: false,
    files: { "confect/app.ts": hostApp },
  },
  {
    name: "an app without the test kit",
    kit: false,
    component: false,
    files: { "confect/app.ts": hostApp },
  },
  {
    name: "a component",
    kit: true,
    component: true,
    files: {
      "confect/app.ts": componentApp,
      "package.json": componentPackage,
    },
  },
  {
    name: "a component without the test kit",
    kit: false,
    component: true,
    files: {
      "confect/app.ts": componentApp,
      "package.json": componentPackage,
    },
  },
  {
    name: "a backend with a mount",
    kit: true,
    component: false,
    files: { "confect/app.ts": mountedApp, ...counterFiles },
  },
  {
    name: "a backend with route specs",
    kit: true,
    component: false,
    files: {
      "confect/app.ts": hostApp,
      "confect/http.ts": http,
      "confect/echo.spec.ts": echoSpec,
      "confect/echo.impl.ts": echoImpl,
    },
  },
];

const generate = (
  project: Effect.Success<typeof Project.make>,
  component: boolean,
) =>
  component
    ? Effect.scoped(
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const services = yield* Layer.build(
            DirectoryOptions.layer({
              componentDir: Option.some(path.join(project.root, "convex")),
            }),
          );
          return yield* codegenHandler.pipe(Effect.provideContext(services));
        }),
      )
    : codegenHandler.pipe(project.provide);

/**
 * Install the way a consumer has it, one copy of each package. The harness's
 * default installs copy `@confect/core` and `@confect/server`, so a package
 * that imports `@confect/core` finds the workspace's copy beside the project's
 * and the compiler sees two. A consumer also lists `effect` and `convex` as its
 * own dependencies, which are the copies Confect's packages use.
 */
const installAsConsumer = Effect.fnUntraced(function* (
  root: string,
  packages: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspace = path.resolve(import.meta.dirname, "../..");
  for (const name of packages) {
    const installed = path.join(root, "node_modules", "@confect", name);
    yield* fs.remove(installed, { recursive: true, force: true });
    yield* fs.symlink(path.join(workspace, name), installed);
  }
  for (const name of ["effect", "convex"]) {
    const target = yield* fs.realPath(
      path.join(workspace, "core", "node_modules", name),
    );
    yield* fs.symlink(target, path.join(root, "node_modules", name));
  }
});

/**
 * Each failure `tsc` reports: the file, relative to the project in POSIX form,
 * and the diagnostic.
 */
const failuresIn = (root: string, output: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return pipe(
      [
        ...pipe(
          output,
          Str.matchAll(/^(.+)\((\d+),(\d+)\): error (TS\d+): (.*)$/gm),
        ),
      ],
      Arr.map(([, file = "", line, column, code, message]) => ({
        file: toPosixPath(path, path.relative(root, path.resolve(root, file))),
        at: `${line}:${column}`,
        code,
        message,
      })),
    );
  });

layer(NodeServices.layer)("generated declaration emit", (it) => {
  it.effect.each(scenarios)(
    "compiles what codegen generates for $name",
    ({ kit, component, files }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner;
        const project = yield* Project.make;
        const write = Effect.fnUntraced(function* (
          file: string,
          contents: string,
        ) {
          yield* fs.makeDirectory(path.dirname(path.join(project.root, file)), {
            recursive: true,
          });
          yield* project.write(file, contents);
        });
        yield* write("confect/notes.impl.ts", notesImpl);
        for (const [file, contents] of Rec.toEntries(files))
          yield* write(file, contents);
        yield* installAsConsumer(
          project.root,
          kit ? ["core", "server", "test"] : ["core", "server"],
        );
        if (!kit)
          // A package that exports nothing is one the backend cannot import.
          yield* write(
            "node_modules/@confect/test/package.json",
            '{ "name": "@confect/test", "exports": {} }',
          );
        yield* generate(project, component);
        const written = yield* project.generatedFiles;
        const generated = pipe(
          Rec.keys(written),
          Arr.map((file) => toPosixPath(path, file)),
        );
        expect(generated).toContain("confect/_generated/testing.ts");

        yield* project.write(
          "tsconfig.json",
          stringify({
            compilerOptions: {
              strict: true,
              exactOptionalPropertyTypes: true,
              skipLibCheck: true,
              module: "ESNext",
              moduleResolution: "Bundler",
              target: "ESNext",
              verbatimModuleSyntax: true,
              declaration: true,
              emitDeclarationOnly: true,
              rootDir: ".",
              outDir: DECLARATIONS,
            },
            include: ["confect", "convex"],
          }),
        );
        const compiler = yield* spawner.spawn(
          ChildProcess.make(
            process.execPath,
            [
              fileURLToPath(
                new URL(
                  "bin/tsc",
                  import.meta.resolve("typescript/package.json"),
                ),
              ),
              "-p",
              ".",
              "--pretty",
              "false",
            ],
            { cwd: project.root },
          ),
        );
        const output = yield* compiler.all.pipe(
          Stream.decodeText(),
          Stream.mkString,
        );
        yield* compiler.exitCode;

        const failures = yield* failuresIn(project.root, output);
        expect(failures, output).toEqual([]);
        const missing = yield* Effect.filter(generated, (file) =>
          Effect.map(
            fs.exists(
              path.join(
                project.root,
                DECLARATIONS,
                pipe(file, Str.replace(/\.ts$/, ".d.ts")),
              ),
            ),
            (exists) => !exists,
          ),
        );
        expect(missing).toEqual([]);
      }).pipe(Effect.scoped),
    { timeout: 120000 },
  );
});
