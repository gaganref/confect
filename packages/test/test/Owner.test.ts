// A separate file, since it reloads this package's module graph many times, and
// Vitest gives each file its own globals and module registry.
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import {
  actionGeneric,
  defineSchema,
  defineTable,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as V8 from "node:v8";
import * as Vm from "node:vm";
import type * as ConvexTestModule from "../src/internal/ConvexTest";
import type * as EgressModule from "../src/internal/Egress";
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

  // A reloaded copy that a test still uses can run, so it keeps every
  // registration through collection. It installed none of the process-wide
  // hooks, which close over the first copy only, so nothing but its own module
  // holds what it registered.
  it.live(
    "a reloaded copy still in use, which installed none of the hooks, keeps every registration across collection: its guards, time, environment, database and held port calls",
    () =>
      Effect.gen(function* () {
        // This file's own copy installs the process-wide hooks first.
        const first = yield* Effect.promise(() => ran(convexTest));
        expect(first).toEqual(answered);
        const copy = yield* Effect.promise(loaded);
        const t = keptBackend(copy);
        const before = yield* probeKept(t, "before");
        const dropped: Array<WeakRef<object>> = [];
        for (let index = 0; index < 10; index++) {
          const other = yield* Effect.promise(reloaded);
          dropped.push(other);
        }
        const alive = yield* collect(dropped);
        expect(alive).toBeLessThanOrEqual(1);
        const after = yield* probeKept(t, "after");
        const seen = { now: keptTime, who: "kept" };
        expect(before).toEqual({
          seen,
          rows: ["before"],
          guarded: "undefined",
          charged: { held: 1, result: "kept answered" },
        });
        expect(after).toEqual({
          seen,
          rows: ["before", "after"],
          guarded: "undefined",
          charged: { held: 1, result: "kept answered" },
        });
      }),
    60_000,
  );
});

/**
 * A fresh module graph of this package, kept: its kernel and its provider
 * ports.
 */
const loaded = () => {
  vi.resetModules();
  return Promise.all([
    import("../src/internal/ConvexTest") as Promise<typeof ConvexTestModule>,
    import("../src/internal/Egress") as Promise<typeof EgressModule>,
  ]).then(([module, egress]) => ({
    convexTest: module.convexTest,
    port: egress.port,
  }));
};

// The kept copy's clock, so a query tells it reads that copy's pin.
const keptTime = 1_767_225_600_000;

const kept = {
  seen: makeFunctionReference<
    "query",
    {},
    { readonly now: number; readonly who: string | null }
  >("kept:seen"),
  write: makeFunctionReference<"mutation", { label: string }, null>(
    "kept:write",
  ),
  rows: makeFunctionReference<"query", {}, Array<string>>("kept:rows"),
  guarded: makeFunctionReference<"action", {}, string>("kept:guarded"),
  charge: makeFunctionReference<"action", {}, string>("kept:charge"),
};

type KeptBackend = ConvexTestModule.KernelControls & {
  readonly setEnvironment: (
    componentPath: string,
    env: Readonly<Record<string, string>>,
  ) => void;
};

/**
 * A backend on `copy`, on its own clock and environment, whose functions read
 * the time and `WHO`, write and read through the database, read an isolate
 * global the guards hide, and call a provider port of `copy`'s.
 */
const keptBackend = (copy: Awaited<ReturnType<typeof loaded>>) => {
  const charges = copy.port<{}, string>("charges", () =>
    Promise.reject(new Error("the live provider ran")),
  );
  const keptModules = {
    "_generated/server.ts": () => Promise.resolve({}),
    "kept.ts": () =>
      Promise.resolve({
        seen: queryGeneric({
          args: {},
          handler: () =>
            Promise.resolve({
              // oxlint-disable-next-line effecttsgo/global-date -- The case reads the time the kept copy pins its query to.
              now: Date.now(),
              // oxlint-disable-next-line effecttsgo/process-env -- The case reads the environment the kept copy scopes to its component.
              who: process.env["WHO"] ?? null,
            }),
        }),
        write: mutationGeneric({
          args: { label: v.string() },
          handler: ({ db }, { label }) =>
            db.insert("notes", { label }).then(() => null),
        }),
        rows: queryGeneric({
          args: {},
          handler: ({ db }) =>
            db
              .query("notes")
              .collect()
              .then(Arr.map((row) => row.label)),
        }),
        guarded: actionGeneric({
          args: {},
          handler: () => Promise.resolve(typeof setImmediate),
        }),
        charge: actionGeneric({
          args: {},
          handler: () => charges.call({}),
        }),
      }),
  };
  const t = copy.convexTest({
    schema: defineSchema({ notes: defineTable({ label: v.string() }) }),
    modules: keptModules,
    sources: inlineSources(keptModules),
    runtime: {
      now: () => keptTime,
      commitTs: (version: number) =>
        BigInt(keptTime) * 1_000_000n + BigInt(version),
    },
  }) as KeptBackend;
  t.setEnvironment("", { WHO: "kept" });
  return t;
};

/**
 * What the kept backend's functions answer, after writing `label`: its port
 * call is held as one command, which the probe answers.
 */
const probeKept = (t: KeptBackend, label: string) =>
  Effect.gen(function* () {
    const seen = yield* Effect.promise(() => t.query(kept.seen, {}));
    yield* Effect.promise(() => t.mutation(kept.write, { label }));
    const rows = yield* Effect.promise(() => t.query(kept.rows, {}));
    const guarded = yield* Effect.promise(() => t.action(kept.guarded, {}));
    const charging = t.action(kept.charge, {}).then(
      (value: string) => value,
      (error: Error) => `failed: ${error.message}`,
    );
    let held = t.commands();
    for (let round = 0; round < 100 && held.length === 0; round++) {
      yield* Effect.sleep("5 millis");
      held = t.commands();
    }
    for (const command of held) t.answer(command.id, "kept answered");
    const result = yield* Effect.promise(() => charging);
    return { seen, rows, guarded, charged: { held: held.length, result } };
  });
