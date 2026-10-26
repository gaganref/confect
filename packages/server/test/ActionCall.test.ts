import { ActionCall, FunctionSpec, GroupSpec, Ref } from "@confect/core";
import { FunctionImpl, QueryRunner, Scheduler } from "@confect/server";
import { expectTypeOf, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import schema from "./mock-backend/fixtures/confect/_generated/schema";

it("derives call arguments and results and excludes raw runners", () => {
  const target = Ref.make(
    "test",
    FunctionSpec.internalMutation({
      name: "set",
      args: () => ({ value: Schema.String }),
      returns: () => Schema.Finite,
    }),
  );
  const check = (call: ActionCall.Call) => {
    expectTypeOf(call(target, { value: "a" })).toEqualTypeOf<
      Effect.Effect<number, Schema.SchemaError>
    >();
    // @ts-expect-error The reference requires a string argument.
    const invalid = call(target, { value: 1 });
    return invalid;
  };
  expectTypeOf(check).toBeFunction();
  const group = GroupSpec.make().addFunction(
    ActionCall.profile.publicAction({
      name: "run",
      returns: () => Schema.Finite,
    }),
  );
  const raw = () => Effect.as(QueryRunner.QueryRunner, 0);
  // @ts-expect-error The profile excludes the raw runner from the handler.
  FunctionImpl.make(schema, group, "run", raw);
  const schedule = () => Effect.as(Scheduler.Scheduler, 0);
  // @ts-expect-error The profile excludes scheduling from the handler.
  FunctionImpl.make(schema, group, "run", schedule);
});
