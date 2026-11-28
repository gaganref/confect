import { FunctionSpec, GroupSpec, MiddlewareSpec, Ref } from "@confect/core";
import {
  FunctionImpl,
  FunctionRegistryItem,
  GroupImpl,
  Guard,
  HttpRouter as ConfectHttpRouter,
  MiddlewareImpl,
  MutationRunner,
  RegisteredConvexFunction,
  Routes,
} from "@confect/server";
import { describe, expect, it } from "@effect/vitest";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
import * as ArgumentRefusal from "../src/internal/argumentRefusal";
import * as SecretSides from "../src/internal/secretSides";
import * as KernelJson from "../../test/src/internal/Json";

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

const fetchFrom = (router: ReturnType<typeof ConfectHttpRouter.make>) => {
  const t = convexTest(convexSchema, {
    ...modules,
    "./mock-backend/fixtures/convex/http.ts": () =>
      Promise.resolve({ default: router }),
  });
  return (path: string, init?: RequestInit) =>
    Effect.promise(() => t.fetch(path, init));
};

const serve = (router: ReturnType<typeof ConfectHttpRouter.make>) => {
  const fetch = fetchFrom(router);
  return (path: string, init: { method?: string; body?: unknown } = {}) =>
    Effect.gen(function* () {
      invocations.length = 0;
      const body =
        init.body === undefined
          ? undefined
          : yield* Effect.orDie(Schema.encodeEffect(Json)(init.body));
      const response = yield* fetch(path, {
        ...(init.method === undefined ? {} : { method: init.method }),
        ...(body === undefined
          ? {}
          : { body, headers: { "content-type": "application/json" } }),
      });
      const text = yield* Effect.promise(() => response.text());
      const decoded =
        text === "" ? "" : yield* Effect.orDie(Schema.decodeEffect(Json)(text));
      return { status: response.status, body: decoded };
    });
};

const send = serve(
  ConfectHttpRouter.make(schema, routes.routes, {
    api: routes.api,
    guard: Guard.none,
  }),
);

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

  it.effect(
    "refuses a route error without an HttpApiSchema status before serving",
    () =>
      Effect.gen(function* () {
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
        const built = Routes.make(schema, { bare: [unannotated, impl] });
        const refusal = expect.objectContaining({
          _tag: "RouteErrorWithoutStatus",
          functionPath: "bare:bare",
          error: "Unlisted",
        });
        expect(() =>
          ConfectHttpRouter.make(schema, built.routes, { api: built.api }),
        ).toThrow(refusal);
        const unreflected = yield* Effect.exit(
          fetchFrom(ConfectHttpRouter.make(schema, built.routes))("/bare"),
        );
        expect(unreflected).toEqual(Exit.die(refusal));
      }),
  );

  describe("a route error of Schema.Never", () => {
    // The names of the errors each route spec's endpoint declares.
    const declared = (api: Parameters<typeof HttpApi.reflect>[0]) => {
      const names: Array<string> = [];
      HttpApi.reflect(api, {
        onGroup: () => undefined,
        onEndpoint: ({ endpoint }) => {
          for (const error of endpoint.error) {
            names.push(String(error.ast.annotations?.["identifier"]));
          }
        },
      });
      return names;
    };

    it.effect(
      "is skipped in a union, and the union's other errors stay declared",
      () =>
        Effect.gen(function* () {
          const group = GroupSpec.make().addFunction(
            FunctionSpec.httpAction({
              name: "maybe",
              method: "GET",
              path: "/maybe",
              returns: () => Schema.Null,
              error: () => Schema.Union([Missing, Schema.Never]),
            }),
          );
          const impl = GroupImpl.make(schema, group).pipe(
            Layer.provide(
              FunctionImpl.make(schema, group, "maybe", () =>
                Effect.fail(Missing.make({ id: "gone" })),
              ),
            ),
            GroupImpl.finalize,
          );
          const built = Routes.make(schema, { maybe: [group, impl] });
          expect(declared(built.api)).toEqual(["Missing"]);
          const answer = yield* serve(
            ConfectHttpRouter.make(schema, built.routes, {
              api: built.api,
              guard: Guard.none,
            }),
          )("/maybe");
          expect(answer).toEqual({
            status: 404,
            body: { _tag: "Missing", id: "gone" },
          });
        }),
    );

    it.effect("on its own declares no error", () =>
      Effect.gen(function* () {
        const group = GroupSpec.make().addFunction(
          FunctionSpec.httpAction({
            name: "never",
            method: "GET",
            path: "/never",
            returns: () => Schema.Null,
            error: () => Schema.Never,
          }),
        );
        const impl = GroupImpl.make(schema, group).pipe(
          Layer.provide(
            FunctionImpl.make(schema, group, "never", () =>
              Effect.succeed(null),
            ),
          ),
          GroupImpl.finalize,
        );
        const built = Routes.make(schema, { never: [group, impl] });
        expect(declared(built.api)).toEqual([]);
        const answer = yield* serve(
          ConfectHttpRouter.make(schema, built.routes, {
            api: built.api,
            guard: Guard.none,
          }),
        )("/never");
        expect(answer).toEqual({ status: 200, body: null });
      }),
    );

    it("leaves another member without a status refused", () => {
      const group = GroupSpec.make().addFunction(
        FunctionSpec.httpAction({
          name: "mixed",
          method: "GET",
          path: "/mixed",
          returns: () => Schema.Null,
          error: () => Schema.Union([Missing, Schema.Never, Unlisted]),
        }),
      );
      const impl = GroupImpl.make(schema, group).pipe(
        Layer.provide(
          FunctionImpl.make(schema, group, "mixed", () => Effect.succeed(null)),
        ),
        GroupImpl.finalize,
      );
      const built = Routes.make(schema, { mixed: [group, impl] });
      expect(() =>
        ConfectHttpRouter.make(schema, built.routes, {
          api: built.api,
          guard: Guard.none,
        }),
      ).toThrow(
        expect.objectContaining({
          _tag: "RouteErrorWithoutStatus",
          functionPath: "mixed:mixed",
          error: "Unlisted",
        }),
      );
    });
  });

  it("evaluates no schema until the router reads the routes", () => {
    const reads = { args: 0, returns: 0, error: 0 };
    const lazy = GroupSpec.make().addFunction(
      FunctionSpec.httpAction({
        name: "lazy",
        method: "GET",
        path: "/lazy",
        args: () => (reads.args++, {}),
        returns: () => (reads.returns++, Schema.String),
        error: () => (reads.error++, Missing),
      }),
    );
    const impl = GroupImpl.make(schema, lazy).pipe(
      Layer.provide(
        FunctionImpl.make(schema, lazy, "lazy", () => Effect.succeed("ok")),
      ),
      GroupImpl.finalize,
    );
    const built = Routes.make(schema, { lazy: [lazy, impl] });
    expect(reads).toEqual({ args: 0, returns: 0, error: 0 });
    ConfectHttpRouter.make(schema, built.routes, {
      api: built.api,
      guard: Guard.none,
    });
    expect(reads).toEqual({ args: 1, returns: 1, error: 1 });
  });

  it.effect(
    "answers 500 for a product defect whose message looks like argument validation",
    () =>
      Effect.gen(function* () {
        const spoof = GroupSpec.make().addFunction(
          FunctionSpec.httpAction({
            name: "spoof",
            method: "GET",
            path: "/spoof",
            returns: () => Schema.Null,
          }),
        );
        const impl = GroupImpl.make(schema, spoof).pipe(
          Layer.provide(
            FunctionImpl.make(schema, spoof, "spoof", () =>
              Effect.die(new Error("ArgumentValidationError: product failure")),
            ),
          ),
          GroupImpl.finalize,
        );
        const built = Routes.make(schema, { spoof: [spoof, impl] });
        const answer = yield* serve(
          ConfectHttpRouter.make(schema, built.routes, {
            api: built.api,
            guard: Guard.none,
          }),
        )("/spoof");
        expect(answer.status).toBe(500);
      }),
  );
});

describe("the argument validation marker", () => {
  // Each way product code could make a marker of its own, given the real one
  // a refused nested call raised.
  const forgeries: Record<string, (real: unknown) => unknown> = {
    "the real marker, rethrown": (real) => real,
    "the exported constructor": (real) => {
      const exported = Reflect.get(Routes, "ArgumentValidationFailure") as
        | { make: (fields: { message: string }) => unknown }
        | undefined;
      return exported === undefined
        ? new Error("no exported constructor")
        : exported.make({
            message: String(Reflect.get(Object(real), "message")),
          });
    },
    "the real marker's constructor": (real) => {
      const Constructor = Reflect.get(Object(real), "constructor") as new (
        ...args: ReadonlyArray<unknown>
      ) => unknown;
      return new Constructor({ message: "product bug" });
    },
    "a copy with the real marker's prototype": (real) =>
      Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
        message: "product bug",
      }),
    "a plain copy of the real marker's fields": (real) => ({
      ...Object(real),
      _tag: "ArgumentValidationFailure",
      name: "ArgumentValidationFailure",
      message: "product bug",
    }),
  };

  const forge = FunctionSpec.httpAction({
    name: "forge",
    method: "GET",
    path: "/forge",
    args: () => ({ how: Schema.String }),
    returns: () => Schema.Null,
  });
  const forging = GroupSpec.make().addFunction(forge);
  const forgingImpl = GroupImpl.make(schema, forging).pipe(
    Layer.provide(
      FunctionImpl.make(schema, forging, "forge", ({ how }) =>
        Effect.gen(function* () {
          const { runMutation } = yield* MutationRunner.MutationRunner;
          const refused = yield* Effect.exit(
            runMutation(refs.public.groups.notes.delete_, {
              noteId: "not an id" as never,
            }),
          );
          const real = Exit.isFailure(refused)
            ? Cause.squash(refused.cause)
            : undefined;
          return yield* Effect.die(forgeries[how]!(real));
        }),
      ),
    ),
    GroupImpl.finalize,
  );
  const forged = Routes.make(schema, { forging: [forging, forgingImpl] });
  const sendForged = serve(
    ConfectHttpRouter.make(schema, forged.routes, {
      api: forged.api,
      guard: Guard.none,
    }),
  );

  it.effect.each([
    ["the real marker, rethrown", 400],
    ["the exported constructor", 500],
    ["the real marker's constructor", 500],
    ["a copy with the real marker's prototype", 500],
    ["a plain copy of the real marker's fields", 500],
  ] as const)("product code that dies with %s answers %i", ([how, status]) =>
    Effect.gen(function* () {
      const answer = yield* sendForged(`/forge?how=${encodeURIComponent(how)}`);
      expect(answer.status).toBe(status);
    }),
  );

  // One request keeps the real marker its refused nested call raised; a later
  // request, which makes no nested call, dies with it.
  let kept: unknown;
  let keptMatched = false;
  const keeping = GroupSpec.make()
    .addFunction(
      FunctionSpec.httpAction({
        name: "keep",
        method: "GET",
        path: "/keep",
        returns: () => Schema.Null,
      }),
    )
    .addFunction(
      FunctionSpec.httpAction({
        name: "replay",
        method: "GET",
        path: "/replay",
        returns: () => Schema.Null,
      }),
    );
  const keepingImpl = GroupImpl.make(schema, keeping).pipe(
    Layer.provide(
      FunctionImpl.make(schema, keeping, "keep", () =>
        Effect.gen(function* () {
          const { runMutation } = yield* MutationRunner.MutationRunner;
          const refused = yield* Effect.exit(
            runMutation(refs.public.groups.notes.delete_, {
              noteId: "not an id" as never,
            }),
          );
          kept = Exit.isFailure(refused)
            ? Cause.squash(refused.cause)
            : undefined;
          keptMatched = yield* Routes.isArgumentValidationFailure(kept);
          return null;
        }),
      ),
    ),
    Layer.provide(
      FunctionImpl.make(schema, keeping, "replay", () => Effect.die(kept)),
    ),
    GroupImpl.finalize,
  );
  const keptRoutes = Routes.make(schema, { keeping: [keeping, keepingImpl] });
  const sendKept = serve(
    ConfectHttpRouter.make(schema, keptRoutes.routes, {
      api: keptRoutes.api,
      guard: Guard.none,
    }),
  );

  it.effect(
    "a real marker kept from an earlier request answers 500 in a later one",
    () =>
      Effect.gen(function* () {
        expect((yield* sendKept("/keep")).status).toBe(200);
        expect(keptMatched).toBe(true);
        const matchedLater = yield* Routes.isArgumentValidationFailure(kept);
        expect(matchedLater).toBe(false);
        expect((yield* sendKept("/replay")).status).toBe(500);
      }),
  );
});

describe("Routes.isArgumentValidationFailure", () => {
  it.each([
    [new Error('ArgumentValidationError: Found ID "x"')],
    [new Error("Validator error: Missing required field `noteId`")],
    [undefined],
  ])("does not match %s by its message", (defect) => {
    expect(Effect.runSync(Routes.isArgumentValidationFailure(defect))).toBe(
      false,
    );
  });
});

// A route whose nested mutation receives an extra argument field. One target's
// arguments hold a secret, so Confect refuses them in Convex's place; the
// other's are refused by Convex's own validator.
const store = FunctionSpec.httpAction({
  name: "store",
  method: "POST",
  path: "/store",
  args: () => ({ target: Schema.Literals(["secret", "plain"]) }),
  returns: () => Schema.Null,
});
const stores = GroupSpec.make().addFunction(store);
const storeTarget = (value: Schema.Codec<any, string>) => {
  const item = FunctionRegistryItem.make({
    functionSpec: FunctionSpec.internalMutation({
      name: "store",
      args: () => ({ value }),
      returns: () => Schema.Null,
    }),
    groupMiddlewareAttachments: [],
    handler: () => Effect.succeed(null),
  });
  if (item._tag !== "Confect") throw new Error("Expected a Confect function");
  return RegisteredConvexFunction.make(schema, item);
};
const storesImpl = GroupImpl.make(schema, stores).pipe(
  Layer.provide(
    FunctionImpl.make(schema, stores, "store", ({ target }) =>
      Effect.flatMap(MutationRunner.MutationRunner, ({ runMutation }) =>
        runMutation(
          Ref.fromFunctionReference(
            makeFunctionReference<"mutation", any, null>(`targets:${target}`),
          ),
          { value: "a value", extra: 1 },
        ),
      ).pipe(Effect.orDie),
    ),
  ),
  GroupImpl.finalize,
);
const storeRoutes = Routes.make(schema, {
  "groups/stores": [stores, storesImpl],
});
const storeRouter = ConfectHttpRouter.make(schema, storeRoutes.routes, {
  api: storeRoutes.api,
  guard: Guard.none,
});

describe("a nested call Confect refuses for its secret arguments", () => {
  it.effect("answers the empty 400, as Convex's own refusal does", () =>
    Effect.gen(function* () {
      const t = convexTest(convexSchema, {
        ...modules,
        "./mock-backend/fixtures/convex/targets.ts": () =>
          Promise.resolve({
            secret: storeTarget(Schema.String.pipe(Schema.RedactedFromValue)),
            plain: storeTarget(Schema.String),
          }),
        "./mock-backend/fixtures/convex/http.ts": () =>
          Promise.resolve({ default: storeRouter }),
      });
      const status = (target: string) =>
        Effect.promise(() =>
          t.fetch("/store", {
            method: "POST",
            body: `{"target":"${target}"}`,
            headers: { "content-type": "application/json" },
          }),
        ).pipe(Effect.map((response) => response.status));
      expect({
        secret: yield* status("secret"),
        plain: yield* status("plain"),
      }).toEqual({ secret: 400, plain: 400 });
    }),
  );
});

describe("a route that holds a secret", () => {
  const Secret = Schema.String.pipe(Schema.RedactedFromValue);
  class Leaked extends Schema.TaggedError<
    Leaked,
    { readonly brand: unique symbol }
  >()("Leaked", { token: Secret }, { httpApiStatus: 403 }) {}
  const routeOf = (
    method: "GET" | "POST",
    path: string,
    args: Readonly<Record<string, Schema.Codec<any, any>>>,
    returns: Schema.Codec<any, any>,
    error?: Schema.Codec<any, any>,
  ) => {
    const group = GroupSpec.make().addFunction(
      FunctionSpec.httpAction({
        name: "held",
        method,
        path,
        args: () => args,
        returns: () => returns,
        ...(error === undefined ? {} : { error: () => error }),
      }),
    );
    const impl = GroupImpl.make(schema, group).pipe(
      Layer.provide(
        FunctionImpl.make(schema, group, "held", () =>
          Effect.succeed(null as never),
        ),
      ),
      GroupImpl.finalize,
    );
    const built = Routes.make(schema, { "groups/held": [group, impl] });
    return () =>
      ConfectHttpRouter.make(schema, built.routes, {
        api: built.api,
        guard: Guard.none,
      });
  };

  it.each([
    ["params", routeOf("GET", "/held/:token", { token: Secret }, Schema.Null)],
    ["query", routeOf("GET", "/held", { token: Secret }, Schema.Null)],
    ["payload", routeOf("POST", "/held", { token: Secret }, Schema.Null)],
    ["returns", routeOf("GET", "/held", {}, Schema.Struct({ token: Secret }))],
    ["error", routeOf("GET", "/held", {}, Schema.Null, Leaked)],
  ] as const)("is refused when its %s holds one", (slot, make) => {
    expect(make).toThrow(
      expect.objectContaining({
        _tag: "RouteHoldsSecret",
        functionPath: "groups/held:held",
        slot,
      }),
    );
    expect(make).toThrow(
      `Route "groups/held:held" holds a secret in its ${slot}. Effect's HTTP layer reports a route's refused request, response and error with their values, so a route takes no secret: send it through a function instead.`,
    );
  });

  it("is refused when a middleware's error holds one", () => {
    class Withheld extends Schema.TaggedError<
      Withheld,
      { readonly brand: unique symbol }
    >()("Withheld", { token: Secret }, { httpApiStatus: 401 }) {}
    class Guarded extends MiddlewareSpec.MiddlewareSpec<Guarded>()("Guarded", {
      error: () => Withheld,
      functionTypes: { query: true, mutation: true, action: true },
    }) {}
    const group = GroupSpec.make()
      .middleware(Guarded)
      .addFunction(
        FunctionSpec.httpAction({
          name: "held",
          method: "GET",
          path: "/held",
          args: () => ({}),
          returns: () => Schema.Null,
        }),
      );
    const impl = GroupImpl.make(schema, group).pipe(
      Layer.provide(
        FunctionImpl.make(schema, group, "held", () => Effect.succeed(null)),
      ),
      Layer.provide(MiddlewareImpl.make(schema, Guarded, (effect) => effect)),
      GroupImpl.finalize,
    );
    const built = Routes.make(schema, { "groups/held": [group, impl] });
    expect(() =>
      ConfectHttpRouter.make(schema, built.routes, {
        api: built.api,
        guard: Guard.none,
      }),
    ).toThrow(
      expect.objectContaining({
        _tag: "RouteHoldsSecret",
        functionPath: "groups/held:held",
        slot: "error",
      }),
    );
  });

  it("is served when none of its slots holds one", () => {
    expect(
      routeOf(
        "POST",
        "/held/:id",
        { id: Schema.String, n: Schema.Finite },
        Schema.Null,
        Missing,
      ),
    ).not.toThrow();
  });
});

describe("SecretSides.isArgumentRefusal", () => {
  const data = (tag: string, side: string) => ({
    _tag: tag,
    side,
    path: ".value",
    validator: "v.string()",
  });
  it.each([
    [
      "Confect's refusal of arguments",
      data(SecretSides.refusalTag, "arguments"),
      true,
    ],
    [
      "the same data as Convex's JSON text",
      KernelJson.stringify(data(SecretSides.refusalTag, "arguments")),
      true,
    ],
    [
      "Confect's refusal of a return",
      data(SecretSides.refusalTag, "returns"),
      false,
    ],
    [
      "a product's own ConvexError with a plain tag",
      data("SecretSideRefused", "arguments"),
      false,
    ],
  ])("matches %s: %s", (_name, payload, matches) => {
    expect(SecretSides.isArgumentRefusal(new ConvexError(payload))).toBe(
      matches,
    );
  });
});

describe("a nested call's argument refusal", () => {
  it.each([
    [new Error('ArgumentValidationError: Found ID "x"'), true],
    [new Error("Validator error: Missing required field `noteId`"), true],
    [new Error("Uncaught Error: plain boom"), false],
    ["ArgumentValidationError: not an Error", false],
    [undefined, false],
  ])("matches %s: %s", (error, matches) => {
    expect(ArgumentRefusal.isRefusal(error)).toBe(matches);
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
      { api: [OtherApi, routes.api], guard: Guard.none },
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
