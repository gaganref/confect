// A separate file, since a non-configurable replacement of a global cannot be
// undone, and Vitest gives each file its own globals.
import { describe, expect, it } from "@effect/vitest";
import {
  defineSchema,
  makeFunctionReference,
  queryGeneric,
} from "convex/server";
import * as Effect from "effect/Effect";
import { convexTest } from "../src/internal/ConvexTest";

const ping = makeFunctionReference<"query">("io:ping");

const modules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "io.ts": () =>
    Promise.resolve({
      ping: queryGeneric({ args: {}, handler: () => "pong" }),
    }),
};

describe("I/O bans", () => {
  it.effect(
    "a global a test replaced with a non-configurable property refuses the function, naming it",
    () =>
      Effect.gen(function* () {
        const t = convexTest(defineSchema({}), modules);
        expect(yield* Effect.promise(() => t.query(ping, {}))).toBe("pong");
        Object.defineProperty(globalThis, "setInterval", {
          value: () => 0,
          writable: true,
          configurable: false,
        });
        const outcome = yield* Effect.promise(() =>
          t.query(ping, {}).then(
            (value: unknown) => ({ returned: value }),
            (error: {
              readonly _tag?: string;
              readonly reason?: string;
              readonly names?: unknown;
            }) => ({
              failed: error._tag,
              reason: error.reason,
              names: error.names,
            }),
          ),
        );
        expect(outcome).toEqual({
          failed: "UnguardableGlobal",
          reason: "notConfigurable",
          names: ["setInterval"],
        });
      }),
  );
});
