import { assert, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as PlatformError from "effect/PlatformError";
import * as Console from "effect/Console";
import {
  codegenHandler,
  makeCodegenHandler,
} from "@confect/cli/confect/codegen";
import { IdScope } from "@confect/core";
import { ConvexDirectory } from "@confect/cli/ConvexDirectory";
import { renderCodegenError } from "@confect/cli/CodegenError";
import * as DirectoryOptions from "@confect/cli/DirectoryOptions";
import * as Project from "./integration/Project";

const fixture = `${import.meta.dirname}/fixtures/authored-component`;
const stringLiteral = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const freshFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Keep package resolution inside the workspace, but isolate all generated writes.
  const directory = yield* fs.makeTempDirectoryScoped({
    directory: path.dirname(fixture),
  });
  yield* fs.copy(fixture, directory, { overwrite: true });
  yield* fs.remove(path.join(directory, "confect", "_generated"), {
    recursive: true,
  });
  return directory;
});

it.effect(
  "generates a component contract and scoped services from a clean source tree",
  () =>
    Effect.gen(function* () {
      const directory = yield* freshFixture;
      const fs = yield* FileSystem.FileSystem;
      const dirs = DirectoryOptions.layer({
        componentDir: Option.some(`${directory}/convex`),
      });
      expect(
        yield* Project.writtenFiles(codegenHandler.pipe(Effect.provide(dirs))),
      ).not.toEqual([]);
      const id = yield* fs.readFileString(
        `${directory}/confect/_generated/id.ts`,
      );
      expect(id).toContain(
        'scope = IdScope.component("@confect-fixtures/counter:convex")',
      );
      const services = yield* fs.readFileString(
        `${directory}/confect/_generated/services.ts`,
      );
      expect(services).not.toContain("Auth");
      expect(services).not.toContain("export const Storage =");
      expect(services).toContain(
        "StorageReader_.StorageReader.forScope<typeof scope>()",
      );
      expect(services).toContain(
        "StorageWriter_.StorageWriter.forScope<typeof scope>()",
      );
      expect(services).toContain(
        "StorageActionWriter_.StorageActionWriter.forScope<typeof scope>()",
      );
      expect(services).toContain("Scheduler_.forScope<typeof scope>()");
      expect(services).toContain("MutationCtx_.MutationCtx<");
      const contract = yield* fs.readFileString(
        `${directory}/confect/_generated/component.ts`,
      );
      expect(contract).toContain("Component.make(spec, scope,");
      expect(contract).not.toContain("impl");
      expect(
        yield* Project.writtenFiles(codegenHandler.pipe(Effect.provide(dirs))),
      ).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "keeps a table named target distinct from the component execution target",
  () =>
    Effect.gen(function* () {
      const directory = yield* freshFixture;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        `${directory}/confect/tables/target.ts`,
        `import { Table } from "@confect/core";
import * as Schema from "effect/Schema";
export default Table.make(() => Schema.Struct({ name: Schema.String }));
`,
      );
      const dirs = DirectoryOptions.layer({
        componentDir: Option.some(`${directory}/convex`),
      });
      yield* codegenHandler.pipe(Effect.provide(dirs));
      const schema = yield* fs.readFileString(
        `${directory}/confect/_generated/schema.ts`,
      );
      expect(schema).toContain('import target from "./tables/target";');
      expect(schema).toContain('import { target as $target } from "./id";');
      expect(schema).toContain("typeof $target");
      expect(schema).toContain("}, $target)");
      expect(
        yield* Project.writtenFiles(codegenHandler.pipe(Effect.provide(dirs))),
      ).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "generates the component registry before loading tables with child IDs",
  () =>
    Effect.gen(function* () {
      const directory = yield* freshFixture;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        `${directory}/convex/convex.config.ts`,
        `import { defineComponent } from "convex/server";
import counter from ${stringLiteral(`${fixture}/convex/convex.config`)};
const parent = defineComponent("parent");
parent.use(counter, { name: "child" });
export default parent;
`,
      );
      yield* fs.writeFileString(
        `${directory}/confect/tables/foreign.ts`,
        `import { Component, Table } from "@confect/core";
import * as Schema from "effect/Schema";
import counter from ${stringLiteral(`${fixture}/confect/_generated/component`)};
import { components } from "../_generated/components";
import { scope } from "../_generated/id";
const child = Component.bind(counter, components.child, { parentScope: scope });
export default Table.make(() => Schema.Struct({ id: Component.id(child, "counters") }));
`,
      );
      const dirs = DirectoryOptions.layer({
        componentDir: Option.some(`${directory}/convex`),
      });
      yield* codegenHandler.pipe(Effect.provide(dirs));
      expect(
        yield* fs.readFileString(
          `${directory}/confect/_generated/components.ts`,
        ),
      ).toContain('ComponentApi<"child">');
      expect(
        yield* Project.writtenFiles(codegenHandler.pipe(Effect.provide(dirs))),
      ).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "rejects application authentication configuration for a component",
  () =>
    Effect.gen(function* () {
      const directory = yield* freshFixture;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        `${directory}/confect/auth.ts`,
        "export default { providers: [] };\n",
      );
      const result = yield* Effect.result(
        codegenHandler.pipe(
          Effect.provide(
            DirectoryOptions.layer({
              componentDir: Option.some(`${directory}/convex`),
            }),
          ),
        ),
      );
      assert(Result.isFailure(result));
      expect(result.failure).toMatchObject({
        _tag: "InvalidConvexConfigError",
        reason: expect.stringContaining("authentication"),
      });
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "generates a declared component's definition from a clean checkout",
  () =>
    Effect.gen(function* () {
      const directory = yield* freshFixture;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(`${directory}/convex/convex.config.ts`);
      yield* fs.writeFileString(
        `${directory}/confect/env.ts`,
        `import { Env } from "@confect/core";
export default Env.make("counter", { LIMIT: Env.optional(Env.string()) });
`,
      );
      yield* fs.writeFileString(
        `${directory}/confect/app.ts`,
        `import { App } from "@confect/core";
import env from "./env";
export default App.make({ kind: "component", env });
`,
      );
      yield* codegenHandler.pipe(
        Effect.provide(
          DirectoryOptions.layer({
            componentDir: Option.some(`${directory}/convex`),
          }),
        ),
      );
      expect(yield* fs.readFileString(`${directory}/convex/convex.config.ts`))
        .toBe(`// Generated by \`confect codegen\` from confect/app.ts. Do not edit.
import { defineComponent } from "convex/server";
import { v } from "convex/values";

const component = defineComponent("counter", {
  env: {
    LIMIT: v.optional(v.string()),
  },
});

export default component;
`);
      expect(
        yield* fs.exists(`${directory}/confect/_generated/manifest.ts`),
      ).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "rejects nested Node groups even when their spec imports bootstrap output",
  () =>
    Effect.gen(function* () {
      const project = yield* Project.makeNodeComponent;
      const fs = yield* FileSystem.FileSystem;
      yield* project.write(
        "confect/tasks.spec.ts",
        `import { GroupSpec } from "@confect/core";
import { scope } from "./_generated/id";
export const componentScope = scope;
export default GroupSpec.addGroupsAt(GroupSpec.make(), { worker: GroupSpec.makeNode() });
`,
      );
      const result = yield* Effect.result(
        codegenHandler.pipe(
          Effect.provide(
            DirectoryOptions.layer({
              componentDir: Option.some(`${project.root}/convex`),
            }),
          ),
        ),
      );
      assert(Result.isFailure(result));
      expect(result.failure).toMatchObject({
        _tag: "ComponentNodeGroupError",
        specPath: "tasks.spec.ts",
        groupPath: "tasks.worker",
      });
      expect(yield* fs.exists(`${project.root}/confect/_generated`)).toBe(
        false,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "pauses the watcher before rollback removes output and resumes after rejection",
  () =>
    Effect.gen(function* () {
      const project = yield* Project.makeNodeComponent;
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const generated = paths.join(project.root, "confect", "_generated");
      const lifecycle: string[] = [];
      let watching = true;
      const duringRestore = Effect.acquireRelease(
        Effect.sync(() => {
          watching = false;
          lifecycle.push("pause");
        }),
        () =>
          Effect.sync(() => {
            watching = true;
            lifecycle.push("resume");
          }),
      );
      const guardedFs = FileSystem.FileSystem.of({
        ...fs,
        remove: (path, options) =>
          Effect.suspend(() => {
            if (path === generated) {
              if (watching)
                return Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "remove",
                    pathOrDescriptor: path,
                  }),
                );
              lifecycle.push("remove");
            }
            return fs.remove(path, options);
          }),
      });
      const result = yield* makeCodegenHandler(duringRestore).pipe(
        Effect.provide(
          DirectoryOptions.layer({
            componentDir: Option.some(`${project.root}/convex`),
          }),
        ),
        Effect.provideService(FileSystem.FileSystem, guardedFs),
        Effect.result,
      );
      assert(Result.isFailure(result));
      expect(result.failure).toMatchObject({
        _tag: "ComponentNodeGroupError",
        groupPath: "tasks",
      });
      expect(lifecycle).toEqual(["pause", "remove", "resume"]);
      expect(watching).toBe(true);
      expect(yield* fs.exists(generated)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reports the rejected group when rollback itself fails", () =>
  Effect.gen(function* () {
    const project = yield* Project.makeNodeComponent;
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const generated = paths.join(project.root, "confect", "_generated");
    const denied = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "remove",
      pathOrDescriptor: generated,
    });
    const messages: unknown[] = [];
    const console = yield* Console.Console;
    const result = yield* codegenHandler.pipe(
      Effect.provide(
        DirectoryOptions.layer({
          componentDir: Option.some(`${project.root}/convex`),
        }),
      ),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        remove: (path, options) =>
          path === generated ? Effect.fail(denied) : fs.remove(path, options),
      }),
      Effect.provideService(
        Console.Console,
        new Proxy(console, {
          get: (target, key, receiver) =>
            key === "error"
              ? (...args: readonly unknown[]) => {
                  messages.push(...args);
                }
              : Reflect.get(target, key, receiver),
        }),
      ),
      Effect.result,
    );
    expect(result).toEqual(Result.fail(denied));
    expect(messages.join("\n")).toContain(
      'Group "tasks" in tasks.spec.ts uses the Node runtime. Convex components do not support Node.js functions.',
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["configured", "declared"] as const)(
  "preserves existing output when a %s component gains a Node group",
  (configuration) =>
    Effect.gen(function* () {
      const project = yield* Project.makeNodeComponent;
      const fs = yield* FileSystem.FileSystem;
      const nodeSpec = yield* fs.readFileString(
        `${project.root}/confect/tasks.spec.ts`,
      );
      if (configuration === "declared") {
        yield* fs.remove(`${project.root}/convex/convex.config.ts`);
        yield* project.write(
          "confect/env.ts",
          'import { Env } from "@confect/core";\nexport default Env.make("nodeComponent", {});\n',
        );
        yield* project.write(
          "confect/app.ts",
          'import { App } from "@confect/core";\nimport env from "./env";\nexport default App.make({ kind: "component", env });\n',
        );
      }
      yield* project.write(
        "confect/tasks.spec.ts",
        nodeSpec
          .replace("makeNode()", "make()")
          .replace("publicNodeAction", "publicAction"),
      );
      const run = codegenHandler.pipe(
        Effect.provide(
          DirectoryOptions.layer({
            componentDir: Option.some(`${project.root}/convex`),
          }),
        ),
      );
      yield* run;
      const configPath = `${project.root}/convex/convex.config.ts`;
      const configBefore = yield* fs.readFileString(configPath);
      const configModifiedAt = (yield* fs.stat(configPath)).mtime;
      const generatedDirectory = `${project.root}/confect/_generated`;
      const readGenerated = Effect.gen(function* () {
        const files = (yield* fs.readDirectory(generatedDirectory, {
          recursive: true,
        }))
          .filter((file) => file.endsWith(".ts"))
          .sort();
        return yield* Effect.forEach(files, (file) =>
          fs
            .readFileString(`${generatedDirectory}/${file}`)
            .pipe(Effect.map((contents) => [file, contents])),
        );
      });
      const before = yield* readGenerated;
      yield* fs.makeDirectory(`${project.root}/confect/tables`);
      yield* project.write(
        "confect/tables/notes.ts",
        'import { Table } from "@confect/core";\nimport * as Schema from "effect/Schema";\nexport default Table.make(() => Schema.Struct({ text: Schema.String }));\n',
      );
      yield* project.write("confect/tasks.spec.ts", nodeSpec);
      if (configuration === "declared") {
        yield* project.write(
          "confect/env.ts",
          'import { Env } from "@confect/core";\nexport default Env.make("nodeComponent", { TOKEN: Env.string() });\n',
        );
      }
      const result = yield* Effect.result(run);
      assert(Result.isFailure(result));
      expect(result.failure).toMatchObject({
        _tag: "ComponentNodeGroupError",
        groupPath: "tasks",
      });
      expect(yield* readGenerated).toEqual(before);
      expect(yield* fs.readFileString(configPath)).toBe(configBefore);
      if (configuration === "configured") {
        expect((yield* fs.stat(configPath)).mtime).toEqual(configModifiedAt);
      }
      expect(
        yield* fs.exists(`${project.root}/confect/_generated/tables/notes.ts`),
      ).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { declaredKind: "app", targetKind: "component" },
  { declaredKind: "component", targetKind: "app" },
] as const)(
  "rejects a $declaredKind declaration in a $targetKind target",
  ({ declaredKind, targetKind }) =>
    Effect.gen(function* () {
      const project = yield* Project.make;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.copyFile(
        `${import.meta.dirname}/fixtures/declaration-checks/${declaredKind}.ts`,
        `${project.root}/confect/app.ts`,
      );
      const result = yield* project.provide(
        codegenHandler.pipe(
          Effect.provideService(ConvexDirectory, {
            get: Effect.succeed(`${project.root}/convex`),
            target:
              targetKind === "app"
                ? { kind: "app", scope: IdScope.app }
                : {
                    kind: "component",
                    scope: IdScope.component("package:convex"),
                  },
          }),
          Effect.result,
        ),
      );
      assert(Result.isFailure(result));
      expect(result.failure).toMatchObject({
        _tag: "DeclarationKindMismatchError",
        declarationPath: "confect/app.ts",
        declaredKind,
        targetKind,
      });
      if (result.failure._tag === "DeclarationKindMismatchError") {
        expect(renderCodegenError(result.failure)).toContain(
          `declares kind "${declaredKind}", but the target directory is kind "${targetKind}".`,
        );
      }
      expect(yield* fs.exists(`${project.root}/convex/convex.config.ts`)).toBe(
        false,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["configured", "declared"] as const)(
  "checks exported callback prefixes against the %s component's definition name",
  (configuration) =>
    Effect.gen(function* () {
      const directory = yield* freshFixture;
      const fs = yield* FileSystem.FileSystem;
      if (configuration === "declared") {
        yield* fs.remove(`${directory}/convex/convex.config.ts`);
        yield* fs.copyFile(
          `${import.meta.dirname}/fixtures/declaration-checks/component.ts`,
          `${directory}/confect/app.ts`,
        );
      }
      const run = codegenHandler.pipe(
        Effect.provide(
          DirectoryOptions.layer({
            componentDir: Option.some(`${directory}/convex`),
          }),
        ),
      );
      yield* fs.copyFile(
        `${import.meta.dirname}/fixtures/declaration-checks/validCallbacks.ts`,
        `${directory}/confect/callbacks.ts`,
      );
      yield* run;
      if (configuration === "declared") {
        expect(
          yield* fs.readFileString(`${directory}/convex/convex.config.ts`),
        ).toContain('defineComponent("counter")');
      }
      yield* fs.copyFile(
        `${import.meta.dirname}/fixtures/declaration-checks/callbacks.ts`,
        `${directory}/confect/callbacks.ts`,
      );
      const result = yield* Effect.result(run);
      assert(Result.isFailure(result));
      expect(result.failure).toMatchObject({
        _tag: "CallbackPrefixError",
        declarationPath: "confect/callbacks.ts",
        contractId: "counterfeit/onWrong",
        componentName: "counter",
      });
      if (result.failure._tag === "CallbackPrefixError") {
        expect(renderCodegenError(result.failure)).toContain(
          'must start with "counter/" for component "counter".',
        );
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("leaves host callback exports unchecked", () =>
  Effect.gen(function* () {
    const project = yield* Project.make;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.copyFile(
      `${import.meta.dirname}/fixtures/declaration-checks/callbacks.ts`,
      `${project.root}/confect/callbacks.ts`,
    );
    yield* project.provide(codegenHandler);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
