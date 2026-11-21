import { Providers } from "@confect/alchemy/Providers";
import * as EnvironmentVariables from "@confect/alchemy/EnvironmentVariables";
import { expect, it } from "@effect/vitest";
import { DestroyError } from "alchemy/Apply";
import * as Output from "alchemy/Output";
import type { InputProps } from "alchemy/Input";
import * as Str from "effect/String";
import * as Code from "@confect/alchemy/Code";
import { CommandRunner } from "../../src/internal/CommandRunner";
import { PushLock } from "../../src/internal/PushLock";
import * as NodeServices from "../fixtures/NodeTestServices";
import { StateStoreError } from "alchemy/State/State";
import * as Result from "effect/Result";
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

for (const form of ["plain", "value Output", "map Output"] as const) {
  it.effect.each([{ value: null }, { value: undefined }])(
    `recovers a completed ${form} removal after a lost state write, $value`,
    ({ value }) => {
      const previous = form === "plain" ? "v0" : "x";
      const mock = mockClient();
      return Effect.gen(function* () {
        let reject = false;
        const engine = yield* makeEngine(
          Layer.effect(
            Providers,
            Provider.collection([
              EnvironmentVariables.EnvironmentVariables,
              Code.Code,
            ]),
          ).pipe(
            Layer.provide(
              Layer.mergeAll(EnvironmentVariables.layer, Code.layer),
            ),
            Layer.provide(mock.layer),
            Layer.provide(NodeServices.layer),
            Layer.provide(
              Layer.succeed(PushLock, { withLock: (_name, effect) => effect }),
            ),
            Layer.provide(
              Layer.succeed(CommandRunner, {
                prepare: () => Effect.void,
                deploy: () => Effect.void,
              }),
            ),
          ),
          (store) => ({
            ...store,
            set: (request) =>
              Effect.suspend(() => {
                if (
                  reject &&
                  request.value.status === "updated" &&
                  Str.endsWith("Environment")(request.fqn)
                ) {
                  reject = false;
                  expect(mock.state.variables).toEqual({
                    K: Redacted.make("k"),
                  });
                  expect(
                    mock.client.updateEnvironmentVariables.mock.calls,
                  ).toEqual([
                    [
                      props.url,
                      expect.anything(),
                      [
                        { name: "N", value: Redacted.make(previous) },
                        { name: "K", value: Redacted.make("k") },
                      ],
                    ],
                    [props.url, expect.anything(), [{ name: "N" }]],
                  ]);
                  return Effect.fail(
                    new StateStoreError({
                      message: "Injected final state failure",
                    }),
                  );
                }
                return store.set(request);
              }),
          }),
        );
        const resources = (removed: boolean, resolved = false) =>
          Effect.gen(function* () {
            const source = yield* Code.Code("Source", {
              deployment: { name: "happy-otter-123", url: props.url },
            });
            const next = removed ? value : previous;
            const variables =
              resolved || form === "plain"
                ? { N: next, K: "k" }
                : form === "value Output"
                  ? { N: Output.map(source.url, () => next), K: "k" }
                  : Output.map(source.url, () => ({ N: next, K: "k" }));
            // Untyped Inputs may resolve to null or undefined at the resource boundary.
            return yield* EnvironmentVariables.EnvironmentVariables(
              "Environment",
              {
                ...props,
                driftPolicy: "error",
                variables,
              } as unknown as InputProps<EnvironmentVariables.EnvironmentVariablesProps>,
            );
          });
        yield* engine.run(resources(false));
        reject = true;
        const failed = yield* engine.run(resources(true)).pipe(Effect.result);
        expect(failed).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "StateStoreError" },
        });
        expect(reject).toBe(false);
        const rows = yield* engine.rows();
        expect(rows).toContainEqual(
          expect.objectContaining({
            status: "updating",
            attr: expect.objectContaining({ ownedNames: ["N", "K"] }),
          }),
        );
        if (form !== "plain") {
          const planned = yield* engine
            .run(resources(true), { apply: false })
            .pipe(Effect.result);
          expect(planned).toEqual(
            Result.fail(
              EnvironmentVariables.EnvironmentVariableDrift.make({
                variableName: "N",
              }),
            ),
          );
        }
        const recovered = yield* engine.run(resources(true, true));
        expect(recovered?.ownedNames).toEqual(["K"]);
        yield* engine.run(resources(true, true));
        yield* engine.run(resources(true, true), { apply: false });
        expect(engine.plans.at(-1)).toContainEqual(
          expect.objectContaining({
            fqn: expect.stringContaining("Environment"),
            action: "noop",
          }),
        );
        const updatedRows = yield* engine.rows();
        expect(updatedRows).toContainEqual(
          expect.objectContaining({
            status: "updated",
            attr: expect.objectContaining({ ownedNames: ["K"] }),
          }),
        );
        expect(mock.client.updateEnvironmentVariables.mock.calls).toEqual([
          [
            props.url,
            expect.anything(),
            [
              { name: "N", value: Redacted.make(previous) },
              { name: "K", value: Redacted.make("k") },
            ],
          ],
          [props.url, expect.anything(), [{ name: "N" }]],
        ]);
        expect(mock.state.variables).toEqual({ K: Redacted.make("k") });
      });
    },
  );
}
