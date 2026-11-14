// A configurable `Math` whose getter throws, left before a query runs. The
// kernel must refuse with a tagged UnguardableGlobal, building the refusal
// without touching the ambient `Math`. The fixture itself uses no Effect, whose
// runtime would read `Math` too. Printed as bytes. `Randomness.test.ts` runs
// this in a process of its own.
import {
  defineSchema,
  makeFunctionReference,
  queryGeneric,
} from "convex/server";
import { convexTest } from "../../src/internal/ConvexTest";
import * as DriverWorld from "../../src/internal/DriverWorld";
import * as Json from "../../src/internal/Json";

const seen = { loaded: false, ran: false };

const t = convexTest({
  schema: defineSchema({}),
  world: DriverWorld.make("throwing math", 0),
  modules: {
    "_generated/server.ts": () => Promise.resolve({}),
    "draws.ts": () => {
      seen.loaded = true;
      return Promise.resolve({
        read: queryGeneric({
          args: {},
          handler: () => {
            seen.ran = true;
            return Promise.resolve(null);
          },
        }),
      });
    },
  },
});

Object.defineProperty(globalThis, "Math", {
  get: () => {
    throw new TypeError("Math getter fails");
  },
  configurable: true,
});

void t.query(makeFunctionReference<"query">("draws:read"), {}).then(
  (value: unknown) =>
    process.stdout.write(Json.stringify({ outcome: "ran", value, ...seen })),
  (error: unknown) => {
    const { _tag, reason, globals, message } = error as Record<string, unknown>;
    return process.stdout.write(
      Json.stringify({
        outcome: "refused",
        _tag: _tag ?? null,
        reason: reason ?? null,
        globals: globals ?? null,
        message,
        ...seen,
      }),
    );
  },
);
