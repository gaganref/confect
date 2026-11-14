import { pathToFileURL } from "node:url";
import { codegenHandler } from "@confect/cli/confect/codegen";
import {
  InvalidDeclarationError,
  InvalidManifestSectionError,
  UndeclaredCallbackSlotError,
} from "@confect/cli/CodegenError";
import * as DirectoryOptions from "@confect/cli/DirectoryOptions";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import * as Project from "./integration/Project";

const app = (section = "") => `import { App, Env } from "@confect/core";
${section}export default App.make({
  kind: "component",
  env: Env.make("mailer", { REGION: Env.string() }),${section === "" ? "" : '\n  manifestSections: [{ key: "fixture", section }],'}
});
`;

const callbacks = `import { Callback } from "@confect/core";
import * as Schema from "effect/Schema";
class Bounced extends Schema.TaggedError<Bounced>()("Bounced", { reason: Schema.String }) {}
export const OnEvent = Callback.mutation("mailer/onEvent", {
  args: () => ({ message: Schema.String }),
  returns: () => Schema.Null,
  error: () => Bounced,
});
`;

const hooks = `import { Callback, Table } from "@confect/core";
import * as Schema from "effect/Schema";
import { OnEvent } from "../callbacks";
export default Table.make(() => Schema.Struct({ onEvent: Callback.handle(OnEvent) }));
`;

const installSpec = `import { Callback, FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
import { OnEvent } from "./callbacks";
export default GroupSpec.make().addFunction(FunctionSpec.internalMutation({ name: "init", args: () => ({ onEvent: Callback.handle(OnEvent) }), returns: () => Schema.Null }));
`;

const installImpl = `import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import databaseSchema from "./_generated/schema";
import install from "./install.spec";
const init = FunctionImpl.make(databaseSchema, install, "init", () => Effect.succeed(null));
export default GroupImpl.make(databaseSchema, install).pipe(Layer.provide(init), GroupImpl.finalize);
`;

const client = (init: string) => `import { Component } from "@confect/core";
import refs from "./confect/_generated/refs";
export default Component.make("mailer", { init: ${init}, client: (native: unknown) => native });
`;

/**
 * The integration project as the `mailer` component, whose `hooks` table holds
 * a handle for its declared `mailer/onEvent` contract, and whose descriptor,
 * its package's `./client` export, names `install:init` its init.
 */
const componentProject = Effect.gen(function* () {
  const project = yield* Project.make;
  yield* project.write(
    "package.json",
    '{"name":"@confect-fixtures/mailer","type":"module","exports":{"./client":"./client.ts"}}',
  );
  yield* project.write("confect/install.spec.ts", installSpec);
  yield* project.write("confect/install.impl.ts", installImpl);
  yield* project.write("client.ts", client("refs.internal.install.init"));
  yield* project.write("confect/app.ts", app());
  yield* project.write("confect/callbacks.ts", callbacks);
  yield* project.write("confect/tables/hooks.ts", hooks);
  const fs = yield* FileSystem.FileSystem;
  const read = (file: string) => fs.readFileString(`${project.root}/${file}`);
  const remove = (file: string) => fs.remove(`${project.root}/${file}`);
  return { ...project, run: generateAt(project.root), read, remove };
});

/**
 * Run codegen for the component whose root is `root`.
 */
const generateAt = (root: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Layer.build(
        DirectoryOptions.layer({
          componentDir: Option.some(`${root}/convex`),
        }),
      );
      return yield* codegenHandler.pipe(Effect.provideContext(services));
    }),
  );

/**
 * The generated subject, imported as a consumer's test imports it, through
 * Vite, so `@confect/test` and its own dependencies resolve from its package.
 */
const subjectOf = (project: { readonly root: string }) =>
  Effect.promise(
    (): Promise<{ readonly TestBackend: any }> =>
      import(
        /* @vite-ignore */ pathToFileURL(
          `${project.root}/confect/_generated/testing.ts`,
        ).href
      ),
  ).pipe(Effect.map(({ TestBackend }) => TestBackend));

/**
 * A local component at `directory` under `project`, named `name`, whose
 * descriptor beside its `confect/` names `<group>:init` its init.
 */
const localComponent = (
  project: { readonly root: string },
  directory: string,
  name: string,
  group: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = `${project.root}/${directory}`;
    yield* fs.makeDirectory(`${root}/confect/tables`, { recursive: true });
    yield* fs.makeDirectory(`${root}/convex`, { recursive: true });
    const write = (file: string, contents: string) =>
      fs.writeFileString(`${root}/${file}`, contents);
    yield* write(
      "confect/app.ts",
      `import { App, Env } from "@confect/core";\nexport default App.make({ kind: "component", env: Env.make("${name}", {}) });\n`,
    );
    yield* write(
      `confect/${group}.spec.ts`,
      pipe(
        installSpec,
        Str.replace(/^import \{ OnEvent \}.*\n/m, ""),
        Str.replace("({ onEvent: Callback.handle(OnEvent) })", "({})"),
      ),
    );
    yield* write(
      `confect/${group}.impl.ts`,
      pipe(
        installImpl,
        Str.replaceAll("install.spec", `${group}.spec`),
        Str.replace("import install from", `import ${group} from`),
        Str.replaceAll("(databaseSchema, install", `(databaseSchema, ${group}`),
      ),
    );
    yield* write(
      "client.ts",
      pipe(
        client(`refs.internal.${group}.init`),
        Str.replace('"mailer"', `"${name}"`),
      ),
    );
    return root;
  });

layer(NodeServices.layer)("codegen's generated component subject", (it) => {
  it.effect(
    "holds the exported functions, slots, laws and the three kinds of proof, and regenerates without drift",
    () =>
      Effect.gen(function* () {
        const project = yield* componentProject;
        yield* project.run;
        const testing = yield* project.read("confect/_generated/testing.ts");
        expect(testing).toContain(
          'import { TestComponent as $TestComponent } from "@confect/test";',
        );
        expect(testing).toContain(
          '"mailer/onEvent": $TestComponent.slot($callbacks["OnEvent"]),',
        );
        expect(testing).toContain('import $descriptor from "../../client.js";');
        expect(testing).toContain("  init: $descriptor.init,");
        expect(testing).not.toContain("groups");
        const subject = yield* subjectOf(project);
        expect(subject.kind).toBe("component");
        expect(Rec.keys(subject.functions)).toEqual(["notes:list"]);
        expect(subject.functions["notes:list"]).toMatchObject({
          _tag: "Confect",
          convexFunctionName: "notes:list",
        });
        expect(subject.slots["mailer/onEvent"].outcomes).toEqual([
          "returned",
          "Bounced",
        ]);
        expect(subject.slots["mailer/onEvent"].contract.id).toBe(
          "mailer/onEvent",
        );
        expect(subject.init.convexFunctionName).toBe("install:init");
        expect(subject.obligations).toEqual([
          { kind: "export", ref: "notes:list" },
          { kind: "laws" },
          { kind: "callback", slot: "mailer/onEvent" },
        ]);
        expect(subject.laws).toEqual([
          { law: "decodes", table: "hooks" },
          { law: "idScope", table: "hooks" },
          { law: "decodes", table: "notes" },
          { law: "idScope", table: "notes" },
        ]);
        expect(subject.settings).toEqual([
          { name: "REGION", owner: "mailer", optional: false },
        ]);
        expect(subject.ports).toEqual({});
        const rewritten = yield* Project.writtenFiles(project.run);
        expect(rewritten).toEqual([]);
        const again = yield* project.read("confect/_generated/testing.ts");
        expect(again).toBe(testing);
      }).pipe(Effect.scoped),
    { timeout: 60000 },
  );

  it.effect(
    "stops codegen at a descriptor whose init is no internal mutation",
    () =>
      Effect.gen(function* () {
        const project = yield* componentProject;
        yield* project.write("client.ts", client("refs.public.notes.list"));
        const refused = yield* Effect.flip(project.run);
        expect(refused).toEqual(
          InvalidDeclarationError.make({
            declarationPath: "client.ts",
            reason:
              "the component's descriptor names notes:list its init, which is no internal mutation of the component.",
          }),
        );
      }).pipe(Effect.scoped),
    { timeout: 60000 },
  );

  it.effect(
    "stops codegen at a slot whose contract callbacks.ts does not export",
    () =>
      Effect.gen(function* () {
        const project = yield* componentProject;
        yield* project.write(
          "confect/tables/hooks.ts",
          pipe(
            hooks,
            Str.replace('import { OnEvent } from "../callbacks";\n', ""),
            Str.replace(
              "export default",
              'const Inline = Callback.query("mailer/inline", { returns: () => Schema.Null });\nexport default',
            ),
            Str.replace("Callback.handle(OnEvent)", "Callback.handle(Inline)"),
          ),
        );
        const refused = yield* Effect.flip(project.run);
        expect(refused).toEqual(
          UndeclaredCallbackSlotError.make({
            declarationPath: "confect/callbacks.ts",
            contractId: "mailer/inline",
            heldBy: "the table hooks",
          }),
        );
      }).pipe(Effect.scoped),
    { timeout: 60000 },
  );

  it.effect(
    "refuses a section that gives a component an access proof",
    () =>
      Effect.gen(function* () {
        const project = yield* componentProject;
        yield* project.write(
          "confect/app.ts",
          app(`const section = {
  owner: "fixture-door",
  format: 1,
  describe: () => null,
  testing: () => ({ open: ["notes:list"], laws: [{ law: "unique", table: "notes", index: "by_text" }] }),
};
`),
        );
        const refused = yield* Effect.flip(project.run);
        expect(refused).toEqual(
          InvalidManifestSectionError.make({
            sectionKey: "fixture",
            reason:
              "testing declares notes:list for a component, which owes no access proof; a component's section may declare laws and ports only.",
          }),
        );
      }).pipe(Effect.scoped),
    { timeout: 60000 },
  );

  it.effect(
    "resolves a ./client export through nested conditions, as Node does",
    () =>
      Effect.gen(function* () {
        const project = yield* componentProject;
        yield* project.write(
          "package.json",
          '{"name":"@confect-fixtures/mailer","type":"module","exports":{"./client":{"import":{"default":"./src/descriptor.ts"}}}}',
        );
        yield* project.remove("client.ts");
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${project.root}/src`);
        yield* project.write(
          "src/descriptor.ts",
          pipe(
            client("refs.internal.install.init"),
            Str.replace(
              "./confect/_generated/refs",
              "../confect/_generated/refs",
            ),
          ),
        );
        yield* project.run;
        const testing = yield* project.read("confect/_generated/testing.ts");
        expect(testing).toContain(
          'import $descriptor from "../../src/descriptor.js";',
        );
        const subject = yield* subjectOf(project);
        expect(subject.init.convexFunctionName).toBe("install:init");
      }).pipe(Effect.scoped),
    { timeout: 60000 },
  );

  it.effect(
    "resolves a ./client export given as an array, taking its first target that resolves",
    () =>
      Effect.gen(function* () {
        const project = yield* componentProject;
        yield* project.write(
          "package.json",
          '{"name":"@confect-fixtures/mailer","type":"module","exports":{"./client":[{"worker":"./worker.ts"},"./client.ts"]}}',
        );
        yield* project.run;
        const subject = yield* subjectOf(project);
        expect(subject.init.convexFunctionName).toBe("install:init");
      }).pipe(Effect.scoped),
    { timeout: 60000 },
  );

  it.effect(
    "takes no init for a component that leaves its descriptor to its host",
    () =>
      Effect.gen(function* () {
        const project = yield* componentProject;
        yield* project.write(
          "package.json",
          '{"name":"@confect-fixtures/mailer","type":"module"}',
        );
        yield* project.remove("client.ts");
        yield* project.run;
        const testing = yield* project.read("confect/_generated/testing.ts");
        expect(testing).not.toContain("$descriptor");
        expect(testing).toContain("  init: undefined,");
      }).pipe(Effect.scoped),
    { timeout: 60000 },
  );

  it.effect(
    "stops codegen for a client.ts that default-exports no descriptor",
    () =>
      Effect.gen(function* () {
        const project = yield* componentProject;
        yield* project.write(
          "package.json",
          '{"name":"@confect-fixtures/mailer","type":"module"}',
        );
        yield* project.write("client.ts", "export default 1;\n");
        const refused = yield* Effect.flip(project.run);
        expect(refused).toEqual(
          InvalidDeclarationError.make({
            declarationPath: "client.ts",
            reason:
              "it holds the component's descriptor, so it default-exports what `Component.make` returns.",
          }),
        );
      }).pipe(Effect.scoped),
    { timeout: 60000 },
  );

  it.effect(
    "stops codegen for a ./client export that does not resolve",
    () =>
      Effect.gen(function* () {
        const project = yield* componentProject;
        yield* project.write(
          "package.json",
          '{"name":"@confect-fixtures/mailer","type":"module","exports":{"./client":{"import":"./missing.ts"}}}',
        );
        const refused = yield* Effect.flip(project.run);
        expect(refused).toEqual(
          InvalidDeclarationError.make({
            declarationPath: "package.json",
            reason:
              'its "./client" export names the component\'s descriptor, but @confect-fixtures/mailer/client does not resolve from it.',
          }),
        );
      }).pipe(Effect.scoped),
    { timeout: 60000 },
  );

  it.effect(
    "reads each nested component's own descriptor, never its parent's, at every depth",
    () =>
      Effect.gen(function* () {
        const project = yield* componentProject;
        const child = yield* localComponent(
          project,
          "components/child",
          "child",
          "setup",
        );
        const grandchild = yield* localComponent(
          project,
          "components/child/components/grandchild",
          "grandchild",
          "prepare",
        );
        yield* project.run;
        yield* generateAt(child);
        yield* generateAt(grandchild);
        const parent = yield* subjectOf(project);
        expect(parent.init.convexFunctionName).toBe("install:init");
        const own = yield* subjectOf({ root: child });
        expect(own.init.convexFunctionName).toBe("setup:init");
        const deepest = yield* subjectOf({ root: grandchild });
        expect(deepest.init.convexFunctionName).toBe("prepare:init");
      }).pipe(Effect.scoped),
    { timeout: 120000 },
  );
});
