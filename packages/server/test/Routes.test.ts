import { FunctionSpec, GroupSpec, MiddlewareSpec } from "@confect/core";
import {
  FunctionImpl,
  GroupImpl,
  HttpRouter as ConfectHttpRouter,
  MiddlewareImpl,
  MutationRunner,
  Routes,
} from "@confect/server";
import { describe, expect, it } from "@effect/vitest";
import { convexTest } from "convex-test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Arr from "effect/Array";
import convexSchema from "./mock-backend/fixtures/confect/_generated/convexSchema";
import refs from "./mock-backend/fixtures/confect/_generated/refs";
import schema from "./mock-backend/fixtures/confect/_generated/schema";

class Missing extends Schema.TaggedError<
  Missing,
  { readonly brand: unique symbol }
>()("Missing", { id: Schema.String }, { httpApiStatus: 404 }) {}

class Unlisted extends Schema.TaggedError<
  Unlisted,
  { readonly brand: unique symbol }
>()("Unlisted", {}) {}

class Trace extends MiddlewareSpec.MiddlewareSpec<Trace>()("Trace", {
  functionTypes: { query: true, mutation: true, action: true },
}) {}

const read = FunctionSpec.httpAction({
  name: "read",
  method: "GET",
  path: "/notes/:id",
  args: () => ({ id: Schema.String, n: Schema.Finite }),
  returns: () => Schema.Struct({ id: Schema.String, n: Schema.Finite }),
  error: () => Missing,
});

const write = FunctionSpec.httpAction({
  name: "write",
  method: "POST",
  path: "/notes/:id/double",
  args: () => ({ id: Schema.String, n: Schema.Finite }),
  returns: () => Schema.Struct({ doubled: Schema.FiniteFromString }),
});

const remove = FunctionSpec.httpAction({
  name: "remove",
  method: "POST",
  path: "/notes/remove",
  args: () => ({ noteId: Schema.String }),
  returns: () => Schema.Null,
});

const fails = FunctionSpec.httpAction({
  name: "fails",
  method: "GET",
  path: "/fails",
  returns: () => Schema.Null,
});

const dies = FunctionSpec.httpAction({
  name: "dies",
  method: "GET",
  path: "/dies",
  returns: () => Schema.Null,
});

const list = FunctionSpec.publicQuery({
  name: "list",
  returns: () => Schema.Array(Schema.String),
});

const notes = GroupSpec.make()
  .middleware(Trace)
  .addFunction(read)
  .addFunction(write)
  .addFunction(remove)
  .addFunction(fails)
  .addFunction(dies)
  .addFunction(list);

const invocations: Array<MiddlewareSpec.MiddlewareOptions["invocation"]> = [];

const notesImpl = GroupImpl.make(schema, notes).pipe(
  Layer.provide(
    FunctionImpl.make(schema, notes, "read", ({ id, n }) =>
      id === "gone"
        ? Effect.fail(Missing.make({ id }))
        : Effect.succeed({ id, n }),
    ),
  ),
  Layer.provide(
    FunctionImpl.make(schema, notes, "write", ({ n }) =>
      Effect.succeed({ doubled: n * 2 }),
    ),
  ),
  Layer.provide(
    FunctionImpl.make(schema, notes, "remove", ({ noteId }) =>
      Effect.flatMap(MutationRunner.MutationRunner, ({ runMutation }) =>
        runMutation(refs.public.groups.notes.delete_, {
          noteId: noteId as never,
        }),
      ).pipe(Effect.orDie),
    ),
  ),
  Layer.provide(
    FunctionImpl.make(
      schema,
      notes,
      "fails",
      () => Effect.fail(Unlisted.make({})) as never,
    ),
  ),
  Layer.provide(
    FunctionImpl.make(schema, notes, "dies", () =>
      Effect.die(new Error("boom")),
    ),
  ),
  Layer.provide(
    FunctionImpl.make(schema, notes, "list", () => Effect.succeed([])),
  ),
  Layer.provide(
    MiddlewareImpl.make(schema, Trace, (effect, { invocation }) =>
      Effect.andThen(
        Effect.sync(() => invocations.push(invocation)),
        effect,
      ),
    ),
  ),
  GroupImpl.finalize,
);

const routes = Routes.make(schema, { "groups/notes": [notes, notesImpl] });

const modules = import.meta.glob([
  "./mock-backend/fixtures/convex/**/*.ts",
  "./mock-backend/fixtures/convex/**/*.js",
  "!./mock-backend/fixtures/convex/**/*.*.*",
]);

const Json = Schema.fromJsonString(Schema.Unknown);

const serve = (router: ReturnType<typeof ConfectHttpRouter.make>) => {
  const t = convexTest(convexSchema, {
    ...modules,
    "./mock-backend/fixtures/convex/http.ts": () =>
      Promise.resolve({ default: router }),
  });
  return (path: string, init: { method?: string; body?: unknown } = {}) =>
    Effect.gen(function* () {
      invocations.length = 0;
      const body =
        init.body === undefined
          ? undefined
          : yield* Effect.orDie(Schema.encodeEffect(Json)(init.body));
      const response = yield* Effect.promise(() =>
        t.fetch(path, {
          ...(init.method === undefined ? {} : { method: init.method }),
          ...(body === undefined
            ? {}
            : { body, headers: { "content-type": "application/json" } }),
        }),
      );
      const text = yield* Effect.promise(() => response.text());
      const decoded =
        text === "" ? "" : yield* Effect.orDie(Schema.decodeEffect(Json)(text));
      return { status: response.status, body: decoded };
    });
};

const send = serve(ConfectHttpRouter.make(schema, routes.routes));

describe("Routes.make", () => {
  it("annotates each route's endpoint with its function path and spec", () => {
    const annotated: Array<Routes.Route["Service"]> = [];
    HttpApi.reflect(routes.api, {
      onGroup: () => {},
      onEndpoint: ({ endpoint }) => {
        annotated.push(
          Option.getOrThrow(
            Context.getOption(endpoint.annotations, Routes.Route),
          ),
        );
      },
    });
    expect(annotated).toEqual([
      { functionPath: "groups/notes:read", spec: read },
      { functionPath: "groups/notes:write", spec: write },
      { functionPath: "groups/notes:remove", spec: remove },
      { functionPath: "groups/notes:fails", spec: fails },
      { functionPath: "groups/notes:dies", spec: dies },
    ]);
    expect(annotated[0]!.spec).toBe(read);
  });

  it.effect("merges path params into the args and decodes a GET's query", () =>
    Effect.gen(function* () {
      const answer = yield* send("/notes/a?n=3");
      expect(answer).toEqual({ status: 200, body: { id: "a", n: 3 } });
    }),
  );

  it.effect(
    "reads a POST's args from its JSON body and encodes its returns",
    () =>
      Effect.gen(function* () {
        const answer = yield* send("/notes/a/double", {
          method: "POST",
          body: { n: 3 },
        });
        expect(answer).toEqual({ status: 200, body: { doubled: "6" } });
      }),
  );

  it.effect("runs the middleware chain with the route's http invocation", () =>
    Effect.gen(function* () {
      yield* send("/notes/a?n=3");
      expect(invocations).toEqual([
        {
          name: "groups/notes:read",
          functionType: "action",
          functionVisibility: "http",
          args: { id: "a", n: 3 },
        },
      ]);
    }),
  );

  it.effect("answers a declared error under its annotated status", () =>
    Effect.gen(function* () {
      const answer = yield* send("/notes/gone?n=1");
      expect(answer).toEqual({
        status: 404,
        body: { _tag: "Missing", id: "gone" },
      });
    }),
  );

  it.effect("answers 500 for an undeclared failure and for a defect", () =>
    Effect.gen(function* () {
      const failed = yield* send("/fails");
      const died = yield* send("/dies");
      expect([failed.status, died.status]).toEqual([500, 500]);
    }),
  );

  it.effect("answers an args schema failure with the empty 400", () =>
    Effect.gen(function* () {
      const query = yield* send("/notes/a?n=x");
      const payload = yield* send("/notes/a/double", {
        method: "POST",
        body: { n: "x" },
      });
      expect([query, payload]).toEqual([
        { status: 400, body: "" },
        { status: 400, body: "" },
      ]);
    }),
  );

  it.effect(
    "answers a nested call's argument validation failure with the empty 400",
    () =>
      Effect.gen(function* () {
        const answer = yield* send("/notes/remove", {
          method: "POST",
          body: { noteId: "not an id" },
        });
        expect(answer).toEqual({ status: 400, body: "" });
      }),
  );

  it("refuses a route error without an HttpApiSchema status", () => {
    const unannotated = GroupSpec.make().addFunction(
      FunctionSpec.httpAction({
        name: "bare",
        method: "GET",
        path: "/bare",
        returns: () => Schema.Null,
        error: () => Unlisted,
      }),
    );
    const impl = GroupImpl.make(schema, unannotated).pipe(
      Layer.provide(
        FunctionImpl.make(schema, unannotated, "bare", () =>
          Effect.succeed(null),
        ),
      ),
      GroupImpl.finalize,
    );
    expect(() => Routes.make(schema, { bare: [unannotated, impl] })).toThrow(
      expect.objectContaining({
        _tag: "RouteErrorWithoutStatus",
        functionPath: "bare:bare",
        error: "Unlisted",
      }),
    );
  });
});

describe("Routes.isArgumentValidationFailure", () => {
  it.each([
    [new Error('ArgumentValidationError: Found ID "x"'), true],
    [new Error("Validator error: Missing required field `noteId`"), true],
    [new Error("Uncaught Error: plain boom"), false],
    ["ArgumentValidationError: not an Error", false],
    [undefined, false],
  ])("matches %s: %s", (defect, matches) => {
    expect(Routes.isArgumentValidationFailure(defect)).toBe(matches);
  });
});

describe("HttpRouter.make's api option", () => {
  const OtherApi = HttpApi.make("other").add(
    HttpApiGroup.make("health").add(
      HttpApiEndpoint.get("health", "/health", { success: Schema.String }),
    ),
  );
  const other = HttpApiBuilder.layer(OtherApi).pipe(
    Layer.provide(
      HttpApiBuilder.group(OtherApi, "health", (handlers) =>
        handlers.handle("health", () => Effect.succeed("ok")),
      ),
    ),
  );
  const labels = (router: ReturnType<typeof ConfectHttpRouter.make>) =>
    Arr.map(router.getRoutes(), ([path, method]) => `${method} ${path}`);

  it("reflects every api of a list", () => {
    const router = ConfectHttpRouter.make(
      schema,
      Layer.merge(other, routes.routes),
      { api: [OtherApi, routes.api] },
    );
    expect(labels(router)).toEqual([
      "GET /dies",
      "GET /fails",
      "GET /health",
      "GET /notes/:id",
      "POST /notes/:id/double",
      "POST /notes/remove",
    ]);
  });

  it("still takes one api", () => {
    const router = ConfectHttpRouter.make(schema, other, { api: OtherApi });
    expect(labels(router)).toEqual(["GET /health"]);
  });
});
