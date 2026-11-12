import * as RegisteredFunction from "@confect/server/RegisteredFunction";
import type * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as Result from "effect/Result";
import * as Str from "effect/String";
import * as FunctionSpec from "@confect/core/FunctionSpec";
import * as SchemaToValidator from "@confect/core/SchemaToValidator";
import * as DatabaseSchema from "@confect/server/DatabaseSchema";
import * as FunctionRegistryItem from "@confect/server/FunctionRegistryItem";
import * as RegisteredConvexFunction from "@confect/server/RegisteredConvexFunction";
import {
  afterEach,
  assert,
  describe,
  expect,
  expectTypeOf,
  it,
} from "@effect/vitest";
import * as Convex from "convex/server";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { vi } from "vitest";

afterEach(() => vi.restoreAllMocks());

vi.mock("convex/server", (importOriginal) =>
  importOriginal<typeof Convex>().then((original) => ({
    ...original,
    queryGeneric: vi.fn(original.queryGeneric),
    internalQueryGeneric: vi.fn(original.internalQueryGeneric),
    mutationGeneric: vi.fn(original.mutationGeneric),
    internalMutationGeneric: vi.fn(original.internalMutationGeneric),
    actionGeneric: vi.fn(original.actionGeneric),
    internalActionGeneric: vi.fn(original.internalActionGeneric),
  })),
);

describe("make", () => {
  it("limits preparation to the six isolate registration kinds", () => {
    expectTypeOf<
      ReturnType<typeof RegisteredConvexFunction.prepare>["_tag"]
    >().toEqualTypeOf<
      | "PublicQuery"
      | "InternalQuery"
      | "PublicMutation"
      | "InternalMutation"
      | "PublicAction"
      | "InternalAction"
    >();
    expectTypeOf<
      Parameters<typeof RegisteredConvexFunction.make>["length"]
    >().toEqualTypeOf<2 | 3>();
  });
  const options = {
    name: "get",
    args: () => ({ value: Schema.String }),
    returns: () => Schema.String,
  };
  it.each([
    {
      name: "public query",
      spec: FunctionSpec.publicQuery(options),
      register: Convex.queryGeneric,
    },
    {
      name: "internal query",
      spec: FunctionSpec.internalQuery(options),
      register: Convex.internalQueryGeneric,
    },
    {
      name: "public mutation",
      spec: FunctionSpec.publicMutation(options),
      register: Convex.mutationGeneric,
    },
    {
      name: "internal mutation",
      spec: FunctionSpec.internalMutation(options),
      register: Convex.internalMutationGeneric,
    },
    {
      name: "public action",
      spec: FunctionSpec.publicAction(options),
      register: Convex.actionGeneric,
    },
    {
      name: "internal action",
      spec: FunctionSpec.internalAction(options),
      register: Convex.internalActionGeneric,
    },
  ])(
    "prepares a closed definition and registers a $name handler",
    ({ spec, register }) => {
      const handler = () => Effect.succeed("ok");
      const item = FunctionRegistryItem.make({
        functionSpec: spec,
        groupMiddlewareAttachments: [],
        handler,
      });
      assert(item._tag === "Confect");
      const database = DatabaseSchema.make({});
      const compileArgs = vi.spyOn(SchemaToValidator, "compileArgsSchema");
      const compileReturns = vi.spyOn(
        SchemaToValidator,
        "compileReturnsSchema",
      );
      const registration = vi.mocked(register);
      registration.mockClear();
      const prepared = RegisteredConvexFunction.prepare(database, item);
      expect(registration).not.toHaveBeenCalled();
      expect(Str.toLowerCase(prepared._tag)).toBe(
        `${spec.functionVisibility}${spec.runtimeAndFunctionType.functionType}`,
      );
      const forwardedHandler = () => Promise.resolve("forwarded");
      const registered = RegisteredConvexFunction.register({
        ...prepared,
        handler: forwardedHandler,
      });
      expect(compileArgs).not.toHaveBeenCalled();
      expect(compileReturns).not.toHaveBeenCalled();
      expect(registration).toHaveBeenCalledOnce();
      const [preparedCall] = registration.mock.calls;
      assert(preparedCall);
      const boundary = preparedCall[0];
      assert(typeof boundary !== "function");
      expect(Object.is(boundary, prepared)).toBe(false);
      expect(boundary.handler).toBe(forwardedHandler);
      expect(Object.getOwnPropertyDescriptor(boundary, "args")).toMatchObject({
        get: expect.any(Function),
      });
      expect(
        Object.getOwnPropertyDescriptor(boundary, "returns"),
      ).toMatchObject({
        get: expect.any(Function),
      });
      const exported = registered as unknown as {
        exportArgs: () => string;
        exportReturns: () => string;
      };
      const argsJson = exported.exportArgs();
      expect(compileArgs).toHaveBeenCalledOnce();
      expect(compileReturns).not.toHaveBeenCalled();
      const returnsJson = exported.exportReturns();
      expect(compileReturns).toHaveBeenCalledOnce();
      expect(exported.exportArgs()).toBe(argsJson);
      expect(exported.exportReturns()).toBe(returnsJson);
      expect(compileArgs).toHaveBeenCalledOnce();
      expect(compileReturns).toHaveBeenCalledOnce();
      expect(
        Schema.decodeResult(Schema.fromJsonString(Schema.Unknown))(
          argsJson,
        ).pipe(Result.getOrThrow),
      ).toEqual({
        type: "object",
        value: { value: { fieldType: { type: "string" }, optional: false } },
      });
      expect(
        Schema.decodeResult(Schema.fromJsonString(Schema.Unknown))(
          returnsJson,
        ).pipe(Result.getOrThrow),
      ).toEqual({ type: "string" });
      registration.mockClear();
      RegisteredConvexFunction.make(database, item);
      expect(registration).toHaveBeenCalledOnce();
      const [call] = registration.mock.calls;
      assert(call);
      const [definition] = call;
      assert(typeof definition !== "function");
      expect(definition.args).toEqual(prepared.args());
      expect(definition.returns).toEqual(prepared.returns());
      expect(item.handler).toBe(handler);
    },
  );
});

describe("invocation context", () => {
  it.each([
    { type: "mutation", reserves: true },
    { type: "action", reserves: true },
    { type: "query", reserves: true },
    { type: "mutation", reserves: false },
    { type: "action", reserves: false },
  ] as const)(
    "projects private metadata at root creation for $type, reserved $reserves",
    ({ type, reserves }) => {
      const profile = FunctionSpec.extend()({
        middleware: [],
        reservedArgument: "context",
      });
      const roots: Array<unknown> = [];
      let current: Fiber.Fiber<any, any> | undefined;
      const runtime = Layer.succeed(
        Tracer.Tracer,
        Tracer.make({
          context(effect, fiber) {
            const previous = current;
            current = fiber;
            try {
              return effect["~effect/Effect/evaluate"](fiber);
            } finally {
              current = previous;
            }
          },
          span(options) {
            roots.push(current?.getRef(RegisteredFunction.Received));
            return new Tracer.NativeSpan(options);
          },
        }),
      );
      const options = {
        name: "echo",
        args: () => ({ value: Schema.String }),
        returns: () => Schema.String,
      };
      const spec = reserves
        ? profile[
            type === "mutation"
              ? "publicMutation"
              : type === "action"
                ? "publicAction"
                : "publicQuery"
          ](options)
        : type === "mutation"
          ? FunctionSpec.publicMutation(options)
          : FunctionSpec.publicAction(options);
      const item = FunctionRegistryItem.make({
        functionSpec: spec,
        groupMiddlewareAttachments: [],
        handler: ({ value }) => Effect.succeed(value),
      });
      assert(item._tag === "Confect");
      const prepared = RegisteredConvexFunction.prepare(
        DatabaseSchema.make({}),
        item,
        [],
        runtime,
      );
      const meta = {
        getFunctionMetadata: () =>
          Promise.resolve({
            name: "items:echo",
            type,
            visibility: "public",
            componentPath: "",
          }),
        getRequestMetadata: () =>
          Promise.resolve({
            requestId: "request-1",
            authToken: "fixture-private-token",
          }),
      };
      const ctx = {
        meta,
        db: { system: {} },
        auth: {},
        storage: {},
        scheduler: {},
        runQuery: () => Promise.resolve(null),
        runMutation: () => Promise.resolve(null),
        runAction: () => Promise.resolve(null),
        vectorSearch: () => Promise.resolve([]),
      };
      vi.stubEnv("CONVEX_CLOUD_URL", "https://fixture.convex.cloud");
      return prepared
        .handler(ctx as never, { value: "ok", context: null })
        .then((result) => {
          expect(result).toBe("ok");
          return prepared.handler(ctx as never, { value: "again" });
        })
        .then((result) => {
          expect(result).toBe("again");
          expect(roots).toEqual(
            type === "query" || !reserves
              ? [undefined, undefined]
              : [
                  {
                    value: null,
                    requestId: "request-1",
                    deployment: "https://fixture.convex.cloud",
                    visibility: "public",
                  },
                  {
                    value: undefined,
                    requestId: "request-1",
                    deployment: "https://fixture.convex.cloud",
                    visibility: "public",
                  },
                ],
          );
          expect(JSON.stringify(roots)).not.toContain("fixture-private-token");
          const plain = RegisteredConvexFunction.prepare(
            DatabaseSchema.make({}),
            item,
          );
          const unreadable = {
            ...ctx,
            meta: {
              getFunctionMetadata: () =>
                Promise.reject(new Error("No metadata read without a runtime")),
              getRequestMetadata: () =>
                Promise.reject(
                  new Error("No private metadata read without a runtime"),
                ),
            },
          };
          return plain
            .handler(unreadable as never, { value: "plain" })
            .then((value) => expect(value).toBe("plain"));
        })
        .finally(() => vi.unstubAllEnvs());
    },
  );
});

describe("received visibility", () => {
  const options = {
    reservedArgument: "context",
    name: "echo",
    args: () => ({ value: Schema.String }),
    returns: () => Schema.String,
  };

  const readReceived = (
    spec: FunctionSpec.AnyWithProps,
    functionMetadata: Record<string, unknown>,
  ) => {
    const roots: Array<unknown> = [];
    let current: Fiber.Fiber<any, any> | undefined;
    const runtime = Layer.succeed(
      Tracer.Tracer,
      Tracer.make({
        context(effect, fiber) {
          const previous = current;
          current = fiber;
          try {
            return effect["~effect/Effect/evaluate"](fiber);
          } finally {
            current = previous;
          }
        },
        span(spanOptions) {
          roots.push(current?.getRef(RegisteredFunction.Received));
          return new Tracer.NativeSpan(spanOptions);
        },
      }),
    );
    const item = FunctionRegistryItem.make({
      functionSpec: spec,
      groupMiddlewareAttachments: [],
      handler: ({ value }) => Effect.succeed(value),
    });
    assert(item._tag === "Confect");
    const prepared = RegisteredConvexFunction.prepare(
      DatabaseSchema.make({}),
      item,
      [],
      runtime,
    );
    const ctx = {
      meta: {
        getFunctionMetadata: () =>
          Promise.resolve({
            name: "items:echo",
            componentPath: "",
            ...functionMetadata,
          }),
        getRequestMetadata: () =>
          Promise.resolve({ requestId: "request-1", authToken: "unused" }),
      },
      db: { system: {} },
      auth: {},
      storage: {},
      scheduler: {},
      runQuery: () => Promise.resolve(null),
      runMutation: () => Promise.resolve(null),
      runAction: () => Promise.resolve(null),
      vectorSearch: () => Promise.resolve([]),
    };
    vi.stubEnv("CONVEX_CLOUD_URL", "https://fixture.convex.cloud");
    return prepared
      .handler(ctx as never, { value: "ok", context: null })
      .then(() => roots)
      .finally(() => vi.unstubAllEnvs());
  };

  it.each([
    {
      name: "public mutation",
      spec: FunctionSpec.publicMutation(options),
      type: "mutation",
      visibility: "public",
    },
    {
      name: "internal mutation",
      spec: FunctionSpec.internalMutation(options),
      type: "mutation",
      visibility: "internal",
    },
    {
      name: "public action",
      spec: FunctionSpec.publicAction(options),
      type: "action",
      visibility: "public",
    },
    {
      name: "internal action",
      spec: FunctionSpec.internalAction(options),
      type: "action",
      visibility: "internal",
    },
  ] as const)(
    "a $name sees its own visibility on the root span",
    ({ spec, type, visibility }) =>
      readReceived(spec, { type, visibility }).then(([received]) =>
        expect(received).toEqual({
          value: null,
          requestId: "request-1",
          deployment: "https://fixture.convex.cloud",
          visibility,
        }),
      ),
  );

  it.each([
    { name: "mutation", spec: FunctionSpec.publicMutation(options) },
    { name: "action", spec: FunctionSpec.publicAction(options) },
  ] as const)(
    "a $name with no visibility from Convex has none on the root span",
    ({ name, spec }) =>
      readReceived(spec, { type: name }).then(([received]) =>
        expect(received).toStrictEqual({
          value: null,
          requestId: "request-1",
          deployment: "https://fixture.convex.cloud",
        }),
      ),
  );
});
