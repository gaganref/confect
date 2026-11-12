import { pipe } from "effect/Function";
import * as Rec from "effect/Record";
import { IdScope, Table } from "@confect/core";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { assert, expect, layer } from "@effect/vitest";
import { vi } from "vitest";
import * as esbuild from "esbuild";
import * as Bundler from "@confect/cli/Bundler";
import * as SectionFiles from "@confect/cli/SectionFiles";
import * as Console from "effect/Console";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as String from "effect/String";
import {
  codegenHandler,
  generateWithSnapshot,
  updateDeclarations,
} from "@confect/cli/confect/codegen";
import * as GenerationSnapshot from "@confect/cli/GenerationSnapshot";
import { SpecModulePath } from "@confect/cli/SpecModulePath";
import { TableModulePath } from "@confect/cli/TableModulePath";
import { ImplModulePath } from "@confect/cli/ImplModulePath";
import { ConfectDirectory } from "@confect/cli/ConfectDirectory";
import { ConvexDirectory } from "@confect/cli/ConvexDirectory";
import { ProjectRoot } from "@confect/cli/ProjectRoot";
import {
  discover as discoverTables,
  validate as validateTables,
} from "@confect/cli/TableModule";
import {
  HandWrittenConvexFileError,
  InvalidConvexConfigError,
  InvalidDeclarationError,
  isCodegenError,
  renderCodegenError,
} from "@confect/cli/CodegenError";
import * as Project from "./integration/Project";
import { DatabaseSchema } from "@confect/server";
import { TestConfect } from "../../test/src";
import { defineSchema } from "convex/server";

vi.mock("esbuild", (importOriginal) =>
  importOriginal<typeof esbuild>().then((original) => ({
    ...original,
    build: vi.fn(original.build),
  })),
);

const manifestProject = Effect.gen(function* () {
  const project = yield* Project.make;
  const declare = (sections: string) =>
    project.write(
      "confect/app.ts",
      `import { App, Env } from "@confect/core";
import { tags } from "./tags";
export default App.make({ env: Env.make("host", {}), manifestSections: [${sections}] });`,
    );
  yield* declare('{ key: "tags", section: tags }');
  yield* project.write(
    "confect/tags.ts",
    `export const tags = { owner: "test/tags", format: 1, describe: ({ spec }) => spec.description ?? null,
check: (next, previous) => {
if (next.functions["notes:list"] === "throw") throw new Error("check threw");
return { errors: next.functions["notes:list"] === "second" && previous === undefined ? ["missing previous tags"] : Object.values(next.functions).includes("bad") ? ["bad tags"] : [], notes: [] }; } };`,
  );
  const spec = (label: string) =>
    Project.spec.replace(
      'name: "list"',
      `name: "list", description: "${label}"`,
    );
  const read = Bundler.bundle(
    `${project.root}/confect/_generated/manifest.ts`,
  ).pipe(Effect.map(({ module }) => module.default));
  yield* project.write("confect/notes.spec.ts", spec("first"));
  return {
    ...project,
    sectionSpec: spec,
    manifest: read,
    declare,
    undeclare: declare(""),
  };
});

/**
 * A group with a profile-built query and a raw internal mutation, each
 * describing itself by name.
 */
const stockSpec = `import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
const profile = FunctionSpec.extend()({ middleware: [] });
export default GroupSpec.make()
  .addFunction(profile.publicQuery({ name: "profiled", description: "profiled", returns: () => Schema.Null }))
  .addFunction(FunctionSpec.internalMutation({ name: "raw", description: "raw", returns: () => Schema.Null }));
`;
const stockImpl = `import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import databaseSchema from "./_generated/schema";
import stock from "./stock.spec";
export default GroupImpl.make(databaseSchema, stock).pipe(
  Layer.provide(FunctionImpl.make(databaseSchema, stock, "profiled", () => Effect.succeed(null))),
  Layer.provide(FunctionImpl.make(databaseSchema, stock, "raw", () => Effect.succeed(null))),
  GroupImpl.finalize,
);
`;

layer(Layer.mergeAll(NodePath.layer, NodeFileSystem.layer))(
  "codegenHandler",
  (it) => {
    it.effect(
      "updates a section on incremental spec edits and drops it once App.make stops declaring it",
      () =>
        Effect.gen(function* () {
          const project = yield* manifestProject;
          const { snapshot } = yield* project.provide(generateWithSnapshot);
          const before = yield* project.manifest;
          expect(before.tags).toEqual({
            format: 1,
            functions: { "notes:list": "first" },
          });
          yield* project.provide(generateWithSnapshot);
          expect((yield* project.manifest).digest).toBe(before.digest);
          const path = yield* Path.Path;
          const manifest = path.join(
            project.root,
            "confect",
            "_generated",
            "manifest.ts",
          );
          const manifestWrites = (files: ReadonlyArray<string>) =>
            files.filter((file) => file === manifest);
          expect(
            manifestWrites(
              yield* Project.writtenFiles(
                project.provide(generateWithSnapshot),
              ),
            ),
          ).toEqual([]);
          yield* project.write(
            "confect/notes.spec.ts",
            project.sectionSpec("second"),
          );
          const changes = [
            {
              _tag: "Spec",
              relativePath: SpecModulePath.make("notes.spec.ts"),
            },
          ] as const;
          const writes = yield* Project.writtenFiles(
            project.provide(updateDeclarations(snapshot, changes, [])),
          );
          expect(manifestWrites(writes)).toEqual([manifest]);
          const after = yield* project.manifest;
          expect(after.tags).toEqual({
            format: 1,
            functions: { "notes:list": "second" },
          });
          expect(after.digest).not.toBe(before.digest);
          yield* project.undeclare;
          yield* project.provide(updateDeclarations(snapshot, changes, []));
          expect((yield* project.manifest).tags).toBeUndefined();
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect.each(
      [
        ["confect/notes.spec.ts", 'throw new Error("spec broke");'],
        ["confect/notes.impl.ts", "export default 1;"],
        ["confect/notes.spec.ts", "bad"],
        ["confect/notes.spec.ts", "throw"],
      ].flatMap(([file, contents]) =>
        [false, true].map((incremental) => ({
          file: file!,
          contents: contents!,
          incremental,
        })),
      ),
    )(
      "retains history only for unrelated failures in $file ($contents, incremental=$incremental)",
      ({ file, contents, incremental }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const project = yield* manifestProject;
          const sectionFailure = contents === "bad" || contents === "throw";
          if (!sectionFailure)
            yield* project.write("confect/notes.spec.ts", Project.spec);
          const { snapshot } = yield* project.provide(generateWithSnapshot);
          yield* project.write(
            file,
            sectionFailure ? project.sectionSpec(contents) : contents,
          );
          const run = incremental
            ? updateDeclarations(
                snapshot,
                [
                  {
                    _tag: "Spec",
                    relativePath: SpecModulePath.make("notes.spec.ts"),
                  },
                ],
                [],
              ).pipe(Effect.asVoid)
            : generateWithSnapshot.pipe(Effect.asVoid);
          const result = yield* Effect.result(project.provide(run));
          expect(result._tag).toBe("Failure");
          if (contents === "throw")
            expect(result).toMatchObject({
              failure: {
                _tag: "InvalidManifestSectionError",
                sectionKey: "tags",
                reason: "check failed: Error: check threw",
              },
            });
          expect(
            yield* fs.exists(`${project.root}/confect/_generated/manifest.ts`),
          ).toBe(!sectionFailure);
        }).pipe(Effect.scoped),
    );

    it.effect("updates the declaration name while preserving sections", () =>
      Effect.gen(function* () {
        const project = yield* manifestProject;
        yield* project.provide(generateWithSnapshot);
        yield* project.write(
          "confect/app.ts",
          `import { App, Env } from "@confect/core";
import { tags } from "./tags";
export default App.make({ env: Env.make("other", {}), manifestSections: [{ key: "tags", section: tags }] });`,
        );
        yield* project.provide(generateWithSnapshot);
        expect((yield* project.manifest).name).toBe("other");
        expect((yield* project.manifest).tags).toEqual({
          format: 1,
          functions: { "notes:list": "first" },
        });
      }).pipe(Effect.scoped),
    );

    it.effect(
      "describes every registered function into a declared section, whatever builder made it",
      () =>
        Effect.gen(function* () {
          const project = yield* manifestProject;
          yield* project.write("confect/stock.spec.ts", stockSpec);
          yield* project.write("confect/stock.impl.ts", stockImpl);
          yield* project.provide(generateWithSnapshot);
          expect((yield* project.manifest).tags).toEqual({
            format: 1,
            functions: {
              "notes:list": "first",
              "stock:profiled": "profiled",
              "stock:raw": "raw",
            },
          });
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "changes the digest with the declared sections and the functions they describe",
      () =>
        Effect.gen(function* () {
          const project = yield* manifestProject;
          const runDigest = project.provide(generateWithSnapshot).pipe(
            Effect.andThen(project.manifest),
            Effect.map(({ digest }) => digest),
          );
          const declared = yield* runDigest;
          expect(yield* runDigest).toBe(declared);
          yield* project.undeclare;
          const undeclared = yield* runDigest;
          expect(undeclared).not.toBe(declared);
          yield* project.write("confect/stock.spec.ts", stockSpec);
          yield* project.write("confect/stock.impl.ts", stockImpl);
          expect(yield* runDigest).toBe(undeclared);
          yield* project.declare('{ key: "tags", section: tags }');
          const described = yield* runDigest;
          expect([declared, undeclared]).not.toContain(described);
          expect(Object.keys((yield* project.manifest).tags.functions)).toEqual(
            ["notes:list", "stock:profiled", "stock:raw"],
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "writes the same files, manifest and digest whatever order directories list in",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const generated = Effect.fnUntraced(function* (reversed: boolean) {
            const project = yield* manifestProject;
            for (const module of [
              "shelf",
              "stock",
              "items/flows",
              "landing/sweep",
            ]) {
              const name = module.split("/").pop()!;
              yield* fs.makeDirectory(
                `${project.root}/confect/${module.split("/").slice(0, -1).join("/")}`,
                { recursive: true },
              );
              yield* project.write(`confect/${module}.spec.ts`, stockSpec);
              yield* project.write(
                `confect/${module}.impl.ts`,
                stockImpl
                  .replaceAll("stock", name)
                  .replace(
                    '"./_generated/schema"',
                    `"${module.includes("/") ? "../" : "./"}_generated/schema"`,
                  ),
              );
            }
            const generate = project.provide(generateWithSnapshot);
            yield* reversed
              ? generate.pipe(
                  Effect.provideService(FileSystem.FileSystem, {
                    ...fs,
                    readDirectory: (directory, options) =>
                      fs
                        .readDirectory(directory, options)
                        .pipe(Effect.map(Array.reverse)),
                  }),
                )
              : generate;
            return {
              manifest: yield* project.manifest,
              files: yield* project.generatedFiles,
            };
          });
          const forward = yield* generated(false);
          const reversed = yield* generated(true);
          expect(reversed.manifest.digest).toBe(forward.manifest.digest);
          expect(reversed.files).toEqual(forward.files);
          expect(Object.keys(forward.manifest.tags.functions)).toEqual([
            "items/flows:profiled",
            "items/flows:raw",
            "landing/sweep:profiled",
            "landing/sweep:raw",
            "notes:list",
            "shelf:profiled",
            "shelf:raw",
            "stock:profiled",
            "stock:raw",
          ]);
        }).pipe(Effect.scoped),
    );

    it.effect(
      "keeps a declared section in the manifest once the backend has no functions",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const project = yield* manifestProject;
          yield* project.provide(generateWithSnapshot);
          for (const file of ["notes.spec.ts", "notes.impl.ts"])
            yield* fs.remove(`${project.root}/confect/${file}`);
          yield* project.provide(generateWithSnapshot);
          expect((yield* project.manifest).tags).toEqual({
            format: 1,
            functions: {},
          });
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect.each([false, true])(
      "refuses a function spec that carries manifest sections and points at App.make (incremental=%s)",
      (incremental) =>
        Effect.gen(function* () {
          const project = yield* manifestProject;
          const { snapshot } = yield* project.provide(generateWithSnapshot);
          yield* project.write(
            "confect/notes.spec.ts",
            project
              .sectionSpec("first")
              .replace(
                "export default",
                'import { tags } from "./tags";\nexport default',
              )
              .replace(
                "FunctionSpec.publicQuery({",
                "Object.assign(FunctionSpec.publicQuery({",
              )
              .replace(
                "}));\n",
                '}), { manifestSections: [{ key: "tags", section: tags }] }));\n',
              ),
          );
          const error = yield* Effect.flip(
            project.provide(
              incremental
                ? updateDeclarations(
                    snapshot,
                    [
                      {
                        _tag: "Spec",
                        relativePath: SpecModulePath.make("notes.spec.ts"),
                      },
                    ],
                    [],
                  ).pipe(Effect.asVoid)
                : generateWithSnapshot.pipe(Effect.asVoid),
            ),
          );
          expect(error).toMatchObject({
            _tag: "InvalidDeclarationError",
            declarationPath: "confect/notes.spec.ts",
          });
          assert(isCodegenError(error));
          expect(renderCodegenError(error)).toContain(
            "notes:list carries manifestSections, which codegen no longer reads from a function spec. Declare the backend's manifest sections once, on App.make({ manifestSections }) in confect/app.ts.",
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "refuses a function spec that carried manifest sections before middleware was attached",
      () =>
        Effect.gen(function* () {
          const project = yield* manifestProject;
          yield* project.write(
            "confect/observe.ts",
            `import { MiddlewareSpec } from "@confect/core";
export class Observe extends MiddlewareSpec.MiddlewareSpec<Observe>()("Observe", { functionTypes: { query: true } }) {}`,
          );
          yield* project.write(
            "confect/notes.impl.ts",
            'import { MiddlewareImpl } from "@confect/server";\nimport { Observe } from "./observe";\n' +
              Project.impl.replace(
                "GroupImpl.finalize);",
                "Layer.provide(MiddlewareImpl.make(databaseSchema, Observe, effect => effect)), GroupImpl.finalize);",
              ),
          );
          yield* project.write(
            "confect/notes.spec.ts",
            project
              .sectionSpec("first")
              .replace(
                "export default",
                'import { Observe } from "./observe";\nimport { tags } from "./tags";\nexport default',
              )
              .replace(
                "FunctionSpec.publicQuery({",
                "Object.assign(FunctionSpec.publicQuery({",
              )
              .replace(
                "}));\n",
                '}), { manifestSections: [{ key: "tags", section: tags }] }).middleware(Observe));\n',
              ),
          );
          const error = yield* Effect.flip(
            project.provide(generateWithSnapshot),
          );
          assert(isCodegenError(error));
          expect(renderCodegenError(error)).toContain(
            'Function "list" carries manifestSections, which middleware would drop. Declare the backend\'s manifest sections once, on App.make({ manifestSections }) in confect/app.ts.',
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect.each([
      ["./_generated/observe.ts", true],
      ["./_generated/observe", true],
      ["./_generated/observe.js", true],
      ["../convex/_generated/observe", false],
      ["./observe-helper", false],
    ] as const)(
      "names App.make when an implementation imports %s that no declared section writes (%s)",
      ([specifier, names]) =>
        Effect.gen(function* () {
          const project = yield* manifestProject;
          yield* project.write(
            "confect/notes.impl.ts",
            `import "${specifier}";\n${Project.impl}`,
          );
          const error = yield* Effect.flip(
            project.provide(generateWithSnapshot),
          );
          assert(isCodegenError(error));
          const rendered = renderCodegenError(error);
          expect(rendered).toContain("notes.impl.ts");
          if (names) {
            expect(rendered).toContain(
              "No manifest section this backend declares writes _generated/observe.ts. Declare its section on App.make({ manifestSections }) in confect/app.ts.",
            );
          } else {
            expect(rendered).toContain(`Could not resolve "${specifier}"`);
            expect(rendered).not.toContain("App.make");
          }
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect("refuses a manifest section key App.make declares twice", () =>
      Effect.gen(function* () {
        const project = yield* manifestProject;
        yield* project.declare(
          '{ key: "tags", section: tags }, { key: "tags", section: tags }',
        );
        expect(
          yield* Effect.flip(project.provide(generateWithSnapshot)),
        ).toMatchObject({
          _tag: "InvalidDeclarationError",
          declarationPath: "confect/app.ts",
          reason: 'Manifest section "tags" is declared twice.',
        });
      }).pipe(Effect.scoped),
    );

    it.effect.each(
      [true, false].flatMap((sectioned) =>
        [
          "<<<<<<< HEAD\nexport default {};\n",
          "",
          "export const other = 1;",
          "export default null;",
        ].map((contents) => ({ sectioned, contents })),
      ),
    )(
      "overwrites unusable history $contents (sectioned=$sectioned)",
      ({ sectioned, contents }) =>
        Effect.gen(function* () {
          const project = yield* manifestProject;
          if (!sectioned) yield* project.undeclare;
          yield* project.provide(generateWithSnapshot);
          yield* project.write("confect/_generated/manifest.ts", contents);
          yield* project.provide(generateWithSnapshot);
          expect((yield* project.manifest).name).toBe("host");
          expect((yield* project.manifest).tags).toEqual(
            sectioned
              ? {
                  format: 1,
                  functions: { "notes:list": "first" },
                }
              : undefined,
          );
        }).pipe(Effect.scoped),
    );

    it.effect.each([false, true])(
      "attributes cross-file check conflicts to the section (incremental=%s)",
      (incremental) =>
        Effect.gen(function* () {
          const project = yield* manifestProject;
          yield* project.write(
            "confect/tags.ts",
            `export const tags = {
owner: "test/tags", format: 1, describe: ({ spec }) => spec.description,
check: (next) => ({ errors: "stock:list" in next.functions ? ["notes:list and stock:list declare conflicting tags"] : [], notes: [] })
};`,
          );
          yield* project.write(
            "confect/alpha.spec.ts",
            project.sectionSpec("first"),
          );
          yield* project.write(
            "confect/alpha.impl.ts",
            Project.impl.replace("./notes.spec", "./alpha.spec"),
          );
          const { snapshot } = yield* project.provide(generateWithSnapshot);
          yield* project.write(
            "confect/stock.spec.ts",
            project.sectionSpec("conflict"),
          );
          yield* project.write(
            "confect/stock.impl.ts",
            Project.impl.replace("./notes.spec", "./stock.spec"),
          );
          const error = yield* Effect.flip(
            project.provide(
              incremental
                ? updateDeclarations(
                    snapshot,
                    [
                      {
                        _tag: "Spec",
                        relativePath: SpecModulePath.make("stock.spec.ts"),
                      },
                    ],
                    [],
                  ).pipe(Effect.asVoid)
                : generateWithSnapshot.pipe(Effect.asVoid),
            ),
          );
          assert(isCodegenError(error));
          expect(renderCodegenError(error)).toContain(
            'Manifest section "tags" is invalid: notes:list and stock:list declare conflicting tags',
          );
          expect(renderCodegenError(error)).not.toContain("Declaration ");
          expect(error).toMatchObject({
            _tag: "InvalidManifestSectionError",
            sectionKey: "tags",
            reason: "notes:list and stock:list declare conflicting tags",
          });
        }).pipe(Effect.scoped),
    );

    it.effect.each([
      {
        thrown: 'new Error("tags: declaration refused")',
        shown: "Error: tags: declaration refused",
      },
      {
        thrown: '"tags: declaration refused"',
        shown: "tags: declaration refused",
      },
    ])(
      "reports a describe refusal without a JSON error ($shown)",
      ({ thrown, shown }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const project = yield* manifestProject;
          yield* project.write(
            "confect/tags.ts",
            `export const tags = { owner: "test/tags", format: 1, describe: () => { throw ${thrown}; } };`,
          );
          const error = yield* Effect.flip(
            project.provide(generateWithSnapshot),
          );
          expect(error).toMatchObject({
            _tag: "InvalidDeclarationError",
            declarationPath: "confect/notes.spec.ts",
            reason: `Manifest section "tags" (notes:list): ${shown}`,
          });
          assert(error._tag === "InvalidDeclarationError");
          expect(renderCodegenError(error)).toContain(
            `Manifest section "tags" (notes:list): ${shown}`,
          );
          expect(renderCodegenError(error)).not.toContain(
            "could not describe as JSON",
          );
          expect(
            yield* fs.exists(`${project.root}/confect/_generated/manifest.ts`),
          ).toBe(false);
        }).pipe(Effect.scoped),
    );

    it.effect.each([
      { value: "1n", path: "$" },
      { value: "() => 1", path: "$" },
      {
        value:
          "(() => { const cycle = []; cycle.push(cycle); return cycle; })()",
        path: '$["0"]',
      },
      {
        value: "({ nested: { missing: undefined } })",
        path: '$["nested"]["missing"]',
      },
      { value: "({ n: Infinity })", path: '$["n"]' },
      {
        value: "(() => { const a = {}; a.b = { a }; return { a }; })()",
        path: '$["a"]["b"]["a"]',
      },
      { value: "({ m: new Map([[1, 2]]) })", path: '$["m"]' },
      { value: "({ at: new Date(0) })", path: '$["at"]' },
      {
        value: "new (class Level { toJSON() { return 1; } })()",
        path: "$",
      },
      { value: "Object.assign([1], { toJSON: () => 1 })", path: "$" },
      { value: "Object.assign([1], { keys: 1 })", path: "$" },
      { value: "new (class Levels extends Array {})()", path: "$" },
      {
        value: 'Object.defineProperty({}, "toJSON", { value: () => 1 })',
        path: '$["toJSON"]',
      },
      { value: "({ get n() { return 1; } })", path: '$["n"]' },
      { value: '({ "": undefined })', path: '$[""]' },
      { value: '({ "": { missing: undefined } })', path: '$[""]["missing"]' },
      {
        value: `JSON.parse('{"nested":{"__proto__":{"value":1}}}')`,
        path: '$["nested"]["__proto__"]',
      },
    ])(
      "reports non-JSON description $value at $path through codegen",
      ({ value, path }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const project = yield* manifestProject;
          yield* project.write(
            "confect/tags.ts",
            `export const tags = { owner: "test/tags", format: 1, describe: () => ${value} };`,
          );
          const error = yield* Effect.flip(
            project.provide(generateWithSnapshot),
          );
          expect(error).toMatchObject({
            _tag: "InvalidDeclarationError",
            declarationPath: "confect/notes.spec.ts",
            reason: `Manifest section "tags" (notes:list): could not describe as JSON: Expected JSON data at ${path}`,
          });
          assert(error._tag === "InvalidDeclarationError");
          expect(renderCodegenError(error)).toContain(
            `could not describe as JSON: Expected JSON data at ${path}`,
          );
          expect(
            yield* fs.exists(`${project.root}/confect/_generated/manifest.ts`),
          ).toBe(false);
        }).pipe(Effect.scoped),
    );

    it.effect.each([
      "Object.assign([1], { keys: 1 })",
      'Object.defineProperty([1], "keys", { get: () => { throw new Error("keys getter ran"); } })',
    ])("refuses a summary holding %s and removes the manifest", (value) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const project = yield* manifestProject;
        yield* project.provide(generateWithSnapshot);
        yield* project.write(
          "confect/tags.ts",
          `export const tags = { owner: "test/tags", format: 1, describe: () => null, summarize: () => ({ format: 1, at: ${value} }) };`,
        );
        expect(
          yield* Effect.flip(project.provide(generateWithSnapshot)),
        ).toMatchObject({
          _tag: "InvalidManifestSectionError",
          sectionKey: "tags",
          reason: 'could not summarize as JSON: Expected JSON data at $["at"]',
        });
        expect(
          yield* fs.exists(`${project.root}/confect/_generated/manifest.ts`),
        ).toBe(false);
      }).pipe(Effect.scoped),
    );

    it.effect.each([
      { builder: "publicMutation", nested: false },
      { builder: "publicAction", nested: false },
      { builder: "publicNodeAction", nested: false },
      { builder: "publicMutation", nested: true },
    ])(
      "rejects a reserved domain argument in $builder (nested=$nested) before loading its implementation",
      ({ builder, nested }) =>
        Effect.gen(function* () {
          const project = yield* Project.make;
          yield* project.write(
            "confect/notes.spec.ts",
            `
import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
const profile = FunctionSpec.extend()({ middleware: [], reservedArgument: "context" });
const group = GroupSpec.make().addFunction(profile.${builder}({
  name: "${nested ? "save" : "list"}", args: () => ({ context: Schema.String })
}));
export default ${nested ? "GroupSpec.addGroupsAt(GroupSpec.make(), { child: group })" : "group"};`,
          );
          yield* project.write(
            "confect/notes.impl.ts",
            'throw new Error("impl must not load");',
          );
          expect(yield* Effect.flip(project.provide(codegenHandler))).toEqual(
            new InvalidDeclarationError({
              declarationPath: "confect/notes.spec.ts",
              reason: `${nested ? "notes/child:save" : "notes:list"} declares the argument "context", which its profile reserves. Rename the argument.`,
            }),
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect.each(["publicQuery", "publicMutation"])(
      "accepts a profile %s with ordinary domain arguments",
      (builder) =>
        Effect.gen(function* () {
          const project = yield* Project.make;
          yield* project.write(
            "confect/notes.spec.ts",
            Project.spec
              .replace(
                "export default",
                'const profile = FunctionSpec.extend()({ middleware: [], reservedArgument: "context" });\nexport default',
              )
              .replace("FunctionSpec.publicQuery", `profile.${builder}`),
          );
          const result = yield* project.provide(codegenHandler);
          expect([...result.functionPaths].map((fn) => fn.name)).toEqual([
            "list",
          ]);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "rejects a reserved domain argument during incremental codegen",
      () =>
        Effect.gen(function* () {
          const project = yield* Project.make;
          const { snapshot } = yield* project.provide(generateWithSnapshot);
          yield* project.write(
            "confect/notes.spec.ts",
            `
import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
const profile = FunctionSpec.extend()({ middleware: [], reservedArgument: "context" });
export default GroupSpec.make().addFunction(profile.publicMutation({ name: "list", args: () => ({ context: Schema.String }) }));`,
          );
          expect(
            yield* Effect.flip(
              project.provide(
                updateDeclarations(
                  snapshot,
                  [
                    {
                      _tag: "Spec",
                      relativePath: SpecModulePath.make("notes.spec.ts"),
                    },
                  ],
                  [],
                ),
              ),
            ),
          ).toEqual(
            new InvalidDeclarationError({
              declarationPath: "confect/notes.spec.ts",
              reason:
                'notes:list declares the argument "context", which its profile reserves. Rename the argument.',
            }),
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "matches fresh output with workspace-linked dependencies",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const installed = yield* Project.make;
          yield* installed.provide(codegenHandler);
          const expected = yield* installed.generatedFiles;
          const installedBundle = yield* installed.provide(
            Bundler.bundle(
              path.join(installed.root, "confect/tables/notes.ts"),
            ),
          );
          expect(
            Array.dedupe(
              Array.map(
                Array.filter(
                  Array.flatMap(
                    Rec.values(installedBundle.metafile.inputs),
                    (input) => input.imports,
                  ),
                  (imported) => imported.original === "@confect/core",
                ),
                (imported) => Boolean(imported.external),
              ),
            ),
          ).toEqual([true]);
          const workspace = yield* Project.make;
          yield* fs.remove(path.join(workspace.root, "node_modules"), {
            recursive: true,
          });
          yield* workspace.provide(codegenHandler);
          const actual = yield* workspace.generatedFiles;
          expect(actual).toEqual(expected);
          const workspaceBundle = yield* workspace.provide(
            Bundler.bundle(
              path.join(workspace.root, "confect/tables/notes.ts"),
            ),
          );
          expect(
            Array.dedupe(
              Array.map(
                Array.filter(
                  Array.flatMap(
                    Rec.values(workspaceBundle.metafile.inputs),
                    (input) => input.imports,
                  ),
                  (imported) => imported.original === "@confect/core",
                ),
                (imported) => Boolean(imported.external),
              ),
            ),
          ).toEqual([false]);
          expect(Rec.keys(installedBundle.metafile.inputs).length).toBeLessThan(
            Rec.keys(workspaceBundle.metafile.inputs).length,
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect.each([
      "schema.spec.ts",
      "http.spec.ts",
      "crons.spec.ts",
      "bad-dir/notes.spec.ts",
      "notes/bad-name.spec.ts",
      "notes/..spec.ts",
      "notes/...spec.ts",
    ])(
      "rejects invalid group path %s before replacing the Convex schema",
      (file) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const project = yield* Project.make;
          yield* fs.makeDirectory(
            path.dirname(path.join(project.root, "confect", file)),
            { recursive: true },
          );
          const prefix =
            pipe("../", String.repeat(String.split(file, "/").length - 1)) ||
            "./";
          const name = path.basename(file, ".spec.ts");
          yield* project.write(
            `confect/${file}`,
            pipe(
              Project.spec,
              String.replaceAll('"./_generated/', `"${prefix}_generated/`),
            ),
          );
          yield* project.write(
            `confect/${pipe(file, String.replace(/\.spec\.ts$/, ".impl.ts"))}`,
            pipe(
              Project.impl,
              String.replaceAll('"./_generated/', `"${prefix}_generated/`),
              String.replace('"./notes.spec"', `"./${name}.spec"`),
            ),
          );
          const previousSchema = "export default {};\n";
          yield* project.write("convex/schema.ts", previousSchema);
          const result = yield* project
            .provide(codegenHandler)
            .pipe(Effect.result);
          assert(result._tag === "Failure");
          expect(result.failure).toMatchObject({
            _tag: "SnapshotError",
            reason: "NoncanonicalPath",
            relativePath: file,
          });
          const contents2 = yield* fs.readFileString(
            path.join(project.root, "convex/schema.ts"),
          );
          expect(contents2).toBe(previousSchema);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect.each(["http.ts", "crons.ts", "auth.ts"])(
      "checks optional module %s and recovers after compile errors",
      (file) =>
        Effect.gen(function* () {
          const project = yield* Project.make;
          for (const contents of [
            "export default ;",
            'export { default } from "./missing-optional-dependency";',
          ]) {
            yield* project.write(`confect/${file}`, contents);
            const result = yield* project
              .provide(codegenHandler)
              .pipe(Effect.result);
            assert(result._tag === "Failure");
            expect(result.failure).toMatchObject({
              _tag: "BundleFailedError",
              file,
            });
          }
          yield* project.write(
            `confect/${file}`,
            'throw new Error("Optional runtime must not execute"); export default {};',
          );
          yield* project.provide(codegenHandler);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect.each(["http.ts", "crons.ts", "auth.ts"])(
      "checks %s after its generated dependencies exist without evaluating it",
      (file) =>
        Effect.gen(function* () {
          const project = yield* Project.make;
          yield* project.write(
            `confect/${file}`,
            'import "./_generated/registeredFunctions/notes"; import "../convex/notes"; throw new Error("Optional runtime must not execute"); export default {};',
          );
          yield* project.provide(codegenHandler);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "notifies Convex after explicit codegen even when generated contents are unchanged",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const project = yield* Project.make;
          yield* project.provide(codegenHandler);
          const before = yield* project.generatedFiles;
          const schema = path.join(project.root, "convex/schema.ts");
          const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe(1000));
          yield* fs.utimes(schema, timestamp, timestamp);
          yield* TestClock.setTime(2000);
          const actual2 = yield* Project.writtenFiles(
            project.provide(codegenHandler),
          );
          expect(actual2).toEqual([]);
          const actual3 = yield* project.generatedFiles;
          expect(actual3).toEqual(before);
          expect(
            Option.getOrThrow((yield* fs.stat(schema)).mtime).getTime(),
          ).toBe(2000);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "updates a spec without evaluating unrelated modules and matches full generation",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const project = yield* Project.make;
          yield* project.write("confect/other.spec.ts", Project.spec);
          yield* project.write(
            "confect/other.impl.ts",
            pipe(
              Project.impl,
              String.replace('"./notes.spec"', '"./other.spec"'),
            ),
          );
          const { snapshot } = yield* project.provide(generateWithSnapshot);
          yield* project.write(
            "confect/notes.spec.ts",
            pipe(
              Project.spec,
              String.replace('name: "list"', 'name: "latest"'),
            ),
          );
          yield* project.write(
            "confect/notes.impl.ts",
            pipe(Project.impl, String.replace('"list"', '"latest"')),
          );
          const bundle = yield* Effect.acquireRelease(
            Effect.sync(() => vi.spyOn(Bundler, "bundle")),
            (spy) => Effect.sync(() => spy.mockRestore()),
          );
          const next = yield* project.provide(
            updateDeclarations(
              snapshot,
              [
                {
                  _tag: "Spec",
                  relativePath: SpecModulePath.make("notes.spec.ts"),
                },
              ],
              [],
            ),
          );
          expect(
            Array.map(bundle.mock.calls, ([entry]) =>
              path.relative(project.root, entry),
            ),
          ).toEqual([
            path.join("confect", "notes.spec.ts"),
            path.join("confect", "notes.impl.ts"),
          ]);
          expect(
            Array.map(
              [...GenerationSnapshot.functionPaths(next)],
              (fn) => fn.name,
            ).sort(),
          ).toEqual(["latest", "list"]);
          expect(
            Array.map(
              [...GenerationSnapshot.functionPaths(snapshot)],
              (fn) => fn.name,
            ),
          ).toEqual(["list", "list"]);
          const incremental = yield* project.generatedFiles;
          const actual4 = yield* Project.writtenFiles(
            project.provide(codegenHandler),
          );
          expect(actual4).toEqual([]);
          const actual5 = yield* project.generatedFiles;
          expect(actual5).toEqual(incremental);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "checks global parent collisions before validating an updated implementation",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const project = yield* Project.make;
          yield* fs.makeDirectory(path.join(project.root, "confect", "notes"));
          yield* project.write(
            "confect/notes/archived.spec.ts",
            pipe(
              Project.spec,
              String.replace('"./_generated/', '"../_generated/'),
            ),
          );
          yield* project.write(
            "confect/notes/archived.impl.ts",
            pipe(
              Project.impl,
              String.replaceAll('"./_generated/', '"../_generated/'),
              String.replace('"./notes.spec"', '"./archived.spec"'),
            ),
          );
          const { snapshot } = yield* project.provide(generateWithSnapshot);
          const before = yield* project.generatedFiles;
          yield* project.write(
            "confect/notes.spec.ts",
            pipe(
              Project.spec,
              String.replace('name: "list"', 'name: "archived"'),
            ),
          );
          const result = yield* project
            .provide(
              updateDeclarations(
                snapshot,
                [
                  {
                    _tag: "Spec",
                    relativePath: SpecModulePath.make("notes.spec.ts"),
                  },
                ],
                [],
              ),
            )
            .pipe(Effect.result);
          assert(result._tag === "Failure");
          expect(result.failure).toMatchObject({
            _tag: "ParentChildNameCollisionError",
            parentSpecPath: "notes.spec.ts",
            childSpecPath: "notes/archived.spec.ts",
            collisionName: "archived",
          });
          const actual6 = yield* project.generatedFiles;
          expect(actual6).toEqual(before);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "updates context reuse alone with fresh-generation parity",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const project = yield* Project.make;
          let { snapshot } = yield* project.provide(generateWithSnapshot);
          const baseline = yield* project.generatedFiles;
          for (const enabled of [true, false]) {
            yield* project.write(
              "confect/notes.spec.ts",
              pipe(
                Project.spec,
                String.replace(
                  "GroupSpec.make()",
                  `GroupSpec.make({ experimental_reuseContext: ${enabled} })`,
                ),
              ),
            );
            snapshot = yield* project.provide(
              updateDeclarations(
                snapshot,
                [
                  {
                    _tag: "Spec",
                    relativePath: SpecModulePath.make("notes.spec.ts"),
                  },
                ],
                [],
              ),
            );
            const generated = yield* project.generatedFiles;
            const entryPoint = generated[path.join("convex", "notes.ts")];
            assert(entryPoint !== undefined);
            expect(
              pipe(
                entryPoint,
                String.includes(
                  "export const experimental_reuseContext = true;",
                ),
              ),
            ).toBe(enabled);
            const writes = yield* Project.writtenFiles(
              project.provide(codegenHandler),
            );
            expect(writes).toEqual([]);
            const fresh = yield* project.generatedFiles;
            expect(fresh).toEqual(generated);
            if (!enabled) expect(generated).toEqual(baseline);
          }
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "updates runtime and removes the last function with fresh-generation parity",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const project = yield* Project.make;
          let { snapshot } = yield* project.provide(generateWithSnapshot);
          yield* project.write(
            "confect/notes.spec.ts",
            pipe(
              Project.spec,
              String.replace("GroupSpec.make()", "GroupSpec.makeNode()"),
              String.replace(
                "FunctionSpec.publicQuery",
                "FunctionSpec.publicNodeAction",
              ),
            ),
          );
          yield* project.write(
            "confect/notes.impl.ts",
            `import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import schema from "./_generated/schema";
import spec from "./notes.spec";
export default GroupImpl.make(schema, spec).pipe(Layer.provide(FunctionImpl.make(schema, spec, "list", () => Effect.succeed([]))), GroupImpl.finalize);
`,
          );
          snapshot = yield* project.provide(
            updateDeclarations(
              snapshot,
              [
                {
                  _tag: "Spec",
                  relativePath: SpecModulePath.make("notes.spec.ts"),
                },
              ],
              [],
            ),
          );
          const nodeOutputs = yield* project.generatedFiles;
          expect(nodeOutputs[path.join("convex", "notes.ts")]).toContain(
            '"use node"',
          );
          const actual7 = yield* Project.writtenFiles(
            project.provide(codegenHandler),
          );
          expect(actual7).toEqual([]);
          const actual8 = yield* project.generatedFiles;
          expect(actual8).toEqual(nodeOutputs);
          yield* project.write(
            "confect/notes.spec.ts",
            'import { GroupSpec } from "@confect/core"; export default GroupSpec.makeNode();\n',
          );
          yield* project.write("confect/notes.impl.ts", Project.emptyImpl);
          const empty = yield* project.provide(
            updateDeclarations(
              snapshot,
              [
                {
                  _tag: "Spec",
                  relativePath: SpecModulePath.make("notes.spec.ts"),
                },
              ],
              [],
            ),
          );
          expect([...GenerationSnapshot.functionPaths(empty)]).toEqual([]);
          const removedOutputs = yield* project.generatedFiles;
          expect(Rec.has(removedOutputs, path.join("convex", "notes.ts"))).toBe(
            false,
          );
          const actual9 = yield* Project.writtenFiles(
            project.provide(codegenHandler),
          );
          expect(actual9).toEqual([]);
          const actual10 = yield* project.generatedFiles;
          expect(actual10).toEqual(removedOutputs);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "validates changed tables before affected implementations without rewriting declarations",
      () =>
        Effect.gen(function* () {
          const project = yield* Project.make;
          const { snapshot } = yield* project.provide(generateWithSnapshot);
          yield* project.write(
            "confect/tables/notes.ts",
            "export default {};\n",
          );
          const failed = yield* project
            .provide(
              updateDeclarations(
                snapshot,
                [
                  {
                    _tag: "Table",
                    relativePath: TableModulePath.make("tables/notes.ts"),
                  },
                ],
                [ImplModulePath.make("notes.impl.ts")],
              ),
            )
            .pipe(Effect.result);
          assert(failed._tag === "Failure");
          expect(failed.failure._tag).toBe("InvalidTableDefaultExportError");
          yield* project.write(
            "confect/tables/notes.ts",
            pipe(
              Project.table,
              String.replace(
                "text: Schema.String",
                "text: Schema.String, archived: Schema.Boolean",
              ),
            ),
          );
          const before = yield* project.generatedFiles;
          yield* project.provide(
            updateDeclarations(
              snapshot,
              [
                {
                  _tag: "Table",
                  relativePath: TableModulePath.make("tables/notes.ts"),
                },
              ],
              [ImplModulePath.make("notes.impl.ts")],
            ),
          );
          const actual11 = yield* project.generatedFiles;
          expect(actual11).toEqual(before);
          const actual12 = yield* Project.writtenFiles(
            project.provide(codegenHandler),
          );
          expect(actual12).toEqual([]);
          const actual13 = yield* project.generatedFiles;
          expect(actual13).toEqual(before);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "shares one build per evaluation phase without changing generated output",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const project = yield* Project.make;
          yield* project.write("confect/tables/labels.ts", Project.table);
          for (const name of ["other", "another"]) {
            yield* project.write(`confect/${name}.spec.ts`, Project.spec);
            yield* project.write(
              `confect/${name}.impl.ts`,
              pipe(
                Project.impl,
                String.replace('"./notes.spec"', `"./${name}.spec"`),
              ),
            );
          }
          const run = codegenHandler.pipe(
            Effect.provideService(ProjectRoot, {
              get: Effect.succeed(project.root),
            }),
            Effect.provideService(ConfectDirectory, {
              get: Effect.succeed(path.join(project.root, "confect")),
            }),
            Effect.provideService(ConvexDirectory, {
              get: Effect.succeed(path.join(project.root, "convex")),
            }),
          );
          vi.mocked(esbuild.build).mockClear();
          const actual14 = yield* Project.writtenFiles(run);
          expect(actual14).not.toEqual([]);
          const batchedOutputs = yield* project.generatedFiles;
          expect(
            Array.filter(
              Array.map(vi.mocked(esbuild.build).mock.calls, ([options]) => {
                const entryPoints = options?.entryPoints ?? {};
                return Array.isArray(entryPoints)
                  ? entryPoints.length
                  : Rec.keys(entryPoints).length;
              }),
              (count) => count > 1,
            ),
          ).toEqual([2, 3, 3]);
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              vi
                .spyOn(Bundler, "withBatch")
                .mockImplementation(
                  <A, E, R>(
                    _entries: ReadonlyArray<string>,
                    effect: Effect.Effect<A, E, R>,
                  ) => effect,
                ),
            ),
            (spy) => Effect.sync(() => spy.mockRestore()),
          );
          const actual15 = yield* Project.writtenFiles(run);
          expect(actual15).toEqual([]);
          const actual16 = yield* project.generatedFiles;
          expect(actual16).toEqual(batchedOutputs);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "bounds spec and impl phases without overlapping them",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const project = yield* Project.make;
          for (const index of Array.range(0, 7)) {
            yield* project.write(
              `confect/group${index}.spec.ts`,
              'import { GroupSpec } from "@confect/core"; export default GroupSpec.make();',
            );
            yield* project.write(
              `confect/group${index}.impl.ts`,
              `import { GroupImpl } from "@confect/server";
import databaseSchema from "./_generated/schema";
import spec from "./group${index}.spec";
export default GroupImpl.make(databaseSchema, spec).pipe(GroupImpl.finalize);`,
            );
          }
          const active = { spec: 0, impl: 0 };
          const maximum = { spec: 0, impl: 0 };
          let completedSpecs = 0;
          const original = Bundler.bundle;
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              vi.spyOn(Bundler, "bundle").mockImplementation((entry) =>
                Effect.gen(function* () {
                  const phase = pipe(entry, String.endsWith(".spec.ts"))
                    ? "spec"
                    : pipe(entry, String.endsWith(".impl.ts"))
                      ? "impl"
                      : undefined;
                  if (phase === undefined) return yield* original(entry);
                  if (phase === "impl") expect(completedSpecs).toBe(9);
                  active[phase]++;
                  maximum[phase] = Math.max(maximum[phase], active[phase]);
                  yield* Effect.yieldNow;
                  return yield* original(entry).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        active[phase]--;
                        if (phase === "spec") completedSpecs++;
                      }),
                    ),
                  );
                }),
              ),
            ),
            (spy) => Effect.sync(() => spy.mockRestore()),
          );
          yield* codegenHandler.pipe(
            Effect.provideService(ProjectRoot, {
              get: Effect.succeed(project.root),
            }),
            Effect.provideService(ConfectDirectory, {
              get: Effect.succeed(path.join(project.root, "confect")),
            }),
            Effect.provideService(ConvexDirectory, {
              get: Effect.succeed(path.join(project.root, "convex")),
            }),
          );
          expect(maximum).toEqual({ spec: 4, impl: 4 });
          expect(completedSpecs).toBe(9);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "does not bundle the same spec twice during one codegen pass",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const project = yield* Project.make;
          const bundle = yield* Effect.acquireRelease(
            Effect.sync(() => vi.spyOn(Bundler, "bundle")),
            (spy) => Effect.sync(() => spy.mockRestore()),
          );
          yield* codegenHandler.pipe(
            Effect.provideService(ProjectRoot, {
              get: Effect.succeed(project.root),
            }),
            Effect.provideService(ConfectDirectory, {
              get: Effect.succeed(path.join(project.root, "confect")),
            }),
            Effect.provideService(ConvexDirectory, {
              get: Effect.succeed(path.join(project.root, "convex")),
            }),
          );
          const specBuilds = Array.filter(
            bundle.mock.calls,
            ([entry]) =>
              entry === path.join(project.root, "confect/notes.spec.ts"),
          );
          expect(specBuilds).toHaveLength(1);
          expect(
            Array.map(bundle.mock.calls, ([entry]) => entry),
          ).not.toContain(
            path.join(project.root, "confect/_generated/spec.ts"),
          );
        }).pipe(Effect.scoped),
    );

    it.effect(
      "bootstraps dependent modules once without relying on stale output",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const project = yield* Project.make;
          const confect = path.join(project.root, "confect");
          const run = codegenHandler.pipe(
            Effect.provideService(ProjectRoot, {
              get: Effect.succeed(project.root),
            }),
            Effect.provideService(ConfectDirectory, {
              get: Effect.succeed(confect),
            }),
            Effect.provideService(ConvexDirectory, {
              get: Effect.succeed(path.join(project.root, "convex")),
            }),
          );
          const actual17 = yield* Project.writtenFiles(run);
          expect(actual17).not.toEqual([]);
          const actual18 = yield* Project.writtenFiles(run);
          expect(actual18).toEqual([]);
          yield* fs.remove(path.join(confect, "_generated"), {
            recursive: true,
          });
          const actual19 = yield* Project.writtenFiles(run);
          expect(actual19).not.toEqual([]);
          const actual20 = yield* Project.writtenFiles(run);
          expect(actual20).toEqual([]);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );
  },
);

const fixtureConfect = `${import.meta.dirname}/../../server/test/mock-backend/fixtures/confect`;

const CodegenLayer = Layer.effect(
  ConfectDirectory,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({
      directory: import.meta.dirname,
      prefix: "table-fixture-",
    });
    yield* fs.makeDirectory(path.join(directory, "tables"));
    yield* fs.makeDirectory(path.join(directory, "_generated"));
    for (const file of [
      "tables/demands.ts",
      "tables/events.ts",
      "tables/notes.ts",
      "tables/tags.ts",
      "tables/totals.ts",
      "tables/users.ts",
      "_generated/id.ts",
    ])
      yield* fs.copyFile(
        path.join(fixtureConfect, file),
        path.join(directory, file),
      );
    return ConfectDirectory.of({ get: Effect.succeed(directory) });
  }),
).pipe(
  Layer.provideMerge(Layer.mergeAll(NodePath.layer, NodeFileSystem.layer)),
);

layer(CodegenLayer)("TableModule.validate", (it) => {
  it.effect("bounds table bundling to four concurrent builds", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let active = 0;
      let maximum = 0;
      const bundle = yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(Bundler, "bundle").mockImplementation(() =>
            Effect.gen(function* () {
              active++;
              maximum = Math.max(maximum, active);
              if (active === 4) yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              active--;
              return {
                module: { default: Table.make(() => Schema.Struct({})) },
                metafile: { inputs: {}, outputs: {} },
              };
            }),
          ),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      const fiber = yield* validateTables(
        Array.map(Array.range(0, 8), (index) => ({
          relativePath: `tables/t${index}.ts`,
          tableName: `t${index}`,
        })),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* Effect.yieldNow;
      expect(active).toBe(4);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(fiber);
      expect(maximum).toBe(4);
      expect(bundle).toHaveBeenCalledTimes(9);
    }).pipe(Effect.scoped),
  );
});

layer(CodegenLayer)("TableModule.discover", (it) => {
  it.effect("discovers the fixture tables", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const tables = yield* discoverTables;
      expect(Array.map(tables, (t) => t.tableName).sort()).toEqual([
        "demands",
        "events",
        "notes",
        "tags",
        "totals",
        "users",
      ]);
      for (const table of tables) {
        expect(String.startsWith(`tables${path.sep}`)(table.relativePath)).toBe(
          true,
        );
      }
    }),
  );

  it.effect(
    "rejects a `confect/tables/*.ts` file that does not default-export an UnnamedTable",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const actual21 = yield* ConfectDirectory.get;
        const stowedPath = path.join(actual21, "tables", "stowed.ts");

        yield* Effect.gen(function* () {
          yield* fs.writeFileString(stowedPath, "export default {};\n");
          const tables = yield* discoverTables;
          const result = yield* Effect.result(validateTables(tables));

          assert(result._tag === "Failure");
          expect(result.failure._tag).toBe("InvalidTableDefaultExportError");
        }).pipe(Effect.ensuring(fs.remove(stowedPath).pipe(Effect.orDie)));
      }),
  );

  // Each rejected filename exercises a different validator branch:
  //   - "user-profiles.ts" violates the JS identifier pattern (dash).
  //   - "_internal.ts" starts with `_`, which is reserved for Convex system
  //     tables and excluded by `validateConfectTableIdentifier` even though
  //     `_internal` is a legal JS identifier.
  //   - "import.ts" is a legal-looking identifier but a reserved JS keyword,
  //     so emitting it as a binding in generated files would fail to parse.
  it.effect.each(["user-profiles.ts", "_internal.ts", "import.ts"])(
    "rejects table filename %s",
    (filename) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const actual22 = yield* ConfectDirectory.get;
        const invalidPath = path.join(actual22, "tables", filename);

        yield* Effect.gen(function* () {
          yield* fs.writeFileString(invalidPath, "export default {};\n");
          const result = yield* Effect.result(discoverTables);

          assert(result._tag === "Failure");
          expect(result.failure._tag).toBe("InvalidTableFilenameError");
        }).pipe(Effect.ensuring(fs.remove(invalidPath).pipe(Effect.orDie)));
      }),
  );

  // Names are derived from the basename alone, but the directory is scanned
  // recursively—so two files in different subdirectories can resolve to the
  // same table name. That must fail loudly rather than racing on a shared
  // generated wrapper path/emitting duplicate schema bindings. Two distinct
  // colliding names are seeded so we can assert that *all* collisions are
  // captured in a single pass, not just the first.
  it.effect("rejects every set of files that resolve to the same name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped();
      const tablesDir = path.join(tempDir, "tables");
      yield* fs.makeDirectory(path.join(tablesDir, "a"), { recursive: true });
      yield* fs.makeDirectory(path.join(tablesDir, "b"), { recursive: true });
      yield* fs.writeFileString(
        path.join(tablesDir, "a", "notes.ts"),
        "export default {};\n",
      );
      yield* fs.writeFileString(
        path.join(tablesDir, "b", "notes.ts"),
        "export default {};\n",
      );
      yield* fs.writeFileString(
        path.join(tablesDir, "a", "users.ts"),
        "export default {};\n",
      );
      yield* fs.writeFileString(
        path.join(tablesDir, "b", "users.ts"),
        "export default {};\n",
      );

      const services = yield* Layer.build(
        Layer.succeed(
          ConfectDirectory,
          ConfectDirectory.of({ get: Effect.succeed(tempDir) }),
        ),
      );
      const result = yield* Effect.result(
        discoverTables.pipe(Effect.provideContext(services)),
      );

      assert(result._tag === "Failure");
      assert(result.failure._tag === "DuplicateTableNameError");
      const byName = Rec.fromEntries(
        Array.map(result.failure.collisions, (c) => [
          c.tableName,
          [...c.tablePaths].sort(),
        ]),
      );
      expect(byName).toEqual({
        notes: [
          path.join("tables", "a", "notes.ts"),
          path.join("tables", "b", "notes.ts"),
        ],
        users: [
          path.join("tables", "a", "users.ts"),
          path.join("tables", "b", "users.ts"),
        ],
      });
    }).pipe(Effect.scoped),
  );

  it.effect("returns an empty array when there is no tables/ directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped();

      const services2 = yield* Layer.build(
        Layer.succeed(
          ConfectDirectory,
          ConfectDirectory.of({ get: Effect.succeed(tempDir) }),
        ),
      );
      const tables = yield* discoverTables.pipe(
        Effect.provideContext(services2),
      );

      expect(tables).toEqual([]);
    }).pipe(Effect.scoped),
  );

  // The "tables/ exists but has no .ts files" branch in `listTableFiles`
  // is structurally distinct from the missing-directory branch above
  // (different early return path) and deserves its own regression test;
  // both branches collapse to an empty result, which the codegen pipeline
  // promotes into a `⚠` warning at the call site (see `warnIfNoTables`).
  it.effect(
    "returns an empty array when tables/ exists but has no .ts files",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped();
        const tablesDir = path.join(tempDir, "tables");
        yield* fs.makeDirectory(tablesDir);
        yield* fs.writeFileString(path.join(tablesDir, ".gitkeep"), "");
        yield* fs.writeFileString(
          path.join(tablesDir, "README.md"),
          "tables go here\n",
        );

        const services3 = yield* Layer.build(
          Layer.succeed(
            ConfectDirectory,
            ConfectDirectory.of({ get: Effect.succeed(tempDir) }),
          ),
        );
        const tables = yield* discoverTables.pipe(
          Effect.provideContext(services3),
        );

        expect(tables).toEqual([]);
      }).pipe(Effect.scoped),
  );
});

const declarationProject = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const project = yield* Project.make;
  yield* fs.makeDirectory(
    path.join(project.root, "components/counter/convex"),
    {
      recursive: true,
    },
  );
  yield* project.write(
    "components/counter/convex/convex.config.ts",
    `import { defineComponent } from "convex/server";
import { v } from "convex/values";
export default defineComponent("counter", { env: { REQUIRED: v.string(), MARKER: v.optional(v.string()) } });
`,
  );
  yield* project.write(
    "confect/env.ts",
    `import { Env } from "@confect/core";
export default Env.make("host", {
  MARKER: Env.optional(Env.string()),
  API_KEY: Env.secret(),
  MODE: Env.literals(["live", "test"]),
});
`,
  );
  yield* project.write(
    "confect/app.ts",
    `import { App, Component, Mount } from "@confect/core";
import * as Schema from "effect/Schema";
import counter from "../components/counter/convex/convex.config";
import env from "./env";
const client = (native: unknown) => native;
const Counter = Component.make("counter", { env: { REQUIRED: Schema.String, MARKER: Schema.optionalKey(Schema.String) }, client });
export const First = Mount.make(Counter, { name: "first", httpPrefix: "/first", env: { REQUIRED: "first-required", MARKER: env.MARKER } });
export default App.make({
  env,
  components: [counter],
  mounts: [
    First,
    Mount.make(Counter, { name: "second", env: { REQUIRED: env.API_KEY } }),
  ],
});
`,
  );
  yield* project.write(
    "confect/auth.ts",
    `import { Auth } from "@confect/core";
import app, { First } from "./app";
export default Auth.make(app, {
  providers: [
    { type: "customJwt", applicationID: "host", issuer: Auth.siteUrl(), jwks: Auth.siteUrl(First, "/jwks.json"), algorithm: "RS256" },
    { domain: "https://login.example.test", applicationID: "host" },
  ],
});
`,
  );
  const http = (routePath: string) => `import { Http } from "@confect/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
const Api = HttpApi.make("host").add(
  HttpApiGroup.make("meta").add(HttpApiEndpoint.get("status", ${JSON.stringify(routePath)}, { success: Schema.String })),
);
const handlers = HttpApiBuilder.group(Api, "meta", (h) => h.handle("status", () => Effect.succeed("ok")));
export default Http.make({ api: Api, handlers });
`;
  yield* project.write("confect/http.ts", http("/status"));
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
  return { ...project, run, read, exists, http };
});

const expectedConvexConfig = `// Generated by \`confect codegen\` from confect/app.ts. Do not edit.
import { defineApp } from "convex/server";
import { v } from "convex/values";
import counter from "../components/counter/convex/convex.config.js";

const app = defineApp({
  env: {
    MARKER: v.optional(v.string()),
    API_KEY: v.string(),
    MODE: v.union(v.literal("live"), v.literal("test")),
  },
});

app.use(counter, {
  name: "first",
  httpPrefix: "/first",
  env: {
    REQUIRED: "first-required",
    MARKER: app.env.MARKER,
  },
});

app.use(counter, {
  name: "second",
  env: {
    REQUIRED: app.env.API_KEY,
  },
});

export default app;
`;

const expectedAuthConfig = `// Generated by \`confect codegen\` from confect/auth.ts. Do not edit.
import type { AuthConfig } from "convex/server";

export default {
  providers: [
    {
      type: "customJwt",
      applicationID: "host",
      issuer: \`\${process.env.CONVEX_SITE_URL}\`,
      jwks: \`\${process.env.CONVEX_SITE_URL}/first/jwks.json\`,
      algorithm: "RS256",
    },
    {
      domain: "https://login.example.test",
      applicationID: "host",
    },
  ],
} satisfies AuthConfig;
`;

const expectedManifest = (
  digest: string,
) => `// Generated by \`confect codegen\` from confect/env.ts and confect/app.ts. Do not edit.

export default {
  "name": "host",
  "env": {
    "MARKER": {
      "kind": "string",
      "optional": true
    },
    "API_KEY": {
      "kind": "secret",
      "optional": false
    },
    "MODE": {
      "kind": "literals",
      "values": [
        "live",
        "test"
      ],
      "optional": false
    }
  },
  "http": {
    "mounts": {
      "first": "/first"
    }
  },
  "digest": "${digest}"
} as const;
`;

const expectedHttp = `// Generated by \`confect codegen\` from confect/http.ts. Do not edit.
import { HttpRouter } from "@confect/server";
import schema from "../confect/_generated/schema.js";
import http from "../confect/http.js";

export default HttpRouter.make(schema, http.routes, { api: http.api });
`;

const KitManifest = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    type: Schema.optionalKey(Schema.String),
    exports: Schema.Record(Schema.String, Schema.String),
  }),
);

const kitProject = (files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const project = yield* declarationProject;
    yield* fs.makeDirectory(path.join(project.root, "node_modules/pool-kit"), {
      recursive: true,
    });
    const manifest = yield* Schema.decodeEffect(KitManifest)(
      files["package.json"] ??
        '{ "name": "pool-kit", "type": "module", "exports": { "./testing": "./testing.js" } }',
    );
    for (const [file, source] of Object.entries({
      ...files,
      "package.json": yield* Schema.encodeEffect(KitManifest)({
        ...manifest,
        exports: {
          "./convex.config": "./convex.config.js",
          ...manifest.exports,
        },
      }),
      "convex.config.js":
        'import { defineComponent } from "convex/server";\nexport default defineComponent("pool");\n',
    })) {
      yield* project.write(`node_modules/pool-kit/${file}`, source);
    }
    yield* project.write(
      "confect/app.ts",
      withMount(
        yield* project.read("confect/app.ts"),
        "workpool",
        "pool-kit/convex.config",
        'Mount.make(Component.make("pool", { client }), { name: "pool" })',
      ),
    );
    return project;
  });

/**
 * `app` with its `App.make` declaring the sections `confect/sections.ts`
 * exports.
 */
const declaring = (app: string) =>
  app
    .replace(
      'import env from "./env";',
      'import env from "./env";\nimport { manifestSections } from "./sections";',
    )
    .replace("  env,\n", "  env,\n  manifestSections,\n");

const withMount = (
  app: string,
  definition: string,
  specifier: string,
  mount: string,
) =>
  app
    .replace(
      'import env from "./env";',
      `import env from "./env";\nimport ${definition} from "${specifier}";`,
    )
    .replace("  components: [", `  components: [${definition}, `)
    .replace("  mounts: [", `  mounts: [\n    ${mount},`);

const stringLiteral = Schema.encodeSync(Schema.fromJsonString(Schema.String));

/**
 * A component package's test kit that registers the mount and `children` below
 * it, and records each registered path on `globalThis.registered`.
 */
const recordingKit = (children: ReadonlyArray<string>) =>
  `import { defineSchema } from "convex/server";
const modules = { "_generated/api.js": () => Promise.resolve({}) };
export function register(t, name) {
  for (const path of [name, ...[${children.map((child) => stringLiteral(child)).join(", ")}].map((child) => name + "/" + child)]) {
    (globalThis.registered ??= []).push(path);
    t.registerComponent(path, defineSchema({}), modules);
  }
}
`;

/**
 * `pool-kit`'s own `/test` kit misses the `batchWorker` child its component
 * mounts; `pool-frame/testing` registers it.
 */
const wrongKitProject = (testing: string | undefined) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const project = yield* kitProject({
      "package.json":
        '{ "name": "pool-kit", "type": "module", "exports": { "./test": "./test.js" } }',
      "test.js": recordingKit([]),
    });
    yield* fs.makeDirectory(
      path.join(project.root, "node_modules/pool-frame"),
      {
        recursive: true,
      },
    );
    yield* project.write(
      "node_modules/pool-frame/package.json",
      '{ "name": "pool-frame", "type": "module", "exports": { "./testing": "./testing.js", "./plain": "./plain.js" } }',
    );
    yield* project.write(
      "node_modules/pool-frame/testing.js",
      recordingKit(["batchWorker"]),
    );
    yield* project.write(
      "node_modules/pool-frame/plain.js",
      "export const layer = {};\n",
    );
    yield* project.write(
      "components/counter/convex/schema.ts",
      'import { defineSchema } from "convex/server";\nexport default defineSchema({});\n',
    );
    if (testing !== undefined) {
      yield* project.write(
        "confect/app.ts",
        (yield* project.read("confect/app.ts")).replace(
          'Component.make("pool", { client })',
          `Component.make("pool", { client, testing: ${stringLiteral(testing)} })`,
        ),
      );
    }
    return project;
  });

const digestOf = (manifest: string) =>
  /"digest": "(sha256:[0-9a-f]{64})"/.exec(manifest)?.[1] ?? "missing";

layer(Layer.mergeAll(NodePath.layer, NodeFileSystem.layer))(
  "codegenHandler with a backend declaration",
  (it) => {
    it.effect(
      "writes the Convex config, auth config, HTTP router and manifest from confect/",
      () =>
        Effect.gen(function* () {
          const project = yield* declarationProject;
          expect(yield* Project.writtenFiles(project.run)).not.toEqual([]);
          expect(yield* project.read("convex/convex.config.ts")).toBe(
            expectedConvexConfig,
          );
          expect(yield* project.read("convex/auth.config.ts")).toBe(
            expectedAuthConfig,
          );
          expect(yield* project.read("convex/http.ts")).toBe(expectedHttp);
          const manifest = yield* project.read(
            "confect/_generated/manifest.ts",
          );
          expect(manifest).toBe(expectedManifest(digestOf(manifest)));
          expect(
            yield* project.read("confect/_generated/components.ts"),
          ).toContain('"first": import(');
          const testing = yield* project.read("confect/_generated/testing.ts");
          expect(testing).toContain('import schema from "./schema.js"');
          expect(testing).toContain('"first": firstKit');
          expect(testing).toContain('"second": firstKit');
          expect(testing).toContain(
            'import firstSchema from "../../components/counter/convex/schema.js";',
          );
          expect(testing).toContain(
            '"notes.ts": () => import("../../convex/notes.js")',
          );
          expect(testing).toContain("() => import(");
          expect(
            yield* project.read("confect/_generated/schema.ts"),
          ).not.toContain("testing");
          expect(yield* Project.writtenFiles(project.run)).toEqual([]);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "keeps a root HTTP mount valid in the generated test app",
      () =>
        Effect.gen(function* () {
          const project = yield* declarationProject;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fs.remove(path.join(project.root, "confect/http.ts"));
          yield* project.write(
            "components/counter/convex/http.ts",
            "export default {};\n",
          );
          yield* project.write(
            "confect/app.ts",
            (yield* project.read("confect/app.ts")).replace(
              'httpPrefix: "/first"',
              'httpPrefix: "/"',
            ),
          );
          yield* project.run;
          expect(
            yield* project.read("confect/_generated/testing.ts"),
          ).toContain('httpPrefix: "/"');
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "registers a mounted package's component through its public test entry",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const project = yield* declarationProject;
          yield* project.write(
            "confect/app.ts",
            withMount(
              yield* project.read("confect/app.ts"),
              "workpool",
              "@convex-dev/workpool/convex.config",
              'Mount.make(Component.make("workpool", { client }), { name: "pool" })',
            ),
          );
          yield* project.run;
          const testing = yield* project.read("confect/_generated/testing.ts");
          expect(testing).toContain(
            'import * as poolKit from "@convex-dev/workpool/test";',
          );
          expect(testing).toContain('"pool": poolKit,');
          expect(testing.lastIndexOf("import ")).toBeLessThan(
            testing.indexOf("const firstKit"),
          );
          expect(testing).not.toContain(".pnpm");
          expect(testing).not.toContain("node_modules");
          const generated = path.join(project.root, "confect/_generated");
          const escaping = Array.filter(
            [...testing.matchAll(/(?:from |import\()"([^"]+)"/g)].map(
              ([, specifier]) => specifier!,
            ),
            (specifier) =>
              specifier.startsWith(".") &&
              !path
                .resolve(generated, specifier)
                .startsWith(project.root + path.sep),
          );
          expect(escaping).toEqual([]);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect.each([
      { entries: ["testing"], selected: "testing" },
      { entries: ["test"], selected: "test" },
      { entries: ["testing", "test"], selected: "testing" },
    ])(
      "discovers $selected from package entries $entries",
      ({ entries, selected }) =>
        Effect.gen(function* () {
          const project = yield* kitProject({
            "package.json": yield* Schema.encodeEffect(KitManifest)({
              name: "pool-kit",
              type: "module",
              exports: Object.fromEntries(
                entries.map((entry) => [`./${entry}`, `./${entry}.js`]),
              ),
            }),
            "testing.js": "export function register() {}\n",
            "test.js": "export function register() {}\n",
          });
          yield* project.run;
          const testing = yield* project.read("confect/_generated/testing.ts");
          expect(testing).toContain(
            `import * as poolKit from "pool-kit/${selected}";`,
          );
          expect(testing).not.toContain(
            `from "pool-kit/${selected === "testing" ? "test" : "testing"}"`,
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "discovers a mount test kit at the package testing entry",
      () =>
        Effect.gen(function* () {
          const project = yield* kitProject({
            "testing.js":
              "export function register(t, name) { t.registerComponent(name); }\n",
          });
          yield* project.run;
          const testing = yield* project.read("confect/_generated/testing.ts");
          expect(testing).toContain(
            'import * as poolKit from "pool-kit/testing";',
          );
          expect(testing).toContain('"pool": poolKit,');
          expect(testing).not.toContain("@convex-dev/workpool/test");
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect.each<{
      readonly shape: string;
      readonly files: Readonly<Record<string, string>>;
    }>([
      {
        shape: "a TypeScript barrel re-exporting another module",
        files: {
          "package.json":
            '{ "name": "pool-kit", "type": "module", "exports": { "./testing": "./testing.ts", "./impl": "./impl.js" } }\n',
          "testing.ts": 'export * from "pool-kit/impl";\n',
          "impl.js": "export function register(t, name) {}\n",
        },
      },
      {
        shape: "a CommonJS module setting exports.register",
        files: {
          "package.json":
            '{ "name": "pool-kit", "exports": { "./testing": "./testing.js" } }\n',
          "testing.js": "exports.register = function () {};\n",
        },
      },
      {
        shape: "a CommonJS module assigning module.exports",
        files: {
          "package.json":
            '{ "name": "pool-kit", "exports": { "./testing": "./testing.js" } }\n',
          "testing.js":
            "function register() {}\nmodule.exports = { register };\n",
        },
      },
    ])(
      "registers a mount through a test kit that is $shape",
      ({ files }) =>
        Effect.gen(function* () {
          const project = yield* kitProject(files);
          yield* project.run;
          expect(
            yield* project.read("confect/_generated/testing.ts"),
          ).toContain('import * as poolKit from "pool-kit/testing";');
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect.each<{
      readonly testing: string | undefined;
      readonly kit: string;
      readonly registered: ReadonlyArray<string>;
    }>([
      { testing: undefined, kit: "pool-kit/test", registered: ["pool"] },
      {
        testing: "pool-frame/testing",
        kit: "pool-frame/testing",
        registered: ["pool", "pool/batchWorker"],
      },
    ])(
      "registers a mount through $kit when its descriptor names $testing",
      ({ testing, kit, registered }) =>
        Effect.gen(function* () {
          const project = yield* wrongKitProject(testing);
          yield* project.run;
          const generated = yield* project.read(
            "confect/_generated/testing.ts",
          );
          expect(generated).toContain(`import * as poolKit from "${kit}";`);
          const { module } = yield* Bundler.bundle(
            `${project.root}/confect/_generated/testing.ts`,
          );
          const state = globalThis as { registered?: Array<string> };
          state.registered = [];
          const databaseSchema = DatabaseSchema.make({});
          yield* TestConfect.TestConfect<typeof databaseSchema>().pipe(
            Effect.provide(
              TestConfect.layer({
                schema: databaseSchema,
                convexSchema: defineSchema({}),
                modules: { "_generated/server.ts": () => Promise.resolve({}) },
                components: { pool: module.default.components.pool },
                httpMounts: [],
              }),
            ),
          );
          expect(state.registered).toEqual(registered);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect.each([
      {
        testing: "pool-frame/missing",
        problem: ", which does not resolve from convex/convex.config.ts.",
      },
      {
        testing: "pool-frame/plain",
        problem: ", which does not export `register(t, name)`.",
      },
      {
        testing: "./testing.js",
        problem:
          '; name it by a package specifier, such as "<package>/testing".',
      },
    ])(
      "refuses a descriptor's test kit $testing",
      ({ testing, problem }) =>
        Effect.gen(function* () {
          const project = yield* wrongKitProject(testing);
          expect(yield* Effect.flip(project.run)).toEqual(
            new InvalidDeclarationError({
              declarationPath: "confect/app.ts",
              reason: `the mount "pool" names the test kit ${stringLiteral(testing)} in its component descriptor${problem}`,
            }),
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "keeps nested HTTP mounts for local components",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const project = yield* kitProject({
            "testing.js":
              "export function register(t, name) { t.registerComponent(name); }\n",
          });
          for (const component of ["child", "parent"]) {
            yield* fs.makeDirectory(
              path.join(project.root, "components", component, "convex"),
              { recursive: true },
            );
          }
          yield* project.write(
            "components/child/convex/convex.config.ts",
            'import { defineComponent } from "convex/server";\nexport default defineComponent("child");\n',
          );
          yield* project.write(
            "components/child/convex/http.ts",
            "export default {};\n",
          );
          yield* project.write(
            "components/parent/convex/convex.config.ts",
            'import { defineComponent } from "convex/server";\nimport child from "../../child/convex/convex.config.js";\nconst parent = defineComponent("parent");\nparent.use(child, { name: "b", httpPrefix: "/b" });\nexport default parent;\n',
          );
          yield* project.write(
            "confect/app.ts",
            (yield* project.read("confect/app.ts"))
              .replace(
                'import env from "./env";',
                'import env from "./env";\nimport parent from "../components/parent/convex/convex.config.js";',
              )
              .replace("[workpool, ", "[parent, ")
              .replace(
                'Component.make("pool", { client }), { name: "pool" }',
                'Component.make("parent", { client, testing: "pool-kit/testing" }), { name: "pool", httpPrefix: "/pool" }',
              ),
          );
          yield* project.run;
          const testing = yield* project.read("confect/_generated/testing.ts");
          expect(/httpMounts: (\[[^\]]*\])/.exec(testing)?.[1]).toBe(
            '[{ componentPath: "pool/b", httpPrefix: "/pool/b" }]',
          );
          expect(testing).toContain('"pool": poolKit,');
          expect(testing).toContain('"pool/b": pool_bKit,');
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "sanitizes nested mount names and suffixes colliding kits",
      () =>
        Effect.gen(function* () {
          const project = yield* declarationProject;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          for (const component of ["child", "parent"]) {
            yield* fs.makeDirectory(
              path.join(project.root, "components", component, "convex"),
              { recursive: true },
            );
          }
          yield* project.write(
            "components/child/convex/convex.config.ts",
            'import { defineComponent } from "convex/server";\nexport default defineComponent("child");\n',
          );
          yield* project.write(
            "components/parent/convex/convex.config.ts",
            'import { defineComponent } from "convex/server";\nimport child from "../../child/convex/convex.config.js";\nconst parent = defineComponent("parent");\nparent.use(child, { name: "b" });\nexport default parent;\n',
          );
          yield* project.write(
            "confect/app.ts",
            withMount(
              yield* project.read("confect/app.ts"),
              "parent",
              "../components/parent/convex/convex.config.js",
              'Mount.make(Component.make("parent", { client }), { name: "a" })',
            ).replace('name: "first"', 'name: "a_b"'),
          );
          yield* project.run;
          const testing = yield* project.read("confect/_generated/testing.ts");
          expect(testing).toContain('"a/b": a_bKit,');
          expect(testing).toContain('"a_b": a_bKit2,');
          expect(testing).toContain('"second": a_bKit2,');
          expect(testing).toContain(
            'import a_bSchema from "../../components/child/convex/schema.js";',
          );
          expect(testing).toContain(
            'import a_bSchema2 from "../../components/counter/convex/schema.js";',
          );
          expect(testing.lastIndexOf("import ")).toBeLessThan(
            testing.indexOf("const aKit"),
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "rejects a mounted package's component without a test entry",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const project = yield* declarationProject;
          yield* fs.makeDirectory(
            path.join(project.root, "node_modules/no-test-kit"),
            { recursive: true },
          );
          yield* project.write(
            "node_modules/no-test-kit/package.json",
            '{ "name": "no-test-kit", "type": "module", "exports": { "./convex.config": "./convex.config.js" } }\n',
          );
          yield* project.write(
            "node_modules/no-test-kit/convex.config.js",
            'import { defineComponent } from "convex/server";\nexport default defineComponent("noTestKit");\n',
          );
          yield* project.write(
            "confect/app.ts",
            withMount(
              yield* project.read("confect/app.ts"),
              "kit",
              "no-test-kit/convex.config",
              'Mount.make(Component.make("noTestKit", { client }), { name: "kit" })',
            ),
          );
          expect(yield* Effect.flip(project.run)).toEqual(
            new InvalidConvexConfigError({
              configPath: "../../convex/convex.config.ts",
              reason:
                'the component package "no-test-kit" has no "no-test-kit/testing" or "no-test-kit/test" export. Tests register a component from another package through that entry\'s `register(t, name)`.',
            }),
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "changes the manifest digest when a declaration input changes",
      () =>
        Effect.gen(function* () {
          const project = yield* declarationProject;
          yield* project.run;
          const before = digestOf(
            yield* project.read("confect/_generated/manifest.ts"),
          );
          yield* project.write(
            "confect/env.ts",
            `${yield* project.read("confect/env.ts")}// edited\n`,
          );
          yield* project.run;
          const after = digestOf(
            yield* project.read("confect/_generated/manifest.ts"),
          );
          expect(after).not.toBe(before);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "rejects duplicate routes in a component's own HTTP declaration",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const project = yield* declarationProject;
          const fs = yield* FileSystem.FileSystem;
          yield* fs.remove(path.join(project.root, "confect/auth.ts"));
          yield* project.write(
            "confect/app.ts",
            (yield* project.read("confect/app.ts")).replace(
              "  env,",
              '  kind: "component",\n  env,',
            ),
          );
          yield* project.write(
            "confect/http.ts",
            project
              .http("/items/:id")
              .replace(
                'HttpApiEndpoint.get("status", "/items/:id", { success: Schema.String })',
                'HttpApiEndpoint.get("status", "/items/:id", { params: Schema.Struct({ id: Schema.String }), success: Schema.String }), HttpApiEndpoint.get("other", "/items/:key", { params: Schema.Struct({ key: Schema.String }), success: Schema.String })',
              )
              .replace(
                'h.handle("status", () => Effect.succeed("ok"))',
                'h.handle("status", () => Effect.succeed("ok")).handle("other", () => Effect.succeed("ok"))',
              ),
          );
          const run = codegenHandler.pipe(
            Effect.provideService(ProjectRoot, {
              get: Effect.succeed(project.root),
            }),
            Effect.provideService(ConfectDirectory, {
              get: Effect.succeed(path.join(project.root, "confect")),
            }),
            Effect.provideService(ConvexDirectory, {
              get: Effect.succeed(path.join(project.root, "convex")),
              target: { kind: "component", scope: IdScope.component("host") },
            }),
          );
          expect(yield* Effect.flip(run)).toEqual(
            new InvalidDeclarationError({
              declarationPath: "confect/http.ts",
              reason: "GET /items/:key is declared twice (app and app).",
            }),
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "rejects an app route under a mount's HTTP prefix",
      () =>
        Effect.gen(function* () {
          const project = yield* declarationProject;
          yield* project.write(
            "confect/http.ts",
            project.http("/first/status"),
          );
          expect(yield* Effect.flip(project.run)).toEqual(
            new InvalidDeclarationError({
              declarationPath: "confect/http.ts",
              reason:
                'The app route GET /first/status is under the HTTP prefix /first of the mount "first". Convex would let it shadow the component\'s routes; move it or change the prefix.',
            }),
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "rejects overlapping mount prefixes without a confect/http.ts",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const project = yield* declarationProject;
          yield* fs.remove(path.join(project.root, "confect/http.ts"));
          yield* project.write(
            "confect/app.ts",
            (yield* project.read("confect/app.ts")).replace(
              "env: { REQUIRED: env.API_KEY }",
              'httpPrefix: "/first/nested", env: { REQUIRED: env.API_KEY }',
            ),
          );
          expect(yield* Effect.flip(project.run)).toEqual(
            new InvalidDeclarationError({
              declarationPath: "confect/app.ts",
              reason:
                'The mounts "first" (/first) and "second" (/first/nested) have overlapping HTTP prefixes.',
            }),
          );
          expect(yield* project.exists("confect/_generated/manifest.ts")).toBe(
            false,
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "refuses to overwrite a hand-written convex.config.ts",
      () =>
        Effect.gen(function* () {
          const project = yield* declarationProject;
          const handWritten = `import { defineApp } from "convex/server";\nexport default defineApp();\n`;
          yield* project.write("convex/convex.config.ts", handWritten);
          expect(yield* Effect.flip(project.run)).toEqual(
            new HandWrittenConvexFileError({
              convexPath: "convex/convex.config.ts",
              declarationPath: "confect/app.ts",
            }),
          );
          expect(yield* project.read("convex/convex.config.ts")).toBe(
            handWritten,
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "refuses to overwrite a hand-written auth.config.ts",
      () =>
        Effect.gen(function* () {
          const project = yield* declarationProject;
          const handWritten = "export default { providers: [] };\n";
          yield* project.write("convex/auth.config.ts", handWritten);
          expect(yield* Effect.flip(project.run)).toEqual(
            new HandWrittenConvexFileError({
              convexPath: "convex/auth.config.ts",
              declarationPath: "confect/auth.ts",
            }),
          );
          expect(yield* project.read("convex/auth.config.ts")).toBe(
            handWritten,
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "reports an app.ts mistake against app.ts when auth.ts exists",
      () =>
        Effect.gen(function* () {
          const project = yield* declarationProject;
          yield* project.write(
            "confect/app.ts",
            (yield* project.read("confect/app.ts")).replace(
              'name: "first"',
              'name: "first-mount"',
            ),
          );
          expect(yield* Effect.flip(project.run)).toEqual(
            new InvalidDeclarationError({
              declarationPath: "confect/app.ts",
              reason:
                '"first-mount" is not a valid mount name; use letters, digits and underscores, starting with a letter or underscore.',
            }),
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect.each(["", ".js"])(
      "replaces the auth.config.ts re-export an earlier codegen wrote with extension %s",
      (extension) =>
        Effect.gen(function* () {
          const project = yield* declarationProject;
          yield* project.write(
            "convex/auth.config.ts",
            `import auth from "../confect/auth${extension}";\n\nexport default auth;\n`,
          );
          yield* project.run;
          expect(yield* project.read("convex/auth.config.ts")).toBe(
            expectedAuthConfig,
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "removes the generated HTTP router when confect/http.ts is deleted",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const project = yield* declarationProject;
          yield* project.run;
          yield* fs.remove(path.join(project.root, "confect/http.ts"));
          yield* project.run;
          expect(yield* project.exists("convex/http.ts")).toBe(false);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "removes the manifest when the backend opts out",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const project = yield* declarationProject;
          yield* project.run;
          for (const file of ["app.ts", "auth.ts", "http.ts"]) {
            yield* fs.remove(path.join(project.root, "confect", file));
          }
          yield* project.run;
          expect(yield* project.exists("confect/_generated/manifest.ts")).toBe(
            false,
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "removes the manifest when the declaration stops producing one",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const project = yield* declarationProject;
          yield* project.run;
          yield* fs.remove(path.join(project.root, "confect/auth.ts"));
          yield* fs.remove(path.join(project.root, "confect/http.ts"));
          yield* project.write(
            "confect/app.ts",
            'export default { env: "not an app" };\n',
          );
          expect((yield* Effect.flip(project.run))._tag).toBe(
            "InvalidDeclarationError",
          );
          expect(yield* project.exists("confect/_generated/manifest.ts")).toBe(
            false,
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );
  },
);

/**
 * The declaration project whose `App.make` declares an `observe` section that
 * generates `observe.ts` from every `*\/log.ts` by `render`, then `sections`.
 */
const sectionProject = (render: string, sections = "") =>
  Effect.gen(function* () {
    const project = yield* declarationProject;
    const declare = (generate: string) =>
      project.write(
        "confect/sections.ts",
        `const observe = { owner: "test/observe", format: 1, describe: () => null${generate} };
export const manifestSections = [{ key: "observe", section: observe }${sections}];`,
      );
    yield* declare(
      `, generate: { file: "observe.ts", match: (path) => path.endsWith("/log.ts"), render: ${render} }`,
    );
    yield* project.write(
      "confect/app.ts",
      declaring(yield* project.read("confect/app.ts")),
    );
    const fs = yield* FileSystem.FileSystem;
    for (const directory of ["billing", "fees"])
      yield* fs.makeDirectory(`${project.root}/confect/${directory}`);
    yield* project.write(
      "confect/billing/log.ts",
      'export const billingLog = { module: "billing" };\n',
    );
    yield* project.write("confect/billing/fees.ts", "export const fee = 1;\n");
    return { ...project, withoutGenerate: declare("") };
  });

const refusing =
  '({ modules }) => modules[0].exports.door.refuse ? ["first refusal", "second refusal"] : []';

/**
 * The section project with a second section, `doors`, that writes `doors.ts`
 * and verifies `door.ts` by `check`. `door.ts` imports the generated `doors.ts`
 * and the declaration, and `door` sets whether it asks to be refused.
 */
const verifyProject = (check: string) =>
  Effect.gen(function* () {
    const project = yield* sectionProject(
      '() => ({ contents: "export {};\\n", errors: [] })',
      `, { key: "doors", section: { owner: "test/doors", format: 1, describe: () => null, generate: { file: "doors.ts", match: () => false, render: () => ({ contents: "export default 'rendered';\\n", errors: [] }), verify: { match: (path) => path === "door.ts", check: ${check} } } } }`,
    );
    const door = (refuse: boolean) =>
      project.write(
        "confect/door.ts",
        `import rendered from "./_generated/doors";
import app from "./app";
export const door = { rendered, mounts: app.mounts.length, refuse: ${refuse} };
`,
      );
    yield* door(false);
    return { ...project, door };
  });

layer(Layer.mergeAll(NodePath.layer, NodeFileSystem.layer))(
  "codegenHandler with a generating manifest section",
  (it) => {
    it.effect(
      "renders matched modules, every function and each mount into the section's file",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const project = yield* sectionProject(
            "(input) => ({ contents: `export default ${JSON.stringify(input)};\\n`, errors: [] })",
          );
          yield* project.write(
            "confect/app.ts",
            withMount(
              yield* project.read("confect/app.ts"),
              "workpool",
              "@convex-dev/workpool/convex.config",
              'Mount.make(Component.make("workpool", { client }), { name: "pool" })',
            ),
          );
          yield* project.run;
          const generated = yield* project.read(
            "confect/_generated/observe.ts",
          );
          expect(generated.split("\n").slice(0, 2)).toEqual([
            '// Generated by `confect codegen` from the manifest section "observe". Do not edit.',
            '// Sources: ["billing/log.ts"]',
          ]);
          const { module } = yield* Bundler.bundle(
            `${project.root}/confect/_generated/observe.ts`,
          );
          expect(module.default).toEqual({
            modules: [
              {
                relativePath: "billing/log.ts",
                exports: { billingLog: { module: "billing" } },
              },
            ],
            functions: [{ path: "notes:list", source: "notes.spec.ts" }],
            mounts: [
              { name: "first", definition: "../../components/counter/convex" },
              { name: "pool", definition: "@convex-dev/workpool" },
              { name: "second", definition: "../../components/counter/convex" },
            ],
            files: [
              "app.ts",
              "auth.ts",
              "billing/fees.ts",
              "billing/log.ts",
              "env.ts",
              "http.ts",
              "notes.impl.ts",
              "notes.spec.ts",
              "sections.ts",
              "tables/notes.ts",
            ],
            target: { kind: "app" },
            confectDirectory: path.join(project.root, "confect"),
          });
          expect(yield* Project.writtenFiles(project.run)).toEqual([]);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "renders every file match was offered, including a folder match accepted nothing from",
      () =>
        Effect.gen(function* () {
          const project = yield* sectionProject(
            "({ files }) => ({ contents: `export default ${JSON.stringify(files)};\\n`, errors: [] })",
          );
          yield* project.write(
            "confect/sections.ts",
            (yield* project.read("confect/sections.ts")).replace(
              'match: (path) => path.endsWith("/log.ts")',
              "match: () => false",
            ),
          );
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(`${project.root}/confect/shelf`);
          yield* project.write(
            "confect/shelf/log.ts",
            "export const shelfLog = {};\n",
          );
          yield* project.run;
          const generated = yield* project.read(
            "confect/_generated/observe.ts",
          );
          expect(generated.split("\n")[1]).toBe("// Sources: []");
          const { module } = yield* Bundler.bundle(
            `${project.root}/confect/_generated/observe.ts`,
          );
          expect(module.default).toEqual([
            "app.ts",
            "auth.ts",
            "billing/fees.ts",
            "billing/log.ts",
            "env.ts",
            "http.ts",
            "notes.impl.ts",
            "notes.spec.ts",
            "sections.ts",
            "shelf/log.ts",
            "tables/notes.ts",
          ]);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "writes the data summarize builds from matched modules and checks it, in full and incremental runs",
      () =>
        Effect.gen(function* () {
          const project = yield* sectionProject(
            '() => ({ contents: "export {};\\n", errors: [] })',
          );
          yield* project.write(
            "confect/sections.ts",
            (yield* project.read("confect/sections.ts")).replace(
              "describe: () => null",
              `describe: ({ path }) => path,
summarize: ({ modules, functions }) => ({ format: 1, owners: modules.map(({ exports }) => exports.billingLog.module), functions }),
check: (next) => ({ errors: next.owners.includes("stale") ? ["stale owner"] : [], notes: [] })`,
            ),
          );
          const observe = Bundler.bundle(
            `${project.root}/confect/_generated/manifest.ts`,
          ).pipe(Effect.map(({ module }) => module.default.observe));
          const owner = (module: string) =>
            project.write(
              "confect/billing/log.ts",
              `export const billingLog = { module: "${module}" };\n`,
            );
          const { snapshot } = yield* project.provide(generateWithSnapshot);
          yield* owner("fees");
          yield* project.run;
          expect(yield* observe).toEqual({
            format: 1,
            owners: ["fees"],
            functions: { "notes:list": "notes:list" },
          });
          yield* owner("billing");
          yield* project.provide(
            updateDeclarations(
              snapshot,
              [
                {
                  _tag: "Spec",
                  relativePath: SpecModulePath.make("notes.spec.ts"),
                },
              ],
              [],
            ),
          );
          expect(yield* observe).toMatchObject({ owners: ["billing"] });
          yield* owner("stale");
          expect(yield* Effect.flip(project.run)).toMatchObject({
            _tag: "InvalidManifestSectionError",
            sectionKey: "observe",
            reason: "stale owner",
          });
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "reports every section's render errors and writes no file",
      () =>
        Effect.gen(function* () {
          const project = yield* sectionProject(
            '() => ({ contents: "", errors: ["first refusal", "second refusal"] })',
            ', { key: "trace", section: { owner: "test/trace", format: 1, describe: () => null, generate: { file: "trace.ts", match: () => false, render: () => ({ contents: "", errors: ["third refusal", "fourth refusal"] }) } } }',
          );
          const messages: unknown[] = [];
          const error = yield* Effect.flip(
            project.run.pipe(
              Effect.provideService(
                Console.Console,
                Object.assign(Object.create(console), {
                  error: (...args: readonly unknown[]) =>
                    messages.push(...args),
                }),
              ),
            ),
          );
          expect(error).toMatchObject({
            _tag: "InvalidManifestSectionError",
            sectionKey: "observe",
            reason: "first refusal",
          });
          expect(messages.join("\n")).toContain(
            'Manifest section "observe" is invalid: second refusal',
          );
          for (const reason of ["third refusal", "fourth refusal"])
            expect(messages.join("\n")).toContain(
              `Manifest section "trace" is invalid: ${reason}`,
            );
          expect(yield* project.exists("confect/_generated/observe.ts")).toBe(
            false,
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "imports the section file ahead of each impl and the HTTP router, in full and incremental runs",
      () =>
        Effect.gen(function* () {
          const project = yield* sectionProject(
            '() => ({ contents: "export {};\\n", errors: [] })',
          );
          const { snapshot } = yield* project.provide(generateWithSnapshot);
          const imports = Effect.all([
            project.read("confect/_generated/registeredFunctions/notes.ts"),
            project.read("convex/http.ts"),
          ]).pipe(
            Effect.map(([registration, http]) => [
              registration.split("\n")[0],
              http.split("\n")[1],
            ]),
          );
          expect(yield* imports).toEqual([
            'import "../observe.js";',
            'import "../confect/_generated/observe.js";',
          ]);
          const update = updateDeclarations(
            snapshot,
            [
              {
                _tag: "Spec",
                relativePath: SpecModulePath.make("notes.spec.ts"),
              },
            ],
            [],
          );
          yield* project.write(
            "confect/notes.spec.ts",
            (yield* project.read("confect/notes.spec.ts")).replace(
              'name: "list"',
              'name: "list", description: "edited"',
            ),
          );
          yield* project.provide(update);
          expect(yield* imports).toEqual([
            'import "../observe.js";',
            'import "../confect/_generated/observe.js";',
          ]);
          yield* project.withoutGenerate;
          yield* project.provide(update);
          expect(yield* project.exists("confect/_generated/observe.ts")).toBe(
            false,
          );
          expect(yield* imports).toEqual([
            'import { ConvexFunctionDefinitions, RegisteredConvexFunction, type RegisteredFunctions } from "@confect/server";',
            'import { HttpRouter } from "@confect/server";',
          ]);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "refuses an HTTP router import of a generated file no section wrote",
      () =>
        Effect.gen(function* () {
          const project = yield* sectionProject(
            '() => ({ contents: "export {};\\n", errors: [] })',
          );
          yield* project.run;
          yield* project.write("confect/_generated/manual.ts", "export {};\n");
          const router = `import "../confect/_generated/manual.js";\n${yield* project.read("convex/http.ts")}`;
          yield* project.write("convex/http.ts", router);
          expect(yield* Effect.flip(project.run)).toMatchObject({
            _tag: "UnownedConvexEntrypointError",
            filePaths: ["convex/http.ts"],
          });
          expect(yield* project.read("convex/http.ts")).toBe(router);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "regenerates from an empty _generated an HTTP router that imports the section file",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const project = yield* sectionProject(
            '() => ({ contents: "export {};\\n", errors: [] })',
          );
          yield* project.run;
          const router = yield* project.read("convex/http.ts");
          yield* fs.remove(`${project.root}/confect/_generated`, {
            recursive: true,
          });
          yield* project.run;
          expect(yield* project.read("convex/http.ts")).toBe(router);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "records each matched file and its confect imports through refusals",
      () =>
        Effect.gen(function* () {
          const project = yield* sectionProject(
            '() => ({ contents: "", errors: ["refusal"] })',
          );
          yield* project.write("confect/billing/helper.ts", "export {};\n");
          yield* project.write(
            "confect/billing/log.ts",
            'import "./helper";\nimport "../_generated/id";\n',
          );
          yield* Effect.flip(project.run);
          const record = "confect/_generated/sectionInputs.json";
          expect(yield* project.read(record)).toBe(
            '["billing/helper.ts","billing/log.ts"]',
          );
          yield* project.write(
            "confect/billing/helper.ts",
            "export const = ;\n",
          );
          yield* Effect.flip(project.run);
          expect(yield* project.read(record)).toBe(
            '["billing/helper.ts","billing/log.ts"]',
          );
          yield* project.withoutGenerate;
          yield* project.run;
          expect(yield* project.exists(record)).toBe(false);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "removes the file once no section claims it",
      () =>
        Effect.gen(function* () {
          const project = yield* sectionProject(
            '() => ({ contents: "export {};\\n", errors: [] })',
          );
          yield* project.run;
          yield* project.write("confect/_generated/kept.ts", "export {};\n");
          expect(yield* project.exists("confect/_generated/observe.ts")).toBe(
            true,
          );
          yield* project.withoutGenerate;
          yield* project.run;
          expect(yield* project.exists("confect/_generated/observe.ts")).toBe(
            false,
          );
          expect(yield* project.exists("confect/_generated/kept.ts")).toBe(
            true,
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect.each(["full", "incremental"])(
      "keeps an unclaimed file the router imports until %s codegen rewrites the router",
      (mode) =>
        Effect.gen(function* () {
          const project = yield* sectionProject(
            '() => ({ contents: "export {};\\n", errors: [] })',
          );
          const { snapshot } = yield* project.provide(generateWithSnapshot);
          const update = project.provide(
            updateDeclarations(
              snapshot,
              [
                {
                  _tag: "Spec",
                  relativePath: SpecModulePath.make("notes.spec.ts"),
                },
              ],
              [],
            ),
          );
          const rerun =
            mode === "full"
              ? Effect.asVoid(project.run)
              : Effect.asVoid(update);
          const impl = yield* project.read("confect/notes.impl.ts");
          yield* project.withoutGenerate;
          yield* project.write(
            "confect/notes.impl.ts",
            'throw new Error("broken impl");\n',
          );
          yield* Effect.flip(rerun);
          expect(yield* project.exists("confect/_generated/observe.ts")).toBe(
            true,
          );
          yield* project.write("confect/notes.impl.ts", impl);
          yield* rerun;
          expect(yield* project.exists("confect/_generated/observe.ts")).toBe(
            false,
          );
          expect(yield* project.read("convex/http.ts")).not.toContain(
            "observe",
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "refuses a section file named like one codegen writes",
      () =>
        Effect.gen(function* () {
          const project = yield* sectionProject(
            '() => ({ contents: "export {};\\n", errors: [] })',
          );
          yield* project.write(
            "confect/sections.ts",
            (yield* project.read("confect/sections.ts")).replace(
              '"observe.ts"',
              '"spec.ts"',
            ),
          );
          expect(yield* Effect.flip(project.run)).toMatchObject({
            _tag: "InvalidManifestSectionError",
            sectionKey: "observe",
            reason:
              "claims confect/_generated/spec.ts, which codegen writes itself.",
          });
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "names every file it writes directly in _generated as built in",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const project = yield* declarationProject;
          yield* project.run;
          const written = yield* fs.readDirectory(
            `${project.root}/confect/_generated`,
          );
          expect(
            written.filter(
              (file) => file.endsWith(".ts") && !SectionFiles.builtIn.has(file),
            ),
          ).toEqual([]);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "writes a declared section's file and manifest entry for a backend with no functions",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const project = yield* sectionProject(
            '() => ({ contents: "export {};\\n", errors: [] })',
          );
          for (const file of ["notes.spec.ts", "notes.impl.ts"])
            yield* fs.remove(`${project.root}/confect/${file}`);
          yield* project.run;
          expect(yield* project.exists("confect/_generated/observe.ts")).toBe(
            true,
          );
          expect((yield* project.read("convex/http.ts")).split("\n")[1]).toBe(
            'import "../confect/_generated/observe.js";',
          );
          const { module } = yield* Bundler.bundle(
            `${project.root}/confect/_generated/manifest.ts`,
          );
          expect(module.default.observe).toEqual({ format: 1, functions: {} });
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect.each([false, true])(
      "fails codegen with each refusal verify returns (incremental=%s)",
      (incremental) =>
        Effect.gen(function* () {
          const project = yield* verifyProject(refusing);
          const { snapshot } = yield* project.provide(generateWithSnapshot);
          yield* project.door(true);
          const messages: unknown[] = [];
          const error = yield* Effect.flip(
            project
              .provide(
                incremental
                  ? updateDeclarations(
                      snapshot,
                      [
                        {
                          _tag: "Spec",
                          relativePath: SpecModulePath.make("notes.spec.ts"),
                        },
                      ],
                      [],
                    ).pipe(Effect.asVoid)
                  : generateWithSnapshot.pipe(Effect.asVoid),
              )
              .pipe(
                Effect.provideService(
                  Console.Console,
                  Object.assign(Object.create(console), {
                    error: (...args: readonly unknown[]) =>
                      messages.push(...args),
                  }),
                ),
              ),
          );
          expect(error).toMatchObject({
            _tag: "InvalidManifestSectionError",
            sectionKey: "doors",
            reason: "first refusal",
          });
          expect(messages.join("\n")).toContain(
            'Manifest section "doors" is invalid: second refusal',
          );
          yield* project.door(false);
          yield* project.run;
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "passes when verify returns no refusal, and records the files it loaded",
      () =>
        Effect.gen(function* () {
          const project = yield* verifyProject(refusing);
          yield* project.run;
          expect(
            yield* project.read("confect/_generated/verifyInputs.json"),
          ).toBe('["app.ts","door.ts","env.ts","sections.ts"]');
          expect(yield* Project.writtenFiles(project.run)).toEqual([]);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "hands check only the files match selects, with the mounts and the target",
      () =>
        Effect.gen(function* () {
          const project = yield* verifyProject(
            "(input) => [JSON.stringify({ modules: input.modules.map(({ relativePath, exports }) => [relativePath, exports.door.refuse]), mounts: input.mounts, target: input.target })]",
          );
          const error = yield* Effect.flip(project.run);
          assert(error._tag === "InvalidManifestSectionError");
          expect(
            yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
              error.reason,
            ),
          ).toEqual({
            modules: [["door.ts", false]],
            mounts: [
              { name: "first", definition: "../../components/counter/convex" },
              { name: "second", definition: "../../components/counter/convex" },
            ],
            target: { kind: "app" },
          });
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "loads a matched file that imports another generated file",
      () =>
        Effect.gen(function* () {
          const project = yield* verifyProject(
            "({ modules }) => [`door read ${modules[0].exports.door.rendered}`]",
          );
          expect(yield* Effect.flip(project.run)).toMatchObject({
            _tag: "InvalidManifestSectionError",
            sectionKey: "doors",
            reason: "door read rendered",
          });
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "runs verify for a backend with no functions",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const project = yield* verifyProject(refusing);
          for (const file of ["notes.spec.ts", "notes.impl.ts"])
            yield* fs.remove(`${project.root}/confect/${file}`);
          yield* project.door(true);
          expect(yield* Effect.flip(project.run)).toMatchObject({
            _tag: "InvalidManifestSectionError",
            sectionKey: "doors",
            reason: "first refusal",
          });
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "keeps no verify record while no section verifies",
      () =>
        Effect.gen(function* () {
          const project = yield* verifyProject(refusing);
          yield* project.run;
          yield* project.write(
            "confect/sections.ts",
            (yield* project.read("confect/sections.ts")).replace(
              /, verify: .*$/m,
              " } } }];",
            ),
          );
          yield* project.run;
          expect(
            yield* project.exists("confect/_generated/verifyInputs.json"),
          ).toBe(false);
          expect(yield* Project.writtenFiles(project.run)).toEqual([]);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "leaves generated output unchanged while no section generates",
      () =>
        Effect.gen(function* () {
          const project = yield* sectionProject("undefined");
          yield* project.withoutGenerate;
          yield* project.write("confect/billing/log.ts", "export {};\n");
          yield* project.run;
          yield* project.write("confect/fees/log.ts", "export {};\n");
          expect(yield* Project.writtenFiles(project.run)).toEqual([]);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );
  },
);

const initProject = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const project = yield* declarationProject;
  yield* fs.makeDirectory(path.join(project.root, "components/email/convex"), {
    recursive: true,
  });
  yield* project.write(
    "components/email/convex/convex.config.ts",
    `import { defineComponent } from "convex/server";
export default defineComponent("email");
`,
  );
  const mountFile = (
    name: string,
    exported: string,
  ) => `import { Component, FunctionSpec, Mount, Ref } from "@confect/core";
import * as Schema from "effect/Schema";
const init = Ref.make("install", FunctionSpec.internalMutation({ name: "init", args: () => ({ fromName: Schema.String }), returns: () => Schema.Null }));
const Email = Component.make("email", { init, client: (native: unknown) => native });
export const ${exported} = Mount.make(Email, { name: "${name}", args: { fromName: "School office" } });
`;
  yield* project.write(
    "confect/bulkEmail.ts",
    mountFile("bulkEmail", "BulkEmail"),
  );
  const original = yield* project.read("confect/app.ts");
  yield* project.write(
    "confect/app.ts",
    withMount(
      original,
      "email",
      "../components/email/convex/convex.config",
      "BulkEmail",
    ).replace(
      'import env from "./env";',
      'import env from "./env";\nimport { BulkEmail } from "./bulkEmail";',
    ),
  );
  return { ...project, original, mountFile };
});

const expectedDeploy = (
  nested: boolean,
) => `// Generated by \`confect codegen\` from confect/app.ts. Do not edit.
import { MountInit } from "@confect/server";
import { BulkEmail as mount0 } from "../confect/bulkEmail.js";

export const steps = MountInit.mutation([
  { mount: mount0, nested: ${nested} },
]);
`;

layer(Layer.mergeAll(NodePath.layer, NodeFileSystem.layer))(
  "codegenHandler with mounts a push initialises",
  (it) => {
    it.effect(
      "lists each mount whose component declares init, from its mount file",
      () =>
        Effect.gen(function* () {
          const project = yield* initProject;
          yield* project.run;
          expect(yield* project.read("convex/confectDeploy.ts")).toBe(
            expectedDeploy(false),
          );
          expect(yield* Project.writtenFiles(project.run)).toEqual([]);
          yield* project.write("confect/app.ts", project.original);
          yield* project.run;
          expect(yield* project.exists("convex/confectDeploy.ts")).toBe(false);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "marks a mount whose component has its own deploy module as nested",
      () =>
        Effect.gen(function* () {
          const project = yield* initProject;
          yield* project.write(
            "components/email/convex/confectDeploy.ts",
            expectedDeploy(false),
          );
          yield* project.run;
          expect(yield* project.read("convex/confectDeploy.ts")).toBe(
            expectedDeploy(true),
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "imports each mount under its own name, whatever its file exports",
      () =>
        Effect.gen(function* () {
          const project = yield* initProject;
          yield* project.write(
            "confect/bulkEmail.ts",
            project.mountFile("bulkEmail", "MountInit"),
          );
          yield* project.write(
            "confect/transactionalEmail.ts",
            project.mountFile("transactionalEmail", "MountInit"),
          );
          yield* project.write(
            "confect/noticeEmail.ts",
            project
              .mountFile("noticeEmail", "Notice")
              .replace("export const Notice =", "export default"),
          );
          yield* project.write(
            "confect/app.ts",
            (yield* project.read("confect/app.ts"))
              .replace(
                'import { BulkEmail } from "./bulkEmail";',
                [
                  'import { MountInit as BulkEmail } from "./bulkEmail";',
                  'import { MountInit as TransactionalEmail } from "./transactionalEmail";',
                  'import NoticeEmail from "./noticeEmail";',
                ].join("\n"),
              )
              .replace(
                "    BulkEmail,",
                "    BulkEmail,\n    TransactionalEmail,\n    NoticeEmail,",
              ),
          );
          yield* project.run;
          expect(yield* project.read("convex/confectDeploy.ts")).toBe(
            `// Generated by \`confect codegen\` from confect/app.ts. Do not edit.
import { MountInit } from "@confect/server";
import { MountInit as mount0 } from "../confect/bulkEmail.js";
import { MountInit as mount1 } from "../confect/transactionalEmail.js";
import { default as mount2 } from "../confect/noticeEmail.js";

export const steps = MountInit.mutation([
  { mount: mount0, nested: false },
  { mount: mount1, nested: false },
  { mount: mount2, nested: false },
]);
`,
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "refuses a group that would write convex/confectDeploy.ts, before writing anything",
      () =>
        Effect.gen(function* () {
          const project = yield* initProject;
          yield* project.write("confect/confectDeploy.spec.ts", Project.spec);
          yield* project.write(
            "confect/confectDeploy.impl.ts",
            Project.impl.replace("./notes.spec", "./confectDeploy.spec"),
          );
          expect(
            yield* Project.writtenFiles(project.run.pipe(Effect.ignore)),
          ).toEqual([]);
          const error = yield* Effect.flip(project.run);
          expect(error).toMatchObject({
            _tag: "InvalidDeclarationError",
            declarationPath: "confect/confectDeploy.spec.ts",
          });
          expect(`${Reflect.get(error, "reason")}`).toContain(
            "Rename the group",
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "removes a nested confectDeploy group's module once its files are deleted",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const project = yield* initProject;
          yield* fs.makeDirectory(path.join(project.root, "confect/jobs"));
          yield* project.write(
            "confect/jobs/confectDeploy.spec.ts",
            Project.spec.replace("./_generated", "../_generated"),
          );
          yield* project.write(
            "confect/jobs/confectDeploy.impl.ts",
            Project.impl
              .replaceAll("./_generated", "../_generated")
              .replace("./notes.spec", "./confectDeploy.spec"),
          );
          yield* project.run;
          expect(yield* project.exists("convex/jobs/confectDeploy.ts")).toBe(
            true,
          );
          yield* fs.remove(
            path.join(project.root, "confect/jobs/confectDeploy.spec.ts"),
          );
          yield* fs.remove(
            path.join(project.root, "confect/jobs/confectDeploy.impl.ts"),
          );
          yield* project.run;
          expect(yield* project.exists("convex/jobs/confectDeploy.ts")).toBe(
            false,
          );
          expect(yield* project.read("convex/confectDeploy.ts")).toBe(
            expectedDeploy(false),
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "refuses a mount with init that its mount file does not export",
      () =>
        Effect.gen(function* () {
          const project = yield* initProject;
          yield* project.write(
            "confect/bulkEmail.ts",
            project.mountFile("otherEmail", "BulkEmail"),
          );
          const error = yield* Effect.flip(project.run);
          expect(error).toMatchObject({
            _tag: "InvalidDeclarationError",
            declarationPath: "confect/app.ts",
          });
          expect(`${Reflect.get(error, "reason")}`).toContain(
            "confect/otherEmail.ts",
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );
  },
);
