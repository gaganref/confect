import { codegenHandler } from "@confect/cli/confect/codegen";
import * as Bundler from "@confect/cli/Bundler";
import {
  InvalidManifestSectionError,
  UndeclaredCallbackSlotError,
} from "@confect/cli/CodegenError";
import * as DirectoryOptions from "@confect/cli/DirectoryOptions";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
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

/**
 * The integration project as the `mailer` component, whose `hooks` table holds
 * a handle for its declared `mailer/onEvent` contract.
 */
const componentProject = Effect.gen(function* () {
  const project = yield* Project.make;
  yield* project.write(
    "package.json",
    '{"name":"@confect-fixtures/mailer","type":"module"}',
  );
  yield* project.write("confect/app.ts", app());
  yield* project.write("confect/callbacks.ts", callbacks);
  yield* project.write("confect/tables/hooks.ts", hooks);
  const run = codegenHandler.pipe(
    Effect.provide(
      DirectoryOptions.layer({
        componentDir: Option.some(`${project.root}/convex`),
      }),
    ),
  );
  const fs = yield* FileSystem.FileSystem;
  const read = (file: string) => fs.readFileString(`${project.root}/${file}`);
  return { ...project, run, read };
});

const subjectOf = (project: { readonly root: string }) =>
  Bundler.bundle(`${project.root}/confect/_generated/testing.ts`).pipe(
    Effect.map(({ module }) => module["TestBackend"]),
  );

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
        expect(testing).not.toContain("groups");
        const subject = yield* subjectOf(project);
        expect(subject.kind).toBe("component");
        expect(Object.keys(subject.functions)).toEqual(["notes:list"]);
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
        expect(yield* Project.writtenFiles(project.run)).toEqual([]);
        expect(yield* project.read("confect/_generated/testing.ts")).toBe(
          testing,
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
          hooks
            .replace('import { OnEvent } from "../callbacks";\n', "")
            .replace(
              "export default",
              'const Inline = Callback.query("mailer/inline", { returns: () => Schema.Null });\nexport default',
            )
            .replace("Callback.handle(OnEvent)", "Callback.handle(Inline)"),
        );
        expect(yield* Effect.flip(project.run)).toEqual(
          new UndeclaredCallbackSlotError({
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
        expect(yield* Effect.flip(project.run)).toEqual(
          new InvalidManifestSectionError({
            sectionKey: "fixture",
            reason:
              "testing declares notes:list for a component, which owes no access proof; a component's section may declare laws and ports only.",
          }),
        );
      }).pipe(Effect.scoped),
    { timeout: 60000 },
  );
});
