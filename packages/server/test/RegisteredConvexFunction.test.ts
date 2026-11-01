import * as RegisteredFunction from "@confect/server/RegisteredFunction";
import type * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as FunctionSpec from "@confect/core/FunctionSpec";
import * as DatabaseSchema from "@confect/server/DatabaseSchema";
import * as FunctionRegistryItem from "@confect/server/FunctionRegistryItem";
import * as RegisteredConvexFunction from "@confect/server/RegisteredConvexFunction";
import { assert, describe, expect, expectTypeOf, it } from "@effect/vitest";
import * as Convex from "convex/server";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { vi } from "vitest";

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
      const registration = vi.mocked(register);
      registration.mockClear();
      const prepared = RegisteredConvexFunction.prepare(database, item);
      expect(registration).not.toHaveBeenCalled();
      expect(prepared._tag.toLowerCase()).toBe(
        `${spec.functionVisibility}${spec.runtimeAndFunctionType.functionType}`,
      );
      RegisteredConvexFunction.register(prepared);
      expect(registration).toHaveBeenCalledExactlyOnceWith(prepared);
      const [preparedCall] = registration.mock.calls;
      assert(preparedCall);
      expect(preparedCall[0]).toBe(prepared);
      registration.mockClear();
      RegisteredConvexFunction.make(database, item);
      expect(registration).toHaveBeenCalledOnce();
      const [call] = registration.mock.calls;
      assert(call);
      const [definition] = call;
      assert(typeof definition !== "function");
      expect(definition.args).toEqual(prepared.args);
      expect(definition.returns).toEqual(prepared.returns);
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
                  },
                  {
                    value: undefined,
                    requestId: "request-1",
                    deployment: "https://fixture.convex.cloud",
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
