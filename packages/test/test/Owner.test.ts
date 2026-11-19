// A separate file, since it reloads this package's module graph many times, and
// Vitest gives each file its own globals and module registry.
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import {
  actionGeneric,
  defineSchema,
  makeFunctionReference,
  queryGeneric,
} from "convex/server";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as V8 from "node:v8";
import * as Vm from "node:vm";
import type * as ConvexTestModule from "../src/internal/ConvexTest";
import type * as OwnerModule from "../src/internal/Owner";
import { convexTest } from "../src/internal/ConvexTest";
import { inlineSources } from "./fixtures/inlineSources";

// V8's `gc`, to observe which loaded copies the process still holds.
V8.setFlagsFromString("--expose-gc");
const gc = Vm.runInNewContext("gc") as () => void;

const refs = {
  ping: makeFunctionReference<"query", {}, string>("probe:ping"),
  guarded: makeFunctionReference<"action", {}, string>("probe:guarded"),
};

// What a backend's query and isolate action answer while its copy's
// registrations hold.
const answered = ["pong", "pong|undefined"];

const modules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "probe.ts": () =>
    Promise.resolve({
      ping: queryGeneric({ args: {}, handler: () => Promise.resolve("pong") }),
      // An isolate action, whose `setImmediate` the I/O guards hide while its
      // copy's registration answers.
      guarded: actionGeneric({
        args: {},
        handler: (ctx) =>
          ctx
            .runQuery(refs.ping, {})
            .then((ping) => `${ping}|${typeof setImmediate}`),
      }),
    }),
};

/**
 * A backend on `open`, which registers its copy's hooks, and what its query and
 * its isolate action answer.
 */
const ran = (open: typeof ConvexTestModule.convexTest) => {
  const t = open({
    schema: defineSchema({}),
    modules,
    sources: inlineSources(modules),
  });
  return t
    .query(refs.ping, {})
    .then((ping: string) =>
      t.action(refs.guarded, {}).then((guarded: string) => [ping, guarded]),
    );
};

/**
 * A fresh module graph of this package, as Vitest's watch mode or a test that
 * resets its modules loads: this copy's `Owner.self`, held weakly, once a
 * backend on the copy ran.
 */
const reloaded = (): Promise<WeakRef<object>> => {
  vi.resetModules();
  return Promise.all([
    import("../src/internal/Owner") as Promise<typeof OwnerModule>,
    import("../src/internal/ConvexTest") as Promise<typeof ConvexTestModule>,
  ]).then(([owner, module]) =>
    ran(module.convexTest).then((answers: ReadonlyArray<string>) => {
      expect(answers).toEqual(answered);
      return new WeakRef(owner.self);
    }),
  );
};

/**
 * How many of `held` are still alive.
 */
const live = (held: ReadonlyArray<WeakRef<object>>): number =>
  Arr.filter(held, (ref) => ref.deref() !== undefined).length;

/**
 * Collect garbage a few event-loop turns apart, since a weak reference read in
 * one turn holds its target until the turn ends, until none of `held` is left
 * or the count stops falling: how many are still alive.
 */
const collect = (held: ReadonlyArray<WeakRef<object>>) =>
  Effect.gen(function* () {
    let last = held.length;
    for (let round = 0; round < 10; round++) {
      yield* Effect.sleep("10 millis");
      gc();
      const now = live(held);
      if (now === 0 || (now === last && round >= 4)) return now;
      last = now;
    }
    return last;
  });

describe("loaded copies", () => {
  // Each loaded copy registers its hooks in the process-wide registries (the
  // I/O guards, `globalThis.Convex`, the `Date` wrapper, the port holder and
  // `process.env`). A copy whose module graph no code reaches any more can run
  // no session, so its registrations must not keep it alive (#212).
  it.live(
    "the registries release each reloaded copy that nothing reaches, and the copies still loaded keep answering",
    () =>
      Effect.gen(function* () {
        // This file's own copy installs the process-wide hooks first.
        const first = yield* Effect.promise(() => ran(convexTest));
        expect(first).toEqual(answered);
        const reloads = 30;
        const held: Array<WeakRef<object>> = [];
        for (let index = 0; index < reloads; index++) {
          const copy = yield* Effect.promise(reloaded);
          held.push(copy);
        }
        const alive = yield* collect(held);
        // The last reload stays in Vitest's module registry until the next.
        expect(alive).toBeLessThanOrEqual(1);
        const again = yield* Effect.promise(() => ran(convexTest));
        expect(again).toEqual(answered);
      }),
    60_000,
  );
});
