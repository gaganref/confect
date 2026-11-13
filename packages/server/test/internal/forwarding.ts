import { convexToJson, jsonToConvex, type Value } from "convex/values";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FunctionSpec, Ref, type RuntimeAndFunctionType } from "@confect/core";
import * as Schema from "effect/Schema";
import type * as Tracer from "effect/Tracer";

export const profile = FunctionSpec.extend()({
  middleware: [],
  reservedArgument: "context",
});
export const options = {
  name: "echo",
  args: () => ({ count: Schema.FiniteFromString }),
  returns: () => Schema.Unknown,
};
export const echo = (_ref: unknown, args?: unknown, _options?: unknown) =>
  Promise.resolve(jsonToConvex(convexToJson(args as Value)));
export const cases = [
  { label: "a function value", forward: () => () => 1, enabled: false },
  { label: "a class instance", forward: () => new Map(), enabled: false },
  {
    label: "a boundary value",
    forward: (span: Tracer.Span) => ({ boundary: span.name }),
    enabled: true,
  },
  { label: "an omitted value", forward: () => undefined, enabled: false },
  { label: "no provider", forward: undefined, enabled: false },
  {
    label: "a throwing provider",
    forward: () => {
      throw new Error("fixture provider failure");
    },
    enabled: false,
  },
];

type FixtureRef<T extends "mutation" | "action"> = Ref.Ref<
  Extract<RuntimeAndFunctionType.RuntimeAndFunctionType, { functionType: T }>,
  "public",
  { count: number },
  unknown
>;
export const mutations: readonly [
  FixtureRef<"mutation">,
  FixtureRef<"mutation">,
] = [
  Ref.make("items", profile.publicMutation(options)),
  Ref.make("items", FunctionSpec.publicMutation(options)),
] as const;
export const actions: readonly [FixtureRef<"action">, FixtureRef<"action">] = [
  Ref.make("items", profile.publicAction(options)),
  Ref.make("items", FunctionSpec.publicAction(options)),
] as const;
export const check = <Target extends Ref.Any, E, R>(
  targets: ReadonlyArray<Target>,
  run: (ref: Target, args: Ref.Args<Target>) => Effect.Effect<unknown, E, R>,
  boundary: string,
  enabled: boolean,
) =>
  Effect.gen(function* () {
    for (const [index, target] of targets.entries()) {
      const runResult = yield* run(target, { count: 1 } as Ref.Args<Target>);
      expect(runResult).toEqual({
        count: "1",
        ...(enabled && index === 0 ? { context: { boundary } } : {}),
      });
    }
  });
