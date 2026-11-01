import { ActionCall, FunctionSpec, GroupSpec, Ref } from "@confect/core";
import {
  ConvexFunctionDefinitions,
  GroupImpl,
  RegisteredFunction,
  ActionCall as ServerActionCall,
  FunctionImpl,
  QueryRunner,
  Scheduler,
} from "@confect/server";
import * as Forwarding from "./internal/forwarding";
import * as Layer from "effect/Layer";
import { expect, expectTypeOf, it } from "@effect/vitest";
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

it.effect.each(Forwarding.cases)(
  "forwards $label through the action-call profile",
  ({ forward, enabled }) =>
    Effect.gen(function* () {
      const targets = [
        ...Forwarding.mutations,
        Ref.make("items", Forwarding.profile.publicQuery(Forwarding.options)),
      ];
      for (const [index, target] of targets.entries()) {
        const group = GroupSpec.make().addFunction(
          ActionCall.profile.publicAction({
            name: "echo",
            returns: () => Schema.Unknown,
          }),
        );
        const definitions = ConvexFunctionDefinitions.buildForGroup<
          typeof group
        >(
          schema,
          GroupImpl.make(schema, group).pipe(
            Layer.provide(
              FunctionImpl.make(schema, group, "echo", () =>
                Effect.flatMap(ActionCall.ActionCall, (call) =>
                  call(target, { count: 1 }),
                ).pipe(
                  Effect.provideService(RegisteredFunction.Forward, forward),
                  Effect.orDie,
                ),
              ),
            ),
            Layer.provide(ServerActionCall.layer(schema)),
            GroupImpl.finalize,
          ),
        );
        const result = yield* Effect.promise(() =>
          definitions.echo.handler(
            {
              auth: {},
              storage: {},
              scheduler: {},
              vectorSearch: () => Promise.resolve([]),
              runQuery: Forwarding.echo,
              runMutation: Forwarding.echo,
            } as never,
            {},
          ),
        );
        expect(result).toEqual({
          count: "1",
          ...(enabled && index === 0
            ? { context: { boundary: "ActionCall" } }
            : {}),
        });
      }
    }),
);
