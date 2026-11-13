// oxlint-disable effecttsgo/async-function, effecttsgo/global-date -- The fixtures are plain Convex functions, which are async and read the pinned `Date` as product code does.
// oxlint-disable-next-line effecttsgo/node-builtin-import -- A forged snapshot needs the SHA-256 its header names.
import { createHash } from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import {
  componentsGeneric,
  createFunctionHandle,
  defineSchema,
  defineTable,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
  type FunctionHandle,
  type FunctionReference,
} from "convex/server";
import { v, type GenericId } from "convex/values";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { convexTest, type KernelControls } from "../src/internal/ConvexTest";
import * as Invocation from "../src/internal/Invocation";

const start = 1_767_225_600_000;

/**
 * The driver's choices: the time the runtime answers, set by each step, and
 * commit timestamps derived from the version. Two drivers making the same
 * choices answer the same.
 */
const driver = () => {
  let now = start;
  return {
    set: (ms: number) => {
      now = start + ms;
    },
    runtime: {
      now: () => now,
      commitTs: (version: number) =>
        1_767_225_600_000_000_000n + BigInt(version) * 1_000n,
    },
  };
};

type Driver = ReturnType<typeof driver>;
type Note = GenericId<"notes">;

const app = {
  insert: makeFunctionReference<"mutation", { text: string }, Note>(
    "app:insert",
  ),
  insertTwice: makeFunctionReference<"mutation", { text: string }>(
    "app:insertTwice",
  ),
  rename: makeFunctionReference<"mutation", { id: Note; text: string }>(
    "app:rename",
  ),
  remove: makeFunctionReference<"mutation", { id: Note }>("app:remove"),
  stamp: makeFunctionReference<"mutation", { label: string }>("app:stamp"),
  mark: makeFunctionReference<"mutation", { label: string }>("app:mark"),
  scheduleMark: makeFunctionReference<
    "mutation",
    { label: string; ms: number }
  >("app:scheduleMark"),
  storeHandle: makeFunctionReference<"mutation">("app:storeHandle"),
  callStored: makeFunctionReference<"mutation", { text: string }>(
    "app:callStored",
  ),
  scheduleStored: makeFunctionReference<
    "mutation",
    { text: string; ms: number }
  >("app:scheduleStored"),
  startTicking: makeFunctionReference<"mutation">("app:startTicking"),
  dump: makeFunctionReference<"query", {}, Record<string, unknown>>("app:dump"),
};

const store = (componentsGeneric() as any).store as {
  readonly rows: {
    readonly add: FunctionReference<"mutation", "internal", { text: string }>;
    readonly tick: FunctionReference<"mutation", "internal">;
    readonly list: FunctionReference<"query", "internal", {}, Array<string>>;
  };
};

const hostSchema = defineSchema({
  notes: defineTable({
    text: v.string(),
    count: v.int64(),
    raw: v.bytes(),
    extra: v.any(),
  }),
  stamps: defineTable({ label: v.string(), at: v.commitTs() }),
  marks: defineTable({
    label: v.string(),
    world: v.union(v.string(), v.null()),
    at: v.number(),
  }),
  handles: defineTable({ handle: v.string() }),
});

const hostModules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "app.ts": () =>
    Promise.resolve({
      insert: mutationGeneric({
        args: { text: v.string() },
        handler: (ctx, { text }) =>
          ctx.db.insert("notes", {
            text,
            count: 2n ** 60n + 7n,
            raw: new Uint8Array([0, 1, 254, 255]).buffer,
            extra: {
              special: [Number.NaN, -0, Number.POSITIVE_INFINITY, 0.1],
              nested: { z: 1, a: [null, true, "é"] },
            },
          }),
      }),
      insertTwice: mutationGeneric({
        args: { text: v.string() },
        handler: async (ctx, { text }) => {
          const extra = {};
          const raw = new ArrayBuffer(0);
          await ctx.db.insert("notes", { text, count: 0n, raw, extra });
          await ctx.db.insert("notes", { text, count: 1n, raw, extra });
          return null;
        },
      }),
      rename: mutationGeneric({
        args: { id: v.id("notes"), text: v.string() },
        handler: async (ctx, { id, text }) => {
          const note = await ctx.db.get(id);
          await ctx.db.patch(id, { text, count: note!.count + 1n });
          return null;
        },
      }),
      remove: mutationGeneric({
        args: { id: v.id("notes") },
        handler: (ctx, { id }) => ctx.db.delete(id),
      }),
      stamp: mutationGeneric({
        args: { label: v.string() },
        handler: (ctx, { label }) =>
          ctx.db.insert("stamps", { label, at: ctx.db.vars.commitTs }),
      }),
      mark: mutationGeneric({
        args: { label: v.string() },
        handler: (ctx, { label }) =>
          ctx.db.insert("marks", {
            label,
            world: Invocation.current()?.world.name ?? null,
            at: Date.now(),
          }),
      }),
      scheduleMark: mutationGeneric({
        args: { label: v.string(), ms: v.number() },
        handler: (ctx, { label, ms }) =>
          ctx.scheduler.runAfter(ms, app.mark, { label }),
      }),
      storeHandle: mutationGeneric({
        args: {},
        handler: async (ctx) => {
          const handle = await createFunctionHandle(store.rows.add);
          return ctx.db.insert("handles", { handle });
        },
      }),
      callStored: mutationGeneric({
        args: { text: v.string() },
        handler: async (ctx, { text }) => {
          const row = await ctx.db.query("handles").first();
          await ctx.runMutation(row!.handle as FunctionHandle<"mutation">, {
            text,
          });
          return null;
        },
      }),
      scheduleStored: mutationGeneric({
        args: { text: v.string(), ms: v.number() },
        handler: async (ctx, { text, ms }) => {
          const row = await ctx.db.query("handles").first();
          await ctx.scheduler.runAfter(
            ms,
            row!.handle as FunctionHandle<"mutation">,
            { text },
          );
          return null;
        },
      }),
      startTicking: mutationGeneric({
        args: {},
        handler: (ctx) => ctx.runMutation(store.rows.tick, {}),
      }),
      dump: queryGeneric({
        args: {},
        handler: async (ctx) => ({
          notes: await ctx.db.query("notes").collect(),
          stamps: await ctx.db.query("stamps").collect(),
          marks: await ctx.db.query("marks").collect(),
          handles: await ctx.db.query("handles").collect(),
          store: await ctx.runQuery(store.rows.list, {}),
        }),
      }),
    }),
};

const tick = makeFunctionReference<"mutation">("rows:tick");

// A component whose `tick` schedules its own next run, as the crons
// component's rescheduler does, so its kit declares it standing.
const storeModules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "rows.ts": () =>
    Promise.resolve({
      add: mutationGeneric({
        args: { text: v.string() },
        handler: (ctx, { text }) => ctx.db.insert("items", { text }),
      }),
      tick: mutationGeneric({
        args: {},
        handler: async (ctx) => {
          await ctx.db.insert("items", { text: "tick" });
          await ctx.scheduler.runAfter(1000, tick, {});
          return null;
        },
      }),
      list: queryGeneric({
        args: {},
        handler: (ctx) =>
          ctx.db
            .query("items")
            .collect()
            .then((items) => items.map((item) => item.text)),
      }),
    }),
};
const storeSchema = defineSchema({ items: defineTable({ text: v.string() }) });

const backend = (
  d: Driver,
  components: ReadonlyArray<string> = ["store"],
): KernelControls => {
  const t = convexTest({
    schema: hostSchema,
    modules: hostModules,
    runtime: d.runtime,
  });
  for (const path of components) {
    t.registerComponent(path, storeSchema, storeModules, {
      standing: ["rows:tick"],
    });
  }
  return t;
};

const mail: Invocation.World = {
  name: "mail",
  services: Context.empty(),
  clock: () => start,
  random: () => 0.5,
};

const underMail = <A>(run: () => Promise<A>) =>
  Invocation.bind(
    Invocation.fresh(mail, "", {
      ip: null,
      userAgent: null,
      requestId: "mail-request",
      scheduledFunctionId: null,
    }),
    run,
  );

const call = <A>(thunk: () => Promise<A>) => Effect.promise(thunk);
const failure = (thunk: () => Promise<unknown>) =>
  call(() =>
    thunk().then(
      () => null,
      (error: unknown) => error,
    ),
  );
const thrown = (run: () => unknown): unknown => {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
};

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const bytesOf = (value: string) => new TextEncoder().encode(value);

/**
 * The history before a snapshot: rows of every value kind, a patch and a
 * delete, a stamped commit, a stored handle, a job bound to a test world, a job
 * through the stored handle, a standing job and an advanced clock.
 */
const before = (t: KernelControls, d: Driver) =>
  Effect.gen(function* () {
    d.set(0);
    const kept = yield* call(() => t.mutation(app.insert, { text: "kept" }));
    const gone = yield* call(() => t.mutation(app.insert, { text: "gone" }));
    d.set(10);
    yield* call(() => t.mutation(app.rename, { id: kept, text: "renamed" }));
    yield* call(() => t.mutation(app.remove, { id: gone }));
    yield* call(() => t.mutation(app.stamp, { label: "before" }));
    yield* call(() => t.mutation(app.storeHandle, {}));
    yield* call(() =>
      underMail(() =>
        t.mutation(app.scheduleMark, { label: "mailed", ms: 500 }),
      ),
    );
    yield* call(() => t.mutation(app.scheduleMark, { label: "plain", ms: 50 }));
    yield* call(() =>
      t.mutation(app.scheduleStored, { text: "through handle", ms: 300 }),
    );
    yield* call(() => t.mutation(app.startTicking, {}));
    yield* call(() => t.advance(20));
    return kept;
  });

/**
 * The history after a snapshot, from the same driver choices: new documents,
 * two in one start time, a lost update retried, every pending job run, the
 * standing job left alone by the drain and run by `advance`.
 */
const after = (t: KernelControls, d: Driver, kept: Note) =>
  Effect.gen(function* () {
    d.set(40);
    const fresh = yield* call(() => t.mutation(app.insert, { text: "fresh" }));
    yield* call(() => t.mutation(app.insertTwice, { text: "twice" }));
    const first = yield* call(() =>
      t.prepare(app.rename, { id: kept, text: "first" }),
    );
    const second = yield* call(() =>
      t.prepare(app.rename, { id: kept, text: "second" }),
    );
    const applied = yield* call(() => t.apply(second.id));
    const conflict = yield* call(() => t.apply(first.id));
    if (conflict.kind !== "conflict") throw new Error("expected a conflict");
    const retried = yield* call(() => t.apply(conflict.next.id));
    yield* call(() => t.mutation(app.callStored, { text: "called" }));
    yield* call(() => t.finishAllScheduledFunctions());
    const pending = t.jobs();
    yield* call(() => t.advance(1000));
    yield* call(() => t.mutation(app.stamp, { label: "after" }));
    const dump = yield* call(() => t.query(app.dump, {}));
    return {
      ids: [fresh, first.id, second.id, conflict.next.id],
      steps: [applied.kind, conflict.kind, retried.kind],
      pending,
      dump,
    };
  });

describe("snapshot export", () => {
  it.effect(
    "two exports of one state are the same bytes, a second backend given the same choices exports them too, and a restored backend exports them again",
    () =>
      Effect.gen(function* () {
        const d = driver();
        const t = backend(d);
        yield* before(t, d);
        const exported = t.exportSnapshot();
        expect(text(t.exportSnapshot())).toBe(text(exported));

        const twin = driver();
        const u = backend(twin);
        yield* before(u, twin);
        expect(text(u.exportSnapshot())).toBe(text(exported));

        const restored = backend(driver());
        yield* call(() =>
          restored.restoreSnapshot(exported, { worlds: [mail] }),
        );
        expect(text(restored.exportSnapshot())).toBe(text(exported));
        expect(yield* call(() => restored.query(app.dump, {}))).toEqual(
          yield* call(() => t.query(app.dump, {})),
        );
      }),
  );

  it.effect(
    "a backend holding an attempt refuses to export, since a snapshot carries no held attempt",
    () =>
      Effect.gen(function* () {
        const d = driver();
        const t = backend(d);
        const kept = yield* before(t, d);
        const held = yield* call(() =>
          t.prepare(app.rename, { id: kept, text: "held" }),
        );
        expect(thrown(() => t.exportSnapshot())).toMatchObject({
          _tag: "SnapshotWorldBusy",
          held: [held.id],
        });
      }),
  );
});

describe("snapshot restore", () => {
  it.effect(
    "replaying the same driver choices after a restore reaches the bytes of the run that never stopped",
    () =>
      Effect.gen(function* () {
        const d = driver();
        const t = backend(d);
        const kept = yield* before(t, d);
        const snapshot = t.exportSnapshot();
        const straight = yield* after(t, d, kept);

        const r = driver();
        r.set(20);
        const restored = backend(r);
        yield* call(() =>
          restored.restoreSnapshot(snapshot, { worlds: [mail] }),
        );
        const replayed = yield* after(restored, r, kept);

        expect(replayed).toEqual(straight);
        expect(text(restored.exportSnapshot())).toBe(text(t.exportSnapshot()));
      }),
  );

  it.effect(
    "a handle stored in a row resolves after a restore to the function at its component path",
    () =>
      Effect.gen(function* () {
        const d = driver();
        const t = backend(d);
        yield* call(() => t.mutation(app.storeHandle, {}));
        const restored = backend(driver());
        yield* call(() => restored.restoreSnapshot(t.exportSnapshot()));
        yield* call(() =>
          restored.mutation(app.callStored, { text: "after restore" }),
        );
        expect(yield* call(() => restored.query(store.rows.list, {}))).toEqual([
          "after restore",
        ]);
      }),
  );

  it.effect(
    "a restored job keeps its target, its world and its standing: a handle job runs in its component, a bound job under its world, and the drain leaves the standing job",
    () =>
      Effect.gen(function* () {
        const d = driver();
        const t = backend(d);
        yield* before(t, d);
        const restored = backend(driver());
        yield* call(() =>
          restored.restoreSnapshot(t.exportSnapshot(), { worlds: [mail] }),
        );
        yield* call(() => restored.finishAllScheduledFunctions());
        const dump = yield* call(() => restored.query(app.dump, {}));
        expect(dump["store"]).toEqual(["tick", "through handle"]);
        expect(
          (dump["marks"] as Array<{ label: string; world: string | null }>).map(
            ({ label, world }) => ({ label, world }),
          ),
        ).toEqual([
          { label: "plain", world: null },
          { label: "mailed", world: "mail" },
        ]);
        expect(restored.jobs()).toEqual([
          expect.objectContaining({
            componentPath: "store",
            name: "rows:tick",
            standing: true,
          }),
        ]);
      }),
  );

  it.effect.each<{
    readonly name: string;
    readonly tamper: (snapshot: string) => string;
  }>([
    {
      name: "a changed value",
      tamper: (snapshot) =>
        snapshot.replace('"text":"renamed"', '"text":"Renamed"'),
    },
    {
      name: "a changed digest",
      tamper: (snapshot) =>
        snapshot.replace(/sha256:[0-9a-f]/, (match) =>
          match.endsWith("0")
            ? `${match.slice(0, -1)}1`
            : `${match.slice(0, -1)}0`,
        ),
    },
    { name: "a cut body", tamper: (snapshot) => snapshot.slice(0, -1) },
  ])(
    "a snapshot with $name refuses with SnapshotDigestMismatch and leaves the backend as it was",
    ({ tamper }) =>
      Effect.gen(function* () {
        const d = driver();
        const t = backend(d);
        yield* before(t, d);
        const original = text(t.exportSnapshot());
        const tampered = tamper(original);
        expect(tampered).not.toBe(original);
        const restored = backend(driver());
        expect(
          yield* failure(() => restored.restoreSnapshot(bytesOf(tampered))),
        ).toMatchObject({ _tag: "SnapshotDigestMismatch" });
        expect(yield* call(() => restored.query(app.dump, {}))).toEqual({
          notes: [],
          stamps: [],
          marks: [],
          handles: [],
          store: [],
        });
        expect(restored.jobs()).toEqual([]);
      }),
  );

  it.effect(
    "bytes that are no snapshot, or whose body is not one under a matching digest, refuse with SnapshotMalformed",
    () =>
      Effect.gen(function* () {
        const restored = backend(driver());
        expect(
          yield* failure(() => restored.restoreSnapshot(bytesOf("{}"))),
        ).toMatchObject({ _tag: "SnapshotMalformed", reason: "header" });
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- The forged body is raw bytes, as a tampering writer would make them.
        const body = JSON.stringify({ components: [""], version: "one" });
        const forged = `confect-kernel-snapshot 1 sha256:${createHash("sha256")
          .update(body)
          .digest("hex")}\n${body}`;
        expect(
          yield* failure(() => restored.restoreSnapshot(bytesOf(forged))),
        ).toMatchObject({ _tag: "SnapshotMalformed", reason: "shape" });
      }),
  );

  it.effect(
    "a backend that committed, registers other components, or lacks a job's world refuses the restore",
    () =>
      Effect.gen(function* () {
        const d = driver();
        const t = backend(d);
        yield* before(t, d);
        const snapshot = t.exportSnapshot();

        const used = backend(driver());
        yield* call(() => used.mutation(app.insert, { text: "own" }));
        expect(
          yield* failure(() =>
            used.restoreSnapshot(snapshot, { worlds: [mail] }),
          ),
        ).toMatchObject({ _tag: "SnapshotWorldBusy", version: 1 });

        const other = backend(driver(), ["store", "extra"]);
        expect(
          yield* failure(() =>
            other.restoreSnapshot(snapshot, { worlds: [mail] }),
          ),
        ).toMatchObject({
          _tag: "SnapshotComponentMismatch",
          snapshot: ["", "store"],
          registered: ["", "extra", "store"],
        });

        const worldless = backend(driver());
        expect(
          yield* failure(() => worldless.restoreSnapshot(snapshot)),
        ).toMatchObject({
          _tag: "SnapshotWorldUnresolved",
          name: "mail",
          reason: "missing",
        });
        expect(worldless.jobs()).toEqual([]);
      }),
  );
});
