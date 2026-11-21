import { FunctionSpec, GroupSpec } from "@confect/core";
import * as ConvexFunctionDefinitions from "@confect/server/ConvexFunctionDefinitions";
import * as DatabaseSchema from "@confect/server/DatabaseSchema";
import * as FunctionImpl from "@confect/server/FunctionImpl";
import * as GroupImpl from "@confect/server/GroupImpl";
import * as HttpRouter from "@confect/server/HttpRouter";
import * as PushCheck from "@confect/server/PushCheck";
import * as RegisteredConvexFunction from "@confect/server/RegisteredConvexFunction";
import * as RegisteredFunctions from "@confect/server/RegisteredFunctions";
import { RegisteredNodeFunction } from "@confect/server/node";
import { describe, expect, it } from "@effect/vitest";
import {
  actionGeneric,
  internalMutationGeneric,
  queryGeneric,
} from "convex/server";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";

/**
 * A check that counts its runs and refuses with `refusals`.
 */
const counted = (name: string, refusals: ReadonlyArray<string> = []) => {
  const runs = { count: 0 };
  const check = PushCheck.make(name, () => {
    runs.count++;
    return refusals;
  });
  return { check, runs };
};

const returns = { returns: () => Schema.String };
const nativeQuery = queryGeneric({ args: {}, handler: () => "native" });
const nativeMutation = internalMutationGeneric({
  args: {},
  handler: () => "native",
});

const isolateGroup = GroupSpec.make()
  .addFunction(FunctionSpec.publicQuery({ ...returns, name: "publicQuery" }))
  .addFunction(
    FunctionSpec.internalQuery({ ...returns, name: "internalQuery" }),
  )
  .addFunction(
    FunctionSpec.publicMutation({ ...returns, name: "publicMutation" }),
  )
  .addFunction(
    FunctionSpec.internalMutation({ ...returns, name: "internalMutation" }),
  )
  .addFunction(FunctionSpec.publicAction({ ...returns, name: "publicAction" }))
  .addFunction(
    FunctionSpec.internalAction({ ...returns, name: "internalAction" }),
  )
  .addFunction(
    FunctionSpec.convexPublicQuery<typeof nativeQuery>()("nativeQuery"),
  )
  .addFunction(
    FunctionSpec.convexInternalMutation<typeof nativeMutation>()(
      "nativeMutation",
    ),
  );

const confectNames = [
  "publicQuery",
  "internalQuery",
  "publicMutation",
  "internalMutation",
  "publicAction",
  "internalAction",
] as const;

/**
 * A backend of its own: a fresh database schema, as each evaluation of a
 * generated `_generated/schema` module makes, and its isolate group's layer.
 */
const isolateBackend = () => {
  const schema = DatabaseSchema.make({});
  const layer = GroupImpl.make(schema, isolateGroup).pipe(
    Layer.provide(
      Arr.map(confectNames, (name) =>
        FunctionImpl.make(schema, isolateGroup, name, () =>
          Effect.succeed(name),
        ),
      ),
    ),
    Layer.provide(
      FunctionImpl.make(schema, isolateGroup, "nativeQuery", nativeQuery),
    ),
    Layer.provide(
      FunctionImpl.make(schema, isolateGroup, "nativeMutation", nativeMutation),
    ),
    GroupImpl.finalize,
  );
  return { schema, layer };
};

const nativeNodeAction = actionGeneric({
  args: {},
  handler: () => Promise.resolve("native"),
});

const nodeGroup = GroupSpec.makeNode()
  .addFunction(FunctionSpec.publicNodeAction({ ...returns, name: "run" }))
  .addFunction(FunctionSpec.internalNodeAction({ ...returns, name: "hidden" }))
  .addFunction(
    FunctionSpec.convexPublicNodeAction<typeof nativeNodeAction>()("native"),
  );

const nodeLayer = (schema: DatabaseSchema.AnyWithProps) =>
  GroupImpl.make(schema, nodeGroup).pipe(
    Layer.provide(
      FunctionImpl.make(schema, nodeGroup, "run", () => Effect.succeed("run")),
    ),
    Layer.provide(
      FunctionImpl.make(schema, nodeGroup, "hidden", () =>
        Effect.succeed("hidden"),
      ),
    ),
    Layer.provide(
      FunctionImpl.make(schema, nodeGroup, "native", nativeNodeAction),
    ),
    GroupImpl.finalize,
  );

type Exported = { readonly exportArgs: () => string };

const exportArgs = (value: unknown) => (value as Exported).exportArgs();

const thrown = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
};

/**
 * Every function of a group, as each generated registration builds it: the
 * fixed builder, and the forwarding registration that spreads each prepared
 * definition and returns a native function's handler as it is.
 */
const registrations = (
  schema: DatabaseSchema.AnyWithProps,
  layer: ReturnType<typeof isolateBackend>["layer"],
) => {
  const fixed = RegisteredFunctions.buildForGroup<typeof isolateGroup>(
    schema,
    layer,
  );
  const definitions = ConvexFunctionDefinitions.buildForGroup<
    typeof isolateGroup
  >(schema, layer);
  const forward =
    <Ctx, Args, R>(handler: (ctx: Ctx, args: Args) => Promise<R>) =>
    (ctx: Ctx, args: Args) =>
      handler(ctx, args);
  const forwarded = {
    ...Rec.fromEntries(
      Arr.map(confectNames, (name) => [
        name,
        RegisteredConvexFunction.register({
          ...definitions[name],
          handler: forward(definitions[name].handler as never),
        } as never),
      ]),
    ),
    nativeQuery: definitions.nativeQuery.handler,
    nativeMutation: definitions.nativeMutation.handler,
  };
  return { fixed, forwarded };
};

describe("make", () => {
  it("makes a push check that runs nothing until asked", () => {
    const { check, runs } = counted("authz");
    expect(PushCheck.isPushCheck(check)).toBe(true);
    expect(PushCheck.isPushCheck({ name: "authz", check: () => [] })).toBe(
      false,
    );
    expect(runs.count).toBe(0);
  });
});

describe("verify", () => {
  it("runs the check every time, apart from the analysis memo", () => {
    const { check, runs } = counted("authz");
    expect(Result.isSuccess(PushCheck.verify(check))).toBe(true);
    expect(Result.isSuccess(PushCheck.verify(check))).toBe(true);
    expect(runs.count).toBe(2);
  });

  it("fails with a refusal naming the check and each declaration", () => {
    const { check } = counted("authz", [
      "two permissions are named tasks.read: give each its own name",
      "role editor has no level",
    ]);
    const failure = PushCheck.verify(check).pipe(
      Result.flip,
      Result.getOrThrow,
    );
    expect(failure).toMatchObject({
      _tag: "PushRefused",
      check: "authz",
      refusals: [
        "two permissions are named tasks.read: give each its own name",
        "role editor has no level",
      ],
    });
    expect(failure.message).toBe(`Push check "authz" refused the source:
- two permissions are named tasks.read: give each its own name
- role editor has no level`);
  });
});

describe("register", () => {
  it("keeps each backend's checks apart, once each, and runs none", () => {
    const one = DatabaseSchema.make({});
    const other = DatabaseSchema.make({});
    const { check, runs } = counted("authz");
    PushCheck.register(one, check);
    PushCheck.register(one, check);
    expect(PushCheck.registered(one)).toEqual([check]);
    expect(PushCheck.registered(other)).toEqual([]);
    expect(runs.count).toBe(0);
  });

  it("keeps verdicts off globalThis, whose only addition is the registry every copy shares", () => {
    const keys = () => [
      ...Object.getOwnPropertyNames(globalThis),
      ...Arr.map(Object.getOwnPropertySymbols(globalThis), String),
    ];
    const registry = String(
      Symbol.for("@confect/server/PushCheck/registry/v1"),
    );
    const { schema, layer } = isolateBackend();
    PushCheck.register(schema, counted("authz").check);
    const { publicQuery } = RegisteredFunctions.buildForGroup<
      typeof isolateGroup
    >(schema, layer);
    const before = keys();
    expect(before).toContain(registry);
    exportArgs(publicQuery);
    expect(keys()).toEqual(before);
  });
});

describe("registered functions", () => {
  it.each(["fixed", "forwarded"] as const)(
    "every %s query, mutation and action runs the backend's checks once per check, then delegates",
    (kind) => {
      const { schema, layer } = isolateBackend();
      const first = counted("first");
      const second = counted("second");
      PushCheck.register(schema, first.check);
      PushCheck.register(schema, second.check);
      const functions = registrations(schema, layer)[kind];
      for (const fn of Rec.values(functions as Record<string, unknown>)) {
        expect(PushCheck.targetOf(fn)).toBe(schema);
        expect(exportArgs(fn)).toMatch(/^\{/);
      }
      expect([first.runs.count, second.runs.count]).toEqual([1, 1]);
    },
  );

  it("reads the checks when Convex asks, so one registered after the functions runs", () => {
    const { schema, layer } = isolateBackend();
    const { fixed } = registrations(schema, layer);
    const { check, runs } = counted("late", ["refused"]);
    PushCheck.register(schema, check);
    expect(thrown(() => exportArgs(fixed.publicQuery))).toMatchObject({
      check: "late",
    });
    expect(runs.count).toBe(1);
  });

  it("throws a refusal naming the check, the function and the declaration, every time, from one run", () => {
    const { schema, layer } = isolateBackend();
    const { check, runs } = counted("authz", [
      "two permissions are named tasks.read: give each its own name",
    ]);
    PushCheck.register(schema, counted("passes").check);
    PushCheck.register(schema, check);
    const { fixed, forwarded } = registrations(schema, layer);
    const error = thrown(() => exportArgs(fixed.internalMutation));
    expect(error).toBeInstanceOf(PushCheck.PushRefused);
    expect(error).toMatchObject({
      check: "authz",
      entry: "internalMutation",
      message:
        'Push check "authz" refused the source while Convex analyzed internalMutation: two permissions are named tasks.read: give each its own name',
    });
    expect(thrown(() => exportArgs(forwarded.nativeQuery))).toMatchObject({
      entry: "nativeQuery",
    });
    expect(runs.count).toBe(1);
  });

  it("runs a check another backend registered, or another graph made, apart", () => {
    const one = isolateBackend();
    const other = isolateBackend();
    const refused = counted("one", ["refused"]);
    PushCheck.register(one.schema, refused.check);
    expect(() =>
      exportArgs(
        RegisteredFunctions.buildForGroup<typeof isolateGroup>(
          other.schema,
          other.layer,
        ).publicQuery,
      ),
    ).not.toThrow();
    // The same source evaluated again makes its own check, which runs again.
    const again = counted("one", ["refused"]);
    PushCheck.register(other.schema, again.check);
    expect(
      thrown(() =>
        exportArgs(
          RegisteredFunctions.buildForGroup<typeof isolateGroup>(
            other.schema,
            other.layer,
          ).publicQuery,
        ),
      ),
    ).toBeInstanceOf(PushCheck.PushRefused);
    expect([refused.runs.count, again.runs.count]).toEqual([0, 1]);
  });

  it("guards a copy of each native function and leaves the native unchanged", () => {
    const { schema, layer } = isolateBackend();
    PushCheck.register(schema, counted("authz", ["refused"]).check);
    const { fixed } = registrations(schema, layer);
    expect(fixed.nativeQuery).not.toBe(nativeQuery);
    expect((fixed.nativeQuery as unknown as { isQuery: boolean }).isQuery).toBe(
      true,
    );
    expect(() => exportArgs(nativeQuery)).not.toThrow();
    expect(PushCheck.targetOf(nativeQuery)).toBeUndefined();
  });

  /**
   * A group of one native query, `native`, for `schema`.
   */
  const nativeBackend = (
    schema: DatabaseSchema.AnyWithProps,
    native: typeof nativeQuery,
  ) => {
    const group = GroupSpec.make().addFunction(
      FunctionSpec.convexPublicQuery<typeof nativeQuery>()("native"),
    );
    return RegisteredFunctions.buildForGroup<typeof group>(
      schema,
      GroupImpl.make(schema, group).pipe(
        Layer.provide(FunctionImpl.make(schema, group, "native", native)),
        GroupImpl.finalize,
      ),
    ).native;
  };

  it("guards a copy of a frozen native function, registered checks or none", () => {
    const frozen = Object.freeze(
      queryGeneric({ args: {}, handler: () => "frozen" }),
    );
    const unchecked = nativeBackend(DatabaseSchema.make({}), frozen);
    expect(exportArgs(unchecked)).toBe(exportArgs(frozen));
    const schema = DatabaseSchema.make({});
    PushCheck.register(schema, counted("authz", ["refused"]).check);
    expect(
      thrown(() => exportArgs(nativeBackend(schema, frozen))),
    ).toMatchObject({ check: "authz", entry: "native" });
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(PushCheck.targetOf(frozen)).toBeUndefined();
  });

  it("guards a function another backend's group guarded for this backend alone", () => {
    const one = DatabaseSchema.make({});
    const other = DatabaseSchema.make({});
    const refusedInOne = counted("one", ["refused in one"]);
    const otherCheck = counted("other");
    PushCheck.register(one, refusedInOne.check);
    PushCheck.register(other, otherCheck.check);
    const guardedForOne = nativeBackend(one, nativeQuery);
    const reused = nativeBackend(other, guardedForOne as typeof nativeQuery);
    expect(PushCheck.targetOf(reused)).toBe(other);
    expect(exportArgs(reused)).toBe(exportArgs(nativeQuery));
    expect([refusedInOne.runs.count, otherCheck.runs.count]).toEqual([0, 1]);
    expect(thrown(() => exportArgs(guardedForOne))).toMatchObject({
      check: "one",
    });
  });

  it("keeps what a native function inherits, with its own properties", () => {
    const base = Object.setPrototypeOf(
      { inheritedMark: "inherited" },
      Function.prototype,
    ) as object;
    const native = Object.setPrototypeOf(
      queryGeneric({ args: {}, handler: () => "native" }),
      base,
    ) as typeof nativeQuery;
    const copy = nativeBackend(DatabaseSchema.make({}), native);
    expect(Object.getPrototypeOf(copy)).toBe(base);
    expect((copy as unknown as { inheritedMark: string }).inheritedMark).toBe(
      "inherited",
    );
    for (const key of Reflect.ownKeys(native))
      if (key !== "exportArgs")
        expect((copy as never)[key]).toBe((native as never)[key]);
  });

  it("guards a definition one loaded copy prepared and another registers", () =>
    Effect.gen(function* () {
      // A second instance of the module, as a second installed copy of the
      // package loads one.
      const specifier = "../src/RegisteredConvexFunction.ts?copy=other";
      const otherCopy = yield* Effect.promise(
        () =>
          import(/* @vite-ignore */ specifier) as Promise<
            typeof RegisteredConvexFunction
          >,
      );
      expect(otherCopy.Definition).not.toBe(
        RegisteredConvexFunction.Definition,
      );
      const { schema, layer } = isolateBackend();
      const { check, runs } = counted("authz", ["refused"]);
      PushCheck.register(schema, check);
      const definitions = ConvexFunctionDefinitions.buildForGroup<
        typeof isolateGroup
      >(schema, layer);
      const registered = otherCopy.register({
        ...definitions.publicQuery,
      } as never);
      expect(thrown(() => exportArgs(registered))).toMatchObject({
        check: "authz",
        entry: "publicQuery",
      });
      expect(runs.count).toBe(1);
    }).pipe(Effect.runPromise));

  it("runs no check when a call invokes a function", () =>
    Effect.gen(function* () {
      const { schema, layer } = isolateBackend();
      const { check, runs } = counted("authz", ["refused"]);
      PushCheck.register(schema, check);
      const invoked = registrations(schema, layer).fixed
        .nativeQuery as unknown as {
        readonly invokeQuery: (args: string) => Promise<string>;
      };
      yield* Effect.promise(() => invoked.invokeQuery("[{}]"));
      expect(runs.count).toBe(0);
    }).pipe(Effect.runPromise));

  it("every Node action, Confect or native, runs the backend's checks", () => {
    const schema = DatabaseSchema.make({});
    const { check, runs } = counted("authz", ["refused"]);
    PushCheck.register(schema, check);
    const registered = RegisteredNodeFunction.buildForGroup<typeof nodeGroup>(
      schema,
      nodeLayer(schema),
    );
    for (const name of ["run", "hidden", "native"] as const)
      expect(thrown(() => exportArgs(registered[name]))).toMatchObject({
        entry: name,
      });
    expect(runs.count).toBe(1);
    expect(registered.native).not.toBe(nativeNodeAction);
  });
});

describe("HttpRouter.make", () => {
  const Api = HttpApi.make("guard").add(
    HttpApiGroup.make("probe").add(
      HttpApiEndpoint.get("hello", "/hello", { success: Schema.String }),
    ),
  );
  const routes = HttpApiBuilder.layer(Api).pipe(
    Layer.provide(
      HttpApiBuilder.group(Api, "probe", (handle) =>
        handle.handle("hello", () => Effect.succeed("hi")),
      ),
    ),
  );
  const router = (schema: DatabaseSchema.AnyWithProps) =>
    HttpRouter.make(schema, routes as never, { api: Api });

  it("runs the backend's checks once from getRoutes, then returns its routes", () => {
    const schema = DatabaseSchema.make({});
    const { check, runs } = counted("authz");
    PushCheck.register(schema, check);
    const http = router(schema);
    const first = http.getRoutes();
    expect(http.getRoutes()).toEqual(first);
    expect(Arr.map(first, ([path, method]) => [path, method])).toContainEqual([
      "/hello",
      "GET",
    ]);
    expect(runs.count).toBe(1);
    expect(PushCheck.targetOf(http)).toBe(schema);
  });

  it("answers a refusal with one route whose method is the refusal, which Convex prints", () => {
    const schema = DatabaseSchema.make({});
    PushCheck.register(
      schema,
      counted("authz", ["route /x answers what its scope cannot"]).check,
    );
    const [only, ...rest] = router(schema).getRoutes();
    expect(rest).toEqual([]);
    expect(only?.[1]).toBe(
      'Push check "authz" refused the source while Convex analyzed http: route /x answers what its scope cannot',
    );
  });

  it("serves a request without running a check", () => {
    const schema = DatabaseSchema.make({});
    const { check, runs } = counted("authz", ["refused"]);
    PushCheck.register(schema, check);
    expect(router(schema).lookup("/hello", "GET")).not.toBeNull();
    expect(runs.count).toBe(0);
  });
});

describe("register's observers", () => {
  it("tells every observer in the process's set of each schema a check registers for, after the registry holds it", () => {
    const key = Symbol.for("@confect/server/PushCheck/observers/v1");
    const holder = globalThis as {
      [key]?: Set<(schema: object) => void>;
    };
    const seen: Array<readonly [object, number]> = [];
    const observe = (schema: object) => {
      seen.push([schema, PushCheck.registered(schema).length]);
    };
    (holder[key] ??= new Set()).add(observe);
    try {
      const schema = DatabaseSchema.make({});
      const check = PushCheck.make("observed", () => []);
      PushCheck.register(schema, check);
      PushCheck.register(
        schema,
        PushCheck.make("again", () => []),
      );
      expect(seen).toEqual([
        [schema, 1],
        [schema, 2],
      ]);
    } finally {
      holder[key]?.delete(observe);
    }
  });
});
