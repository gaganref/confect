import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { expect, layer } from "@effect/vitest";
import { convexTest } from "convex-test";
import { pathToFileURL } from "node:url";
import { vi } from "vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import { pipe } from "effect/Function";
import * as Str from "effect/String";
import {
  codegenHandler,
  generateWithSnapshot,
  updateDeclarations,
} from "@confect/cli/confect/codegen";
import * as DirectoryOptions from "@confect/cli/DirectoryOptions";
import { stringify } from "@confect/cli/Json";
import * as Bundler from "@confect/cli/Bundler";
import * as CodegenError from "@confect/cli/CodegenError";
import { SpecModulePath } from "@confect/cli/SpecModulePath";
import { toPosixPath } from "@confect/cli/utils";
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

/**
 * The echo leaf with these routes, by name and path, all on POST.
 */
const echoRoutes = (routes: ReadonlyArray<readonly [string, string]>) => ({
  "confect/echo.spec.ts": `import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
export default GroupSpec.make()${Arr.join(
    Arr.map(
      routes,
      ([name, path]) =>
        `.addFunction(FunctionSpec.httpAction({ name: "${name}", method: "POST", path: "${path}", returns: () => Schema.String }))`,
    ),
    "",
  )};
`,
  "confect/echo.impl.ts": `import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import databaseSchema from "./_generated/schema";
import echo from "./echo.spec";
export default GroupImpl.make(databaseSchema, echo).pipe(${Arr.join(
    Arr.map(
      routes,
      ([name]) =>
        `Layer.provide(FunctionImpl.make(databaseSchema, echo, "${name}", () => Effect.succeed("said"))), `,
    ),
    "",
  )}GroupImpl.finalize);
`,
});

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
    everyGeneratedFile: Effect.forEach(
      ["confect/_generated", "convex"],
      (directory) =>
        Effect.flatMap(
          fs.readDirectory(at(directory), { recursive: true }),
          (entries) =>
            Effect.forEach(entries, (entry) => {
              const file = path.join(directory, entry);
              return Effect.flatMap(fs.stat(at(file)), (info) =>
                info.type === "File"
                  ? Effect.map(fs.readFileString(at(file)), (text) => [
                      [toPosixPath(path, file), text] as const,
                    ])
                  : Effect.succeed([]),
              );
            }),
        ),
    ).pipe(
      Effect.map((files) => Rec.fromEntries(Arr.flatten(Arr.flatten(files)))),
    ),
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

    it.effect.each([
      {
        edit: "adding a route",
        files: echoRoutes([
          ["say", "/echo"],
          ["shout", "/shout"],
        ]),
      },
      {
        edit: "editing a route's path",
        files: echoRoutes([["say", "/echoed"]]),
      },
      { edit: "renaming a route", files: echoRoutes([["renamed", "/echo"]]) },
      { edit: "removing the last route", files: echoRoutes([]) },
    ])(
      "writes every file a full run writes after $edit incrementally",
      ({ files }) =>
        Effect.gen(function* () {
          const project = yield* routeProject;
          yield* Project.installPackages(project.root, ["test"]);
          const { snapshot } = yield* project.generate;
          for (const [file, text] of Rec.toEntries(files))
            yield* project.write(file, text);
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
          const incremental = yield* project.everyGeneratedFile;
          yield* project.generate;
          const full = yield* project.everyGeneratedFile;
          expect(full["confect/_generated/testing.ts"]).toContain(
            "manifestDigest",
          );
          expect(incremental).toEqual(full);
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
      "refuses a confect/http.ts that passes an api without its handlers",
      () =>
        Effect.gen(function* () {
          const project = yield* routeProject;
          yield* project.write(
            "confect/http.ts",
            `import { Guard, Http } from "@confect/core";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
const api = HttpApi.make("host").add(HttpApiGroup.make("meta").add(HttpApiEndpoint.get("status", "/status")));
const options: any = { api, guard: Guard.none };
export default Http.make(options);
`,
          );
          const refusal = yield* project.refusal;
          expect(refusal).toMatchObject({
            _tag: "ImportFailedError",
            file: "confect/http.ts",
          });
          expect(
            CodegenError.renderCodegenError(
              refusal as CodegenError.CodegenError,
            ),
          ).toContain("Http.make got an api without its handlers");
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
              'method: "GET", path: "/echo/:n/:id"',
              'n: Schema.Finite, id: Schema.suspend(() => Schema.String), flag: Schema.optionalKey(Schema.Boolean), tags: Schema.Array(Schema.String), kind: Schema.Literals(["a", "b"]), text: Schema.suspend(() => Schema.String), pair: Schema.Tuple([Schema.String, Schema.String])',
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

/**
 * What the guard and the route handlers did, in order, on
 * `globalThis.__events`.
 */
const events = {
  take: () => {
    const taken = (globalThis as { __events?: Array<string> }).__events ?? [];
    delete (globalThis as { __events?: unknown }).__events;
    return taken;
  },
  push: "((globalThis.__events ??= []).push",
};

const guardedHttp = (
  options = "",
) => `import { Guard, Http } from "@confect/core";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
export const guard = Guard.make("probe", (inner) => Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  ${events.push}("guard"));
  if (request.headers["x-refuse"] !== undefined) return HttpServerResponse.text("refused", { status: 403 });
  return yield* inner;
}));
export default Http.make({ ${options}guard });
`;

const recordingEchoImpl = `import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import databaseSchema from "./_generated/schema";
import echo from "./echo.spec";
const say = FunctionImpl.make(databaseSchema, echo, "say", ({ text }) => Effect.sync(() => { ${events.push}("handler")); return text; }));
export default GroupImpl.make(databaseSchema, echo).pipe(Layer.provide(say), GroupImpl.finalize);
`;

const hostApi = `import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
const Api = HttpApi.make("host").add(HttpApiGroup.make("meta").add(HttpApiEndpoint.get("status", "/status", { success: Schema.String })));
const handlers = HttpApiBuilder.group(Api, "meta", (h) => h.handle("status", () => Effect.succeed("ok")));
`;

/**
 * A convex-test backend serving the `http.ts` codegen wrote in this Convex
 * directory.
 */
const servedFrom = (convexDirectory: string) =>
  convexTest(undefined, {
    "./convex/_generated/server.js": () => Promise.resolve({}),
    "./convex/http.ts": () =>
      import(
        /* @vite-ignore */ pathToFileURL(`${convexDirectory}/http.ts`).href
      ),
  });

/**
 * A response's status, and its JSON body when it is 200.
 */
const answer = (
  t: ReturnType<typeof servedFrom>,
  url: string,
  init?: RequestInit,
) =>
  Effect.flatMap(
    Effect.promise(() => t.fetch(url, init)),
    (response) =>
      response.status === 200
        ? Effect.map(
            Effect.promise((): Promise<unknown> => response.json()),
            (body) => [response.status, body],
          )
        : Effect.succeed([response.status, undefined]),
  );

const OpenApiPaths = Schema.fromJsonString(
  Schema.Struct({
    paths: Schema.Record(
      Schema.String,
      Schema.Record(Schema.String, Schema.Unknown),
    ),
  }),
);

const post = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: stringify(body),
});

const routerFor = (sectionImport: string, routes: boolean) =>
  `// Generated by \`confect codegen\` from confect/http.ts. Do not edit.
import "../confect/_generated/${sectionImport}.js";
import { HttpRouter } from "@confect/server";
${routes ? 'import * as Layer from "effect/Layer";\n' : ""}import schema from "../confect/_generated/schema.js";
import http from "../confect/http.js";
${routes ? 'import routes from "../confect/_generated/routes.js";\n' : ""}
export default HttpRouter.make(schema, ${routes ? "Layer.merge(http.routes, routes.routes), { api: [http.api, routes.api], guard: http.guard }" : "http.routes, { api: http.api }"});
`;

layer(Layer.mergeAll(NodePath.layer, NodeFileSystem.layer))(
  "codegen serves route specs",
  (it) => {
    it.effect(
      "writes routes.ts, a router serving it and openapi.json for a backend of route specs alone",
      () =>
        Effect.gen(function* () {
          const project = yield* routeProject;
          for (const [file, text] of Rec.toEntries(
            echoRoutes([
              ["say", "/echo"],
              ["shout", "/shout"],
            ]),
          ))
            yield* project.write(file, text);
          yield* project.generate;
          const written = yield* Effect.all([
            project.read("confect/_generated/routes.ts"),
            project.read("convex/http.ts"),
            project.exists("confect/_generated/openapi.json"),
          ]);
          const openApi = yield* project.read(
            "confect/_generated/openapi.json",
          );
          yield* Effect.promise(() =>
            expect(openApi).toMatchFileSnapshot(
              "./__goldens__/routes-openapi.golden",
            ),
          );
          expect(written).toEqual([
            '// Generated by `confect codegen` from the route specs. Do not edit.\nimport { Routes } from "@confect/server";\nimport schema from "./schema.js";\nimport leaf0Spec from "../echo.spec.js";\nimport leaf0Impl from "../echo.impl.js";\n\nexport default Routes.make(schema, {\n  "echo": [leaf0Spec, leaf0Impl],\n});\n',
            routerFor("probe", true),
            true,
          ]);
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "runs the guard before the route's handler, and a refusal leaves the handler unrun",
      () =>
        Effect.gen(function* () {
          const project = yield* routeProject;
          yield* project.write("confect/http.ts", guardedHttp());
          yield* project.write("confect/echo.impl.ts", recordingEchoImpl);
          yield* project.generate;
          events.take();
          const t = servedFrom(`${project.root}/convex`);
          const admitted = yield* answer(t, "/echo", post({ text: "hello" }));
          const admittedEvents = events.take();
          const refused = yield* answer(
            t,
            "/echo",
            post({ text: "hello" }, { "x-refuse": "1" }),
          );
          expect({
            admitted: [admitted, admittedEvents],
            refused: [refused, events.take()],
          }).toEqual({
            admitted: [
              [200, "hello"],
              ["guard", "handler"],
            ],
            refused: [[403, undefined], ["guard"]],
          });
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "serves http.ts's endpoints and a mixed leaf's route beside the route specs",
      () =>
        Effect.gen(function* () {
          const project = yield* routeProject;
          yield* project.write(
            "confect/http.ts",
            pipe(
              guardedHttp("api: Api, handlers, "),
              Str.replace(
                'import * as Effect from "effect/Effect";\n',
                hostApi,
              ),
            ),
          );
          yield* project.write("confect/echo.impl.ts", recordingEchoImpl);
          yield* project.write("confect/notes.spec.ts", mixedSpec);
          yield* project.write("confect/notes.impl.ts", mixedImpl);
          yield* project.generate;
          events.take();
          const routes = yield* project.read("confect/_generated/routes.ts");
          const t = servedFrom(`${project.root}/convex`);
          const answers = yield* Effect.forEach(
            [
              ["/status", { method: "GET" }],
              ["/ping", { method: "GET" }],
              ["/echo", post({ text: "hi" })],
            ] as const,
            ([url, init]) => answer(t, url, init),
          );
          expect({ answers, events: events.take(), routes }).toEqual({
            answers: [
              [200, "ok"],
              [200, "pong"],
              [200, "hi"],
            ],
            events: ["guard", "guard", "handler"],
            routes:
              '// Generated by `confect codegen` from the route specs. Do not edit.\nimport { Routes } from "@confect/server";\nimport schema from "./schema.js";\nimport leaf0Spec from "../echo.spec.js";\nimport leaf0Impl from "../echo.impl.js";\nimport leaf1Spec from "../notes.spec.js";\nimport leaf1Impl from "../notes.impl.js";\n\nexport default Routes.make(schema, {\n  "echo": [leaf0Spec, leaf0Impl],\n  "notes": [leaf1Spec, leaf1Impl],\n});\n',
          });
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "documents the route specs alone in openapi.json, and a full run refreshes it after an args edit",
      () =>
        Effect.gen(function* () {
          const project = yield* routeProject;
          const openApi = Effect.flatMap(
            project.read("confect/_generated/openapi.json"),
            (text) =>
              Effect.map(
                Schema.decodeEffect(OpenApiPaths)(text),
                (document) => ({
                  paths: Rec.map(document.paths, (operations) =>
                    Rec.keys(operations),
                  ),
                  body: text,
                }),
              ),
          );
          yield* project.generate;
          const before = yield* openApi;
          yield* project.write(
            "confect/echo.spec.ts",
            echoSpec(
              'method: "POST", path: "/echo"',
              "text: Schema.String, loud: Schema.Boolean",
            ),
          );
          yield* project.generate;
          const after = yield* openApi;
          expect({
            before: before.paths,
            after: after.paths,
            loud: [
              pipe(before.body, Str.includes('"loud"')),
              pipe(after.body, Str.includes('"loud"')),
            ],
          }).toEqual({
            before: { "/echo": ["post"] },
            after: { "/echo": ["post"] },
            loud: [false, true],
          });
        }).pipe(Effect.scoped),
      { timeout: 90000 },
    );

    it.effect(
      "removes routes.ts and openapi.json with the last route, and writes the router a backend that never had one gets",
      () =>
        Effect.gen(function* () {
          const project = yield* routeProject;
          yield* project.generate;
          const served = yield* Effect.all([
            project.exists("confect/_generated/routes.ts"),
            project.exists("confect/_generated/openapi.json"),
          ]);
          yield* project.remove("confect/echo.spec.ts");
          yield* project.remove("confect/echo.impl.ts");
          yield* project.generate;
          const after = yield* project.everyGeneratedFile;
          const never = yield* routeProject;
          yield* never.remove("confect/echo.spec.ts");
          yield* never.remove("confect/echo.impl.ts");
          yield* never.generate;
          expect({
            served,
            after,
            router: after["convex/http.ts"],
          }).toEqual({
            served: [true, true],
            after: yield* never.everyGeneratedFile,
            router: routerFor("probe", false),
          });
        }).pipe(Effect.scoped),
      { timeout: 90000 },
    );

    it.effect(
      "fails codegen on a route error without an HTTP status, naming the route and the error",
      () =>
        Effect.gen(function* () {
          const project = yield* routeProject;
          yield* project.write(
            "confect/echo.spec.ts",
            pipe(
              echoSpec('method: "POST", path: "/echo"'),
              Str.replace(
                "export default",
                'class Boom extends Schema.TaggedError<Boom>()("Boom", {}) {}\nexport default',
              ),
              Str.replace(
                "returns: () => Schema.String",
                "returns: () => Schema.String, error: () => Boom",
              ),
            ),
          );
          const refusal = yield* project.refusal;
          expect(refusal).toEqual(
            expect.objectContaining({
              _tag: "InvalidDeclarationError",
              declarationPath: "confect/echo.spec.ts",
              reason: expect.stringMatching(/"echo:say".*Boom.*status/),
            }),
          );
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "fails codegen on a route that holds a secret, naming the route and the slot at its spec",
      () =>
        Effect.gen(function* () {
          const project = yield* routeProject;
          yield* project.write(
            "confect/echo.spec.ts",
            echoSpec(
              'method: "POST", path: "/echo"',
              "text: Schema.String.pipe(Schema.RedactedFromValue)",
            ),
          );
          const refusal = yield* project.refusal;
          expect(refusal).toEqual(
            declaration(
              'Route "echo:say" holds a secret in its payload',
              "confect/echo.spec.ts",
            ),
          );
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "evaluates no route's args when routes.ts is imported",
      () =>
        Effect.gen(function* () {
          const project = yield* routeProject;
          yield* project.write(
            "confect/echo.spec.ts",
            pipe(
              echoSpec('method: "POST", path: "/echo"'),
              Str.replace(
                "args: () => (",
                "args: () => ((globalThis.__argsRead = (globalThis.__argsRead ?? 0) + 1), ",
              ),
            ),
          );
          yield* project.generate;
          const counter = globalThis as { __argsRead?: number };
          counter.__argsRead = 0;
          const { module } = yield* Bundler.bundle(
            `${project.root}/confect/_generated/routes.ts`,
          );
          const onImport = counter.__argsRead;
          const routes = module["default"] as { readonly api: unknown };
          expect(routes.api).toBeDefined();
          expect([onImport, counter.__argsRead > 0]).toEqual([0, true]);
          delete counter.__argsRead;
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "serves a component's route specs under the mount prefix its host catalogues",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({
            directory: `${import.meta.dirname}/fixtures`,
            prefix: "routed-component-",
          });
          const write = (file: string, contents: string) =>
            Effect.gen(function* () {
              yield* fs.makeDirectory(path.dirname(path.join(root, file)), {
                recursive: true,
              });
              yield* fs.writeFileString(path.join(root, file), contents);
            });
          yield* write(
            "child/package.json",
            stringify({
              name: "@fx/child",
              type: "module",
              exports: {
                "./convex.config": "./convex/convex.config.ts",
                "./client": "./client.ts",
                "./testing": "./testing.js",
              },
            }),
          );
          yield* write(
            "child/confect/app.ts",
            `import { App, Env } from "@confect/core";
export default App.make({ kind: "component", env: Env.make("child", {}) });
`,
          );
          yield* write("child/confect/http.ts", guardedHttp());
          yield* write(
            "child/confect/echo.spec.ts",
            echoSpec('method: "POST", path: "/echo"'),
          );
          yield* write("child/confect/echo.impl.ts", recordingEchoImpl);
          yield* write(
            "child/client.ts",
            `import { Component } from "@confect/core";
import manifest from "./confect/_generated/manifest";
export default Component.make("child", { manifest, client: (native: unknown) => native });
`,
          );
          yield* write(
            "child/testing.js",
            "export function register(t, name) { t.registerComponent(name); }\n",
          );
          yield* fs.makeDirectory(path.join(root, "child/convex"));
          yield* write(
            "host/package.json",
            stringify({ name: "host", type: "module" }),
          );
          yield* fs.makeDirectory(path.join(root, "host/node_modules/@fx"), {
            recursive: true,
          });
          yield* fs.symlink(
            path.join(root, "child"),
            path.join(root, "host/node_modules/@fx/child"),
          );
          yield* write(
            "host/confect/app.ts",
            `import { App, Env, Mount } from "@confect/core";
import child from "@fx/child/convex.config";
import Child from "@fx/child/client";
export default App.make({
  env: Env.make("host", {}),
  components: [child],
  mounts: [Mount.make(Child, { name: "child", httpPrefix: "/child" })],
});
`,
          );
          yield* fs.makeDirectory(path.join(root, "host/convex"));
          const generate = (directory: string, component: boolean) =>
            Effect.acquireUseRelease(
              Effect.sync(() => {
                const cwd = process.cwd();
                process.chdir(path.join(root, directory));
                return cwd;
              }),
              () =>
                Effect.gen(function* () {
                  const services = yield* Layer.build(
                    DirectoryOptions.layer({
                      componentDir: component
                        ? Option.some(path.join(root, directory, "convex"))
                        : Option.none(),
                    }),
                  );
                  return yield* codegenHandler.pipe(
                    Effect.provideContext(services),
                  );
                }).pipe(Effect.scoped),
              (cwd) => Effect.sync(() => process.chdir(cwd)),
            );
          yield* generate("child", true);
          yield* generate("host", false);
          const manifest = (yield* Bundler.bundle(
            path.join(root, "host/confect/_generated/manifest.ts"),
          )).module["default"] as {
            readonly http: Record<
              string,
              Record<string, Record<string, { readonly path: string }>>
            >;
          };
          const catalogued = manifest.http["child"]?.["echo"]?.["say"]?.path;
          events.take();
          vi.stubEnv("CONVEX_SITE_URL", "https://some.convex.site/child");
          const t = servedFrom(path.join(root, "child/convex"));
          const answers = yield* Effect.forEach(
            ["/child/echo", "/echo"],
            (url) => answer(t, url, post({ text: "mounted" })),
          ).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())));
          expect({ catalogued, answers, events: events.take() }).toEqual({
            catalogued: "/child/echo",
            answers: [
              [200, "mounted"],
              [404, undefined],
            ],
            events: ["guard", "handler"],
          });
        }).pipe(Effect.scoped),
      { timeout: 90000 },
    );
  },
);
