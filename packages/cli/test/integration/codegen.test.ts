import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
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
  it.effect.each([
    {
      name: "raw export",
      file: "raw.ts",
      source:
        'import { queryGeneric } from "convex/server";\nexport const raw = queryGeneric({ handler: () => null });\n',
    },
    {
      name: "alias",
      file: "alias.js",
      source:
        'import { queryGeneric as query } from "convex/server";\nconst hidden = query({ handler: () => null });\nexport { hidden as raw };\n',
    },
    {
      name: "re-export",
      file: "nested/reexport.ts",
      source: 'export { raw } from "../../raw";\n',
    },
    {
      name: "re-added file",
      file: "notes.ts",
      source:
        'import { queryGeneric } from "convex/server";\nexport const raw = queryGeneric({ handler: () => null });\n',
    },
    {
      name: "appended export",
      file: "notes.ts",
      source: "\nexport { list as unchecked };\n",
    },
    {
      name: "hand-written helper without evaluating it",
      file: "helper.ts",
      source:
        'throw new Error("must not evaluate");\nexport const helper = 1;\n',
    },
    ...["http.ts", "crons.ts"].map((file) => ({
      name: "hand-written optional entrypoint",
      file,
      source: "export default {};\n",
    })),
  ])(
    "refuses $name in convex/$file",
    ({ name, file, source }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const project = yield* Project.make;
        const initial = yield* project.start("codegen");
        yield* initial.waitFor("Generated files are up-to-date");
        expect(yield* initial.handle.exitCode).toBe(0);
        if (name === "re-added file") {
          yield* fs.remove(`${project.root}/confect/notes.spec.ts`);
          yield* fs.remove(`${project.root}/confect/notes.impl.ts`);
          const removed = yield* project.start("codegen");
          yield* removed.waitFor("Generated files are up-to-date");
          expect(yield* removed.handle.exitCode).toBe(0);
          expect(yield* fs.exists(`${project.root}/convex/notes.ts`)).toBe(
            false,
          );
        }
        if (name === "re-export") {
          yield* project.write(
            "raw.ts",
            'import { queryGeneric } from "convex/server";\nexport const raw = queryGeneric({ handler: () => null });\n',
          );
        }
        const previous =
          name === "appended export"
            ? yield* fs.readFileString(`${project.root}/convex/${file}`)
            : "";
        yield* fs.makeDirectory(
          path.dirname(path.join(project.root, "convex", file)),
          { recursive: true },
        );
        yield* project.write(`convex/${file}`, previous + source);
        const generated = yield* project.start("codegen");
        const exitCode = yield* generated.handle.exitCode;
        const output = stripVTControlCharacters(
          yield* Ref.get(generated.output),
        );
        expect(exitCode, output).not.toBe(0);
        expect(output).toContain(`convex/${file}`);
        expect(output).toContain("not written by confect codegen");
        expect(yield* fs.readFileString(`${project.root}/convex/${file}`)).toBe(
          previous + source,
        );
      }).pipe(Effect.scoped),
    { timeout: 30000 },
  );

  it.effect(
    "reports all five refusal cases without changing their files",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const project = yield* Project.make;
        const initial = yield* project.start("codegen");
        yield* initial.waitFor("Generated files are up-to-date");
        expect(yield* initial.handle.exitCode).toBe(0);
        yield* project.write("confect/removed.spec.ts", Project.spec);
        yield* project.write(
          "confect/removed.impl.ts",
          Project.impl.replace('"./notes.spec"', '"./removed.spec"'),
        );
        const added = yield* project.start("codegen");
        yield* added.waitFor("Generated files are up-to-date");
        expect(yield* added.handle.exitCode).toBe(0);
        yield* fs.remove(path.join(project.root, "confect/removed.spec.ts"));
        yield* fs.remove(path.join(project.root, "confect/removed.impl.ts"));
        const removed = yield* project.start("codegen");
        yield* removed.waitFor("Generated files are up-to-date");
        expect(yield* removed.handle.exitCode).toBe(0);
        const files = {
          "raw.ts":
            'import { queryGeneric } from "convex/server"; export const raw = queryGeneric({ handler: () => null });',
          "alias.js":
            'import { queryGeneric as query } from "convex/server"; const hidden = query({ handler: () => null }); export { hidden as raw };',
          "nested/reexport.ts": 'export { raw } from "../raw";',
          "removed.ts": "export const raw = 1;",
          "notes.ts":
            (yield* fs.readFileString(
              path.join(project.root, "convex/notes.ts"),
            )) + "\nexport { list as unchecked };",
        };
        for (const [file, source] of Object.entries(files)) {
          yield* fs.makeDirectory(
            path.dirname(path.join(project.root, "convex", file)),
            { recursive: true },
          );
          yield* project.write(`convex/${file}`, source);
        }
        const generated = yield* project.start("codegen");
        const exitCode = yield* generated.handle.exitCode;
        const output = stripVTControlCharacters(
          yield* Ref.get(generated.output),
        );
        expect(exitCode, output).not.toBe(0);
        for (const [file, source] of Object.entries(files)) {
          expect(output).toContain(`convex/${file}`);
          expect(
            yield* fs.readFileString(path.join(project.root, "convex", file)),
          ).toBe(source);
        }
        expect(output.match(/not written by confect codegen/g)).toHaveLength(1);
      }).pipe(Effect.scoped),
    { timeout: 30000 },
  );

  it.effect(
    "accepts a generated tree on repeated codegen",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const project = yield* Project.make;
        yield* project.write(
          "confect/notes.spec.ts",
          Project.spec.replace('name: "list"', 'name: "$list"'),
        );
        yield* project.write(
          "confect/notes.impl.ts",
          Project.impl.replace('"list"', '"$list"'),
        );
        const initial = yield* project.start("codegen");
        yield* initial.waitFor("Generated files are up-to-date");
        expect(yield* initial.handle.exitCode).toBe(0);
        const expected = yield* project.generatedFiles;
        const repeated = yield* project.start("codegen");
        expect(
          yield* repeated.handle.exitCode,
          yield* Ref.get(repeated.output),
        ).toBe(0);
        expect(yield* project.generatedFiles).toEqual(expected);
        expect(expected[path.join("convex", "notes.ts")]).toContain(
          "export const $list = registeredFunctions.$list;",
        );
      }).pipe(Effect.scoped),
    { timeout: 30000 },
  );

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
