import { Providers } from "@confect/alchemy/Providers";
import * as EnvironmentVariables from "@confect/alchemy/EnvironmentVariables";
import { expect, it } from "@effect/vitest";
import { DestroyError } from "alchemy/Apply";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import { makeEngine } from "../fixtures/Engine";
import { mockClient } from "../fixtures/ConvexClient";

const props = {
  url: "https://happy-otter-123.convex.cloud",
  deployKey: Redacted.make("test-key"),
};

it.effect.each([{ value: null }, { value: undefined }])(
  "refuses destroy after plan rejects a nullish unowned name, %s",
  ({ value }) => {
    const mock = mockClient();
    return Effect.gen(function* () {
      const engine = yield* makeEngine(
        Layer.effect(
          Providers,
          Provider.collection([EnvironmentVariables.EnvironmentVariables]),
        ).pipe(
          Layer.provide(EnvironmentVariables.layer),
          Layer.provide(mock.layer),
        ),
      );
      const news = {
        ...props,
        unownedPolicy: "error",
        variables: { A: "a", N: value },
      } as unknown as EnvironmentVariables.EnvironmentVariablesProps;
      const program = EnvironmentVariables.EnvironmentVariables(
        "Environment",
        news,
      );
      yield* engine.run(program);
      mock.state.variables.N = Redacted.make("hand");
      const planned = yield* engine
        .run(program, { apply: false })
        .pipe(Effect.exit);
      expect(Exit.isFailure(planned)).toBe(true);
      if (Exit.isFailure(planned))
        expect(Cause.squash(planned.cause)).toMatchObject({
          _tag: "EnvironmentVariableUnowned",
          variableName: "N",
        });
      const destroyed = yield* engine.run(Effect.void).pipe(Effect.exit);
      expect(Exit.isFailure(destroyed)).toBe(true);
      if (Exit.isFailure(destroyed)) {
        const error = Cause.squash(destroyed.cause);
        expect(error).toBeInstanceOf(DestroyError);
        if (error instanceof DestroyError) {
          expect(error.failures).toHaveLength(1);
          expect(Cause.squash(error.failures[0]!.cause)).toMatchObject({
            _tag: "EnvironmentVariableUnowned",
            variableName: "N",
          });
          expect(error.blocked).toEqual([]);
        }
        expect(String(Cause.squash(destroyed.cause))).not.toContain("hand");
      }
      expect(mock.state.environmentUpdates).toEqual([
        [{ name: "A", value: Redacted.make("a") }],
      ]);
    });
  },
);
