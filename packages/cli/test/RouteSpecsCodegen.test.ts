import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { pipe } from "effect/Function";
import * as Str from "effect/String";
import {
  generateWithSnapshot,
  updateDeclarations,
} from "@confect/cli/confect/codegen";
import * as Bundler from "@confect/cli/Bundler";
import { SpecModulePath } from "@confect/cli/SpecModulePath";
import * as Project from "./integration/Project";

/**
 * A section that records what codegen hands it, on `globalThis.__probe`, and
 * renders only function paths, so its file is the same whatever else a function
 * carries.
 */
const probe = `const record = (key, value) => { (globalThis.__probe ??= {})[key] = value; };
export const probe = {
  owner: "test/probe",
  format: 1,
  describe: ({ path, spec }) => { record("describe:" + path, spec.functionVisibility); return spec.functionVisibility; },
  generate: {
    file: "probe.ts",
    match: () => false,
    render: (input) => { record("generate", input.functions); return { contents: "export const paths = " + JSON.stringify(input.functions.map((f) => f.path)) + ";\\n", errors: [] }; },
    verify: { match: () => false, check: (input) => { record("verify", { guard: input.guard, functions: input.functions, target: input.target }); return []; } },
  },
  testing: (input) => { record("testing", { functions: Object.keys(input.functions), groups: input.groups.map((g) => g.path) }); return {}; },
};
`;

const app = `import { App, Env } from "@confect/core";
import { probe } from "./probe";
export default App.make({ env: Env.make("host", {}), manifestSections: [{ key: "probe", section: probe }] });
`;

const http = (options: string) => `import { Guard, Http } from "@confect/core";
export default Http.make({ ${options} });
`;

const echoSpec = (route: string, args = "text: Schema.String") =>
  `import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
export default GroupSpec.make().addFunction(
  FunctionSpec.httpAction({ name: "say", ${route}, args: () => ({ ${args} }), returns: () => Schema.String }),
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

const mixedSpec = pipe(
  Project.spec,
  Str.replace(
    "returns: () => Schema.Array(notes.Doc) }));",
    'returns: () => Schema.Array(notes.Doc) })).addFunction(FunctionSpec.httpAction({ name: "ping", method: "GET", path: "/ping", returns: () => Schema.String }));',
  ),
);

const mixedImpl = pipe(
  Project.impl,
  Str.replace(
    "Layer.provide(list),",
    'Layer.provide(list), Layer.provide(FunctionImpl.make(databaseSchema, notes, "ping", () => Effect.succeed("pong"))),',
  ),
);

const routeProject = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const project = yield* Project.make;
  yield* project.write("confect/app.ts", app);
  yield* project.write("confect/probe.ts", probe);
  yield* project.write("confect/http.ts", http("guard: Guard.none"));
  yield* project.write(
    "confect/echo.spec.ts",
    echoSpec('method: "POST", path: "/echo"'),
  );
  yield* project.write("confect/echo.impl.ts", echoImpl);
  const at = (file: string) => path.join(project.root, file);
  const manifest = Bundler.bundle(at("confect/_generated/manifest.ts")).pipe(
    Effect.map(
      ({ module }) =>
        module.default as {
          readonly digest: string;
          readonly http: Record<
            string,
            Record<string, Record<string, Record<string, string>>>
          >;
        },
    ),
  );
  const probed = Effect.sync(() => {
    const recorded = (globalThis as { __probe?: Record<string, unknown> })
      .__probe;
    delete (globalThis as { __probe?: unknown }).__probe;
    return recorded ?? {};
  });
  const generate = project.provide(generateWithSnapshot);
  const refusal = Effect.map(Effect.exit(generate), (exit) =>
    Exit.isFailure(exit)
      ? pipe(Cause.findErrorOption(exit.cause), Option.getOrUndefined)
      : undefined,
  );
  return {
    ...project,
    generate,
    refusal,
    manifest,
    probed,
    read: (file: string) => fs.readFileString(at(file)),
    exists: (file: string) => fs.exists(at(file)),
    remove: (file: string) => fs.remove(at(file)),
  };
});

const declaration = (reason: string, declarationPath: string) =>
  expect.objectContaining({
    _tag: "InvalidDeclarationError",
    declarationPath,
    reason: expect.stringContaining(reason),
  });

layer(Layer.mergeAll(NodePath.layer, NodeFileSystem.layer))(
  "codegen with route specs",
  (it) => {
    it.effect(
      "writes no Convex module or registration for a route-only leaf",
      () =>
        Effect.gen(function* () {
          const project = yield* routeProject;
          yield* project.generate;
          const written = yield* Effect.all([
            project.exists("convex/echo.ts"),
            project.exists("confect/_generated/registeredFunctions/echo.ts"),
            project.exists("convex/notes.ts"),
          ]);
          expect(written).toEqual([false, false, true]);
          const testing = yield* project.read("confect/_generated/testing.ts");
          expect(testing).not.toContain("echo");
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "exports only the Convex functions of a leaf that also holds a route",
      () =>
        Effect.gen(function* () {
          const project = yield* routeProject;
          yield* project.write("confect/notes.spec.ts", mixedSpec);
          yield* project.write("confect/notes.impl.ts", mixedImpl);
          yield* project.generate;
          const notes = yield* project.read("convex/notes.ts");
          expect([
            pipe(notes, Str.includes("export const list")),
            pipe(notes, Str.includes("ping")),
          ]).toEqual([true, false]);
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "catalogues each route spec under app, by module path and name",
      () =>
        Effect.gen(function* () {
          const project = yield* routeProject;
          yield* project.generate;
          const { http: catalogue, digest } = yield* project.manifest;
          expect(catalogue).toEqual({
            app: {
              echo: {
                say: {
                  method: "POST",
                  path: "/echo",
                  owner: "app",
                  group: "echo",
                  endpoint: "say",
                  digest,
                },
              },
            },
          });
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "returns every generated file to its no-route bytes once the last route goes",
      () =>
        Effect.gen(function* () {
          const project = yield* routeProject;
          yield* project.remove("confect/echo.spec.ts");
          yield* project.remove("confect/echo.impl.ts");
          yield* project.generate;
          const before = yield* project.generatedFiles;
          yield* project.write(
            "confect/echo.spec.ts",
            echoSpec('method: "POST", path: "/echo"'),
          );
          yield* project.write("confect/echo.impl.ts", echoImpl);
          yield* project.generate;
          expect((yield* project.manifest).http).not.toEqual({});
          yield* project.remove("confect/echo.spec.ts");
          yield* project.remove("confect/echo.impl.ts");
          yield* project.generate;
          const after = yield* project.generatedFiles;
          expect(after).toEqual(before);
        }).pipe(Effect.scoped),
      { timeout: 90000 },
    );

    it.effect(
      "updates the catalogue on an incremental edit of a route's path, as a full run would",
      () =>
        Effect.gen(function* () {
          const project = yield* routeProject;
          const { snapshot } = yield* project.generate;
          yield* project.write(
            "confect/echo.spec.ts",
            echoSpec('method: "POST", path: "/echoed"'),
          );
          yield* project.provide(
            updateDeclarations(
              snapshot,
              [
                {
                  _tag: "Spec",
                  relativePath: SpecModulePath.make("echo.spec.ts"),
                },
              ],
              [],
            ),
          );
          const incremental = yield* project.manifest;
          expect(incremental.http["app"]?.["echo"]?.["say"]?.["path"]).toBe(
            "/echoed",
          );
          yield* project.generate;
          const full = yield* project.manifest;
          expect(full).toEqual(incremental);
        }).pipe(Effect.scoped),
      { timeout: 90000 },
    );

    it.effect(
      "hands sections each function's visibility, the guard's name and the target, and keeps routes from testing",
      () =>
        Effect.gen(function* () {
          const project = yield* routeProject;
          yield* project.probed;
          yield* project.generate;
          const recorded = yield* project.probed;
          const functions = [
            { path: "echo:say", source: "echo.spec.ts", visibility: "http" },
            {
              path: "notes:list",
              source: "notes.spec.ts",
              visibility: "public",
            },
          ];
          expect(recorded).toEqual({
            "describe:echo:say": "http",
            "describe:notes:list": "public",
            generate: functions,
            verify: { guard: "none", functions, target: { kind: "app" } },
            testing: { functions: ["notes:list"], groups: ["notes"] },
          });
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect.each([
      {
        options: 'guard: Guard.make("frame", (inner) => inner)',
        guard: "frame",
      },
      { options: "", guard: undefined },
    ])(
      "hands verify the declared guard's name, or undefined without routes ($guard)",
      ({ options, guard }) =>
        Effect.gen(function* () {
          const project = yield* routeProject;
          if (guard === undefined) {
            yield* project.remove("confect/echo.spec.ts");
            yield* project.remove("confect/echo.impl.ts");
          }
          yield* project.write("confect/http.ts", http(options));
          yield* project.probed;
          yield* project.generate;
          const recorded = (yield* project.probed) as {
            readonly verify: { readonly guard: unknown };
          };
          expect(recorded.verify.guard).toBe(guard);
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "refuses route specs without confect/http.ts",
      () =>
        Effect.gen(function* () {
          const project = yield* routeProject;
          yield* project.remove("confect/http.ts");
          const refusal = yield* project.refusal;
          expect(refusal).toEqual(
            declaration("Http.make({ guard: Guard.none })", "confect/http.ts"),
          );
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect.each([
      { case: "no guard", options: "" },
      {
        case: "a function that is no guard",
        options: "guard: (inner) => inner",
      },
    ])(
      "refuses route specs whose confect/http.ts declares $case",
      ({ options }) =>
        Effect.gen(function* () {
          const project = yield* routeProject;
          yield* project.write("confect/http.ts", http(options));
          const refusal = yield* project.refusal;
          expect(refusal).toEqual(declaration("Guard.none", "confect/http.ts"));
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "refuses a route spec on an app endpoint's method and path",
      () =>
        Effect.gen(function* () {
          const project = yield* routeProject;
          yield* project.write(
            "confect/http.ts",
            `import { Guard, Http } from "@confect/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
const Api = HttpApi.make("host").add(HttpApiGroup.make("meta").add(HttpApiEndpoint.post("hook", "/echo", { success: Schema.String })));
const handlers = HttpApiBuilder.group(Api, "meta", (h) => h.handle("hook", () => Effect.succeed("ok")));
export default Http.make({ api: Api, handlers, guard: Guard.none });
`,
          );
          const refusal = yield* project.refusal;
          expect(refusal).toEqual(
            declaration(
              'POST /echo is declared twice (app and route "echo:say")',
              "confect/http.ts",
            ),
          );
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect.each([
      {
        case: "a GET struct arg",
        route: 'method: "GET", path: "/echo"',
        args: "filter: Schema.Struct({ text: Schema.String })",
        reason: 'GET arg "filter"',
      },
      {
        case: "a GET array of structs",
        route: 'method: "GET", path: "/echo"',
        args: "texts: Schema.Array(Schema.Struct({ text: Schema.String }))",
        reason: 'GET arg "texts"',
      },
      {
        case: "a path param that is an array",
        route: 'method: "POST", path: "/echo/:ids"',
        args: "ids: Schema.Array(Schema.String)",
        reason: 'path param "ids"',
      },
    ])("refuses $case", ({ route, args, reason }) =>
      Effect.gen(function* () {
        const project = yield* routeProject;
        yield* project.write("confect/echo.spec.ts", echoSpec(route, args));
        const refusal = yield* project.refusal;
        expect(refusal).toEqual(declaration(reason, "confect/echo.spec.ts"));
      }).pipe(Effect.scoped),
    );

    it.effect(
      "accepts GET args that encode as strings or arrays of strings",
      () =>
        Effect.gen(function* () {
          const project = yield* routeProject;
          yield* project.write(
            "confect/echo.spec.ts",
            echoSpec(
              'method: "GET", path: "/echo/:n"',
              'n: Schema.Finite, flag: Schema.optionalKey(Schema.Boolean), tags: Schema.Array(Schema.String), kind: Schema.Literals(["a", "b"])',
            ),
          );
          const refusal = yield* project.refusal;
          expect(refusal).toBeUndefined();
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "refuses route specs in a backend without confect/app.ts",
      () =>
        Effect.gen(function* () {
          const project = yield* routeProject;
          yield* project.remove("confect/app.ts");
          const refusal = yield* project.refusal;
          expect(refusal).toEqual(
            declaration("confect/app.ts", "confect/echo.spec.ts"),
          );
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );
  },
);
