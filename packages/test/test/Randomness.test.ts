import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import refs from "../../../tools/local-backend/fixtures/confect/_generated/refs";
import * as Invocation from "../src/internal/Invocation";
import { call, localBackendWorld } from "./fixtures/localBackendWorld";
import { expected, normalize } from "./fixtures/randomnessProbe";

const probe = refs.public.groups.randomness;

/**
 * A random stream that cycles through `draws`.
 */
const cycling = (draws: ReadonlyArray<number>) => {
  let next = 0;
  return () => draws[next++ % draws.length]!;
};

const draws = [0.125, 0.25, 0.5, 0.75, 0.875];

/**
 * Run `kind`'s probe under a test invocation whose random stream starts at the
 * first of `draws`.
 */
const sample = (kind: "query" | "mutation" | "action") =>
  Effect.gen(function* () {
    const t = localBackendWorld();
    const random = cycling(draws);
    const world: Invocation.World = {
      name: "randomness",
      services: Context.empty(),
      clock: () => 1_000,
      random,
    };
    const invocation: Invocation.Invocation = {
      world,
      componentPath: "",
      attempt: 1,
      request: {
        ip: null,
        userAgent: null,
        requestId: "0000000000000000",
        scheduledFunctionId: null,
      },
      services: Context.empty(),
      startedAt: 1_000,
      random,
    };
    return yield* Effect.promise(() =>
      Invocation.bind(invocation, () =>
        Effect.runPromise(call(t, kind, probe[kind])),
      ),
    );
  });

describe("randomness on the kernel", () => {
  it.effect(
    "a query, a mutation and an action may each draw from Math.random and crypto, and refuse the fills the binary refuses",
    () =>
      Effect.gen(function* () {
        expect({
          query: normalize(yield* sample("query")),
          mutation: normalize(yield* sample("mutation")),
          action: normalize(yield* sample("action")),
        }).toEqual(expected);
      }),
  );

  it.effect(
    "Math.random and crypto.getRandomValues draw from the supplied stream in a query, a mutation and an action",
    () =>
      Effect.gen(function* () {
        for (const kind of ["query", "mutation", "action"] as const) {
          const { mathRandom, getRandomValues } = yield* sample(kind);
          expect([mathRandom.value, getRandomValues.value], kind).toEqual([
            [0.125],
            [64, 128, 192, 224],
          ]);
        }
      }),
  );
});
