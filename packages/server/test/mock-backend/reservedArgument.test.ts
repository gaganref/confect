import * as FunctionSpec from "@confect/core/FunctionSpec";
import * as DatabaseSchema from "@confect/server/DatabaseSchema";
import * as FunctionRegistryItem from "@confect/server/FunctionRegistryItem";
import * as RegisteredConvexFunction from "@confect/server/RegisteredConvexFunction";
import * as RegisteredNodeFunction from "@confect/server/RegisteredNodeFunction";
import { convexTest } from "convex-test";
import { defineSchema, makeFunctionReference } from "convex/server";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { assert, describe, expect, it } from "@effect/vitest";

const profile = FunctionSpec.extend()({
  middleware: [],
  reservedArgument: "context",
});
const database = DatabaseSchema.make({});
const item = (spec: FunctionSpec.AnyWithProps) => {
  const result = FunctionRegistryItem.make({
    functionSpec: spec,
    groupMiddlewareAttachments: [],
    handler: (args) => Effect.succeed(args),
  });
  if (result._tag !== "Confect") throw new Error("Expected a Confect function");
  return result;
};
const options = {
  name: "echo",
  args: () => ({ value: Schema.String }),
  returns: () => Schema.Struct({ value: Schema.String }),
};

describe("reserved arguments", () => {
  describe.each(["public", "internal"] as const)(
    "%s registrations",
    (visibility) => {
      it.each([null, "text", 42, { nested: [1, { value: false }] }])(
        "accepts %j beside the domain arguments",
        (context) => {
          const mutation = RegisteredConvexFunction.make(
            database,
            item(
              visibility === "public"
                ? profile.publicMutation(options)
                : FunctionSpec.internalMutation({
                    ...options,
                    reservedArgument: "context",
                  }),
            ),
          );
          const action = RegisteredConvexFunction.make(
            database,
            item(
              visibility === "public"
                ? profile.publicAction(options)
                : FunctionSpec.internalAction({
                    ...options,
                    reservedArgument: "context",
                  }),
            ),
          );
          const node = RegisteredNodeFunction.make(
            database,
            item(
              visibility === "public"
                ? profile.publicNodeAction(options)
                : FunctionSpec.internalNodeAction({
                    ...options,
                    reservedArgument: "context",
                  }),
            ),
          );
          const t = convexTest(defineSchema({}), {
            "./_generated/server.ts": () => Promise.resolve({}),
            "./reserved.ts": () => Promise.resolve({ mutation, action, node }),
          });
          const args = { value: "ok", context };
          return Promise.all([
            t.mutation(
              makeFunctionReference<"mutation", typeof args>(
                "reserved:mutation",
              ),
              args,
            ),
            t.action(
              makeFunctionReference<"action", typeof args>("reserved:action"),
              args,
            ),
            t.action(
              makeFunctionReference<"action", typeof args>("reserved:node"),
              args,
            ),
          ]).then((results) =>
            expect(results).toEqual([
              { value: "ok" },
              { value: "ok" },
              { value: "ok" },
            ]),
          );
        },
      );
    },
  );

  it("compiles an optional any validator and refuses collisions when it compiles", () => {
    const definition = RegisteredConvexFunction.prepare(
      database,
      item(profile.publicMutation(options)),
    );
    assert(definition._tag === "PublicMutation");
    expect(definition.args()).toMatchObject({
      context: { kind: "any", isOptional: "optional" },
    });
    const colliding = RegisteredConvexFunction.prepare(
      database,
      item(
        profile.publicMutation({
          ...options,
          args: () => ({ context: Schema.String }),
        }),
      ),
    );
    assert(colliding._tag === "PublicMutation");
    expect(() => colliding.args()).toThrow(
      'echo declares the argument "context", which its profile reserves. Rename the argument.',
    );
  });
});
