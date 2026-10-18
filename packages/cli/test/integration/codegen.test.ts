import { fileURLToPath } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Project from "./Project";

const stringLiteral = Schema.encodeSync(Schema.fromJsonString(Schema.String));

layer(NodeServices.layer)("built confect codegen", (it) => {
  it.effect(
    "rejects a component Node group without generated output but permits it in an application",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const project = yield* Project.makeNodeComponent;
        const component = yield* project.start("codegen", [
          "--component-dir",
          "convex",
        ]);
        yield* component.waitFor(
          'Group "tasks" in tasks.spec.ts uses the Node runtime. Convex components do not support Node.js functions.',
        );
        expect(yield* component.handle.exitCode).not.toBe(0);
        expect(yield* Ref.get(component.output)).not.toContain(
          "Generated files are up-to-date",
        );
        expect(yield* fs.exists(`${project.root}/confect/_generated`)).toBe(
          false,
        );
        expect(yield* fs.exists(`${project.root}/convex/tasks.ts`)).toBe(false);
        yield* project.write(
          "convex/convex.config.ts",
          'import { defineApp } from "convex/server";\nexport default defineApp();\n',
        );
        const app = yield* project.start("codegen");
        yield* app.waitFor("Generated files are up-to-date");
        expect(yield* app.handle.exitCode).toBe(0);
        expect(
          yield* fs.readFileString(`${project.root}/convex/tasks.ts`),
        ).toContain('"use node"');
      }).pipe(Effect.scoped),
    { timeout: 30000 },
  );

  it.effect(
    "typechecks 47 groups strictly for applications and authored components",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner;
        const directory = yield* fs.makeTempDirectoryScoped({
          directory: import.meta.dirname,
          prefix: "strict-",
        });
        const consumers: string[] = [];
        for (const kind of ["host", "component"] as const) {
          const project = yield* Project.make;
          yield* fs.remove(path.join(project.root, "confect/notes.spec.ts"));
          yield* fs.remove(path.join(project.root, "confect/notes.impl.ts"));
          if (kind === "component") {
            yield* project.write(
              "package.json",
              '{"name":"@confect-fixtures/depth","type":"module"}',
            );
            yield* project.write(
              "convex/convex.config.ts",
              'import { defineComponent } from "convex/server";\nexport default defineComponent("depth");\n',
            );
          }
          for (let index = 1; index <= 47; index++) {
            const name = `g${String(index).padStart(2, "0")}`;
            yield* project.write(
              `confect/${name}.spec.ts`,
              `import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
export default GroupSpec.make().addFunction(
  FunctionSpec.publicQuery({ name: "get", args: () => ({ value: Schema.Number }), returns: () => Schema.Number }),
);
`,
            );
            yield* project.write(
              `confect/${name}.impl.ts`,
              `import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import schema from "./_generated/schema";
import group from "./${name}.spec";
const get = FunctionImpl.make(schema, group, "get", ({ value }) => Effect.succeed(value + 1));
export default GroupImpl.make(schema, group).pipe(Layer.provide(get), GroupImpl.finalize);
`,
            );
          }
          const codegen = yield* project.start(
            "codegen",
            kind === "component" ? ["--component-dir", "convex"] : [],
          );
          yield* codegen.waitFor("Generated files are up-to-date");
          expect(yield* codegen.handle.exitCode).toBe(0);
          yield* project.write(
            "consumer.ts",
            `import { expectTypeOf } from "vitest";
import type { Ref } from "@confect/core";
import refs from "./confect/_generated/refs";
expectTypeOf<Ref.Returns<typeof refs.public.g01.get>>().toEqualTypeOf<number>();
expectTypeOf<Ref.Returns<typeof refs.public.g47.get>>().toEqualTypeOf<number>();
// @ts-expect-error The generated annotation must still reject unknown groups.
refs.public.g48;
`,
          );
          consumers.push(path.join(project.root, "consumer.ts"));
        }
        yield* fs.writeFileString(
          path.join(directory, "tsconfig.json"),
          `{
            "compilerOptions": {
              "strict": true,
              "exactOptionalPropertyTypes": true,
              "noEmit": true,
              "skipLibCheck": true,
              "module": "ESNext",
              "moduleResolution": "Bundler",
              "target": "ESNext",
              "verbatimModuleSyntax": true
            },
            "files": [${consumers.map((consumer) => stringLiteral(consumer)).join(",")}]
          }`,
        );
        const compiler = yield* spawner.spawn(
          ChildProcess.make(process.execPath, [
            fileURLToPath(
              new URL(
                "bin/tsc",
                import.meta.resolve("typescript/package.json"),
              ),
            ),
            "-p",
            directory,
          ]),
        );
        const output = yield* compiler.all.pipe(
          Stream.decodeText(),
          Stream.mkString,
        );
        expect(yield* compiler.exitCode, output).toBe(0);
      }).pipe(Effect.scoped),
    { timeout: 60000 },
  );
});
