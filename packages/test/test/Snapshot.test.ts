// oxlint-disable effecttsgo/async-function, effecttsgo/global-date -- The fixtures are plain Convex functions, which are async and read the pinned `Date` as product code does.
import * as Option from "effect/Option";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- A forged snapshot needs the SHA-256 its header names.
import { createHash } from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import {
  actionGeneric,
  componentsGeneric,
  createFunctionHandle,
  cronJobs,
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
import * as Execution from "../src/internal/Execution";
import * as Invocation from "../src/internal/Invocation";
import * as Egress from "../src/internal/Egress";
import * as Snapshot from "../src/internal/Snapshot";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as String from "effect/String";
import { pipe } from "effect/Function";
import * as Schema from "effect/Schema";
import * as Json from "../src/internal/Json";

const UnknownJson = Schema.fromJsonString(Schema.Unknown);
import { inlineSources } from "./fixtures/inlineSources";

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
  waitGate: makeFunctionReference<"action">("app:waitGate"),
  detach: makeFunctionReference<"action">("app:detach"),
  gatedInsert: makeFunctionReference<"mutation">("app:gatedInsert"),
  scheduleGate: makeFunctionReference<"mutation">("app:scheduleGate"),
  whoami: makeFunctionReference<"query", {}, string | null>("app:whoami"),
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
      waitGate: actionGeneric({
        args: {},
        handler: async (ctx) => {
          reached.release();
          await gate.promise;
          await ctx.runMutation(app.insert, { text: "gated" });
          return null;
        },
      }),
      detach: actionGeneric({
        args: {},
        handler: async (ctx) => {
          // The child is left running: the action returns without it.
          void ctx.runMutation(app.gatedInsert, {});
          return null;
        },
      }),
      gatedInsert: mutationGeneric({
        args: {},
        handler: async (ctx) => {
          reached.release();
          await gate.promise;
          await ctx.db.insert("notes", {
            text: "detached",
            count: 0n,
            raw: new ArrayBuffer(0),
            extra: {},
          });
          return null;
        },
      }),
      scheduleGate: mutationGeneric({
        args: {},
        handler: (ctx) => ctx.scheduler.runAfter(0, app.waitGate, {}),
      }),
      whoami: queryGeneric({
        args: {},
        handler: (ctx) =>
          ctx.auth
            .getUserIdentity()
            .then((identity) => identity?.subject ?? null),
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
            .then((items) => Arr.map(items, (item) => item.text)),
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
    sources: inlineSources(hostModules),
    runtime: d.runtime,
  });
  for (const path of components) {
    t.registerComponent(path, storeSchema, storeModules, {
      standing: ["rows:tick"],
      sources: inlineSources(storeModules),
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

type Latch = { readonly promise: Promise<void>; readonly release: () => void };

const latch = (): Latch => {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, release: () => resolve() };
};

// The gated action waits on `gate` once it signals `reached`, so a test can
// act while it runs.
let gate = latch();
let reached = latch();

const call = <A>(thunk: () => Promise<A>) => Effect.promise(thunk);

/**
 * The backend's snapshot once its detached work has settled: a detached call
 * refuses the export until then.
 */
const settled = (t: KernelControls, turns = 1000): Promise<Uint8Array> =>
  Promise.resolve()
    .then(() => t.exportSnapshot())
    .catch((error: unknown) => {
      if (
        (error as { _tag?: string })._tag !== "SnapshotWorldRunning" ||
        turns === 0
      )
        throw error;
      const { promise, resolve } = Promise.withResolvers<void>();
      setImmediate(resolve);
      return promise.then(() => settled(t, turns - 1));
    });
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
    t.subscriber().authenticate({ subject: "before" });
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
    const subscriber = t.subscriber();
    yield* call(() => subscriber.subscribe(app.whoami, {}));
    subscriber.authenticate({ subject: "after" });
    const transitions = yield* call(() => t.refresh());
    return {
      ids: [fresh, first.id, second.id, conflict.next.id],
      steps: [applied.kind, conflict.kind, retried.kind],
      pending,
      dump,
      identity: Arr.map(transitions, ({ because, from, to }) => ({
        because,
        from,
        to,
      })),
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
        const callResult = yield* call(() => restored.query(app.dump, {}));
        const callResult2 = yield* call(() => t.query(app.dump, {}));
        expect(callResult).toEqual(callResult2);
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
        const callResult = yield* call(() =>
          restored.query(store.rows.list, {}),
        );
        expect(callResult).toEqual(["after restore"]);
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
          Arr.map(
            dump["marks"] as Array<{ label: string; world: string | null }>,
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
        pipe(snapshot, String.replace('"text":"renamed"', '"text":"Renamed"')),
    },
    {
      name: "a changed digest",
      tamper: (snapshot) =>
        // oxlint-disable-next-line effecttsgo/prefer-effect-string -- This replace takes a callback, which effect/String.replace does not accept.
        snapshot.replace(/sha256:[0-9a-f]/, (match) =>
          pipe(match, String.endsWith("0"))
            ? `${pipe(match, String.slice(0, -1))}1`
            : `${pipe(match, String.slice(0, -1))}0`,
        ),
    },
    {
      name: "a cut body",
      tamper: (snapshot) => pipe(snapshot, String.slice(0, -1)),
    },
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
        const failureResult = yield* failure(() =>
          restored.restoreSnapshot(bytesOf(tampered)),
        );
        expect(failureResult).toMatchObject({ _tag: "SnapshotDigestMismatch" });
        const callResult = yield* call(() => restored.query(app.dump, {}));
        expect(callResult).toEqual({
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
        const failureResult = yield* failure(() =>
          restored.restoreSnapshot(bytesOf("{}")),
        );
        expect(failureResult).toMatchObject({
          _tag: "SnapshotMalformed",
          reason: "header",
        });
        const body = yield* Schema.encodeEffect(UnknownJson)({
          components: [""],
          version: "one",
        });
        const forged = `confect-kernel-snapshot 5 sha256:${createHash("sha256")
          .update(body)
          .digest("hex")}\n${body}`;
        const failureResult2 = yield* failure(() =>
          restored.restoreSnapshot(bytesOf(forged)),
        );
        expect(failureResult2).toMatchObject({
          _tag: "SnapshotMalformed",
          reason: "shape",
        });
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
        const failureResult = yield* failure(() =>
          used.restoreSnapshot(snapshot, { worlds: [mail] }),
        );
        expect(failureResult).toMatchObject({
          _tag: "SnapshotWorldBusy",
          version: 1,
        });

        const other = backend(driver(), ["store", "extra"]);
        const failureResult2 = yield* failure(() =>
          other.restoreSnapshot(snapshot, { worlds: [mail] }),
        );
        expect(failureResult2).toMatchObject({
          _tag: "SnapshotComponentMismatch",
          snapshot: ["", "store"],
          registered: ["", "extra", "store"],
        });

        const worldless = backend(driver());
        const failureResult3 = yield* failure(() =>
          worldless.restoreSnapshot(snapshot),
        );
        expect(failureResult3).toMatchObject({
          _tag: "SnapshotWorldUnresolved",
          worldName: "mail",
          reason: "missing",
        });
        expect(worldless.jobs()).toEqual([]);
      }),
  );
});

/**
 * `bytes` with its body edited and its digest recomputed, as a writer who
 * rehashes would make them.
 */
const rehash = (bytes: Uint8Array, edit: (body: any) => void): Uint8Array => {
  const snapshot = text(bytes);
  const bodyStart =
    pipe(
      snapshot,
      String.indexOf("\n"),
      Option.getOrElse(() => -1),
    ) + 1;
  const body = Json.parse(pipe(snapshot, String.slice(bodyStart)));
  edit(body);
  const edited = Json.stringify(body);
  return bytesOf(
    `confect-kernel-snapshot 5 sha256:${createHash("sha256")
      .update(edited)
      .digest("hex")}\n${edited}`,
  );
};

const table = (body: any, name: string) =>
  body.tables.find((entry: any) => entry.table === name);

const jobRow = (body: any, id: string) =>
  body.tables
    .flatMap((entry: any) => entry.rows)
    .find((row: any) => row.doc._id === id);

describe("snapshot consistency", () => {
  it.effect.each<{
    readonly name: string;
    readonly edit: (body: any) => void;
    readonly refusal: Record<string, unknown>;
  }>([
    {
      name: "a next document ID rewound onto an existing ID",
      edit: (body) => {
        body.identity.nextDocumentId = 10000;
      },
      refusal: {
        _tag: "SnapshotAllocatorBehind",
        allocator: "nextDocumentId",
      },
    },
    {
      name: "a latest creation time rewound",
      edit: (body) => {
        body.identity.lastCreationTime = 0;
      },
      refusal: {
        _tag: "SnapshotAllocatorBehind",
        allocator: "lastCreationTime",
      },
    },
    {
      name: "a next attempt ID of zero",
      edit: (body) => {
        body.identity.nextAttemptId = 0;
      },
      refusal: { _tag: "SnapshotAllocatorBehind", allocator: "nextAttemptId" },
    },
    {
      name: "a negative identity epoch",
      edit: (body) => {
        body.identity.identityEpoch = -1;
      },
      refusal: { _tag: "SnapshotAllocatorBehind", allocator: "identityEpoch" },
    },
    {
      name: "a next command ID of zero",
      edit: (body) => {
        body.identity.nextCommandId = 0;
      },
      refusal: { _tag: "SnapshotAllocatorBehind", allocator: "nextCommandId" },
    },
    {
      name: "a next command ID behind a cancelled command",
      edit: (body) => {
        body.cancelledCommands = ["command-5"];
        body.identity.nextCommandId = 2;
      },
      refusal: {
        _tag: "SnapshotAllocatorBehind",
        allocator: "nextCommandId",
        required: 6,
      },
    },
    {
      name: "a cancelled command the kernel never mints",
      edit: (body) => {
        body.cancelledCommands = ["charge-1"];
      },
      refusal: { _tag: "SnapshotMalformed", reason: "cancelledCommand" },
    },
    {
      name: "a row changed outside the write log",
      edit: (body) => {
        table(body, "notes").rows[0].doc.text = "forged";
      },
      refusal: { _tag: "SnapshotRowInconsistent", reason: "row" },
    },
    {
      name: "a row at a version the log never gave it",
      edit: (body) => {
        table(body, "notes").rows[0].version += 1;
      },
      refusal: { _tag: "SnapshotRowInconsistent", reason: "row" },
    },
    {
      name: "a row filed under another table",
      edit: (body) => {
        table(body, "notes").table = "misfiled";
      },
      refusal: { _tag: "SnapshotRowInconsistent", reason: "id" },
    },
    {
      name: "a row in a component the snapshot does not register",
      edit: (body) => {
        table(body, "notes").componentPath = "ghost";
      },
      refusal: { _tag: "SnapshotRowInconsistent", reason: "component" },
    },
    {
      name: "a row the log publishes but the snapshot drops",
      edit: (body) => {
        table(body, "handles").rows = [];
      },
      refusal: { _tag: "SnapshotRowInconsistent", reason: "row" },
    },
    {
      name: "a log change from a value the log never published",
      edit: (body) => {
        const change = body.log
          .flatMap((commit: any) => commit.changes)
          .find((c: any) => c.before !== null);
        change.before.text = "never";
      },
      refusal: { _tag: "SnapshotRowInconsistent", reason: "log" },
    },
    {
      name: "a row with no creation time",
      edit: (body) => {
        delete table(body, "notes").rows[0].doc._creationTime;
      },
      refusal: { _tag: "SnapshotRowInconsistent", reason: "systemFields" },
    },
    {
      name: "a row whose creation time is a string",
      edit: (body) => {
        table(body, "notes").rows[0].doc._creationTime = "1";
      },
      refusal: { _tag: "SnapshotRowInconsistent", reason: "systemFields" },
    },
    {
      name: "a row with a negative creation time",
      edit: (body) => {
        table(body, "notes").rows[0].doc._creationTime = -1;
      },
      refusal: { _tag: "SnapshotRowInconsistent", reason: "systemFields" },
    },
    {
      name: "a row whose ID is not a string",
      edit: (body) => {
        table(body, "notes").rows[0].doc._id = 7;
      },
      refusal: { _tag: "SnapshotRowInconsistent", reason: "systemFields" },
    },
    {
      name: "a logged document with no creation time",
      edit: (body) => {
        const logged = body.log
          .flatMap((commit: any) => commit.changes)
          .find((c: any) => c.after !== null);
        delete logged.after._creationTime;
      },
      refusal: { _tag: "SnapshotRowInconsistent", reason: "systemFields" },
    },
    {
      name: "a logged document under another ID",
      edit: (body) => {
        const logged = body.log
          .flatMap((commit: any) => commit.changes)
          .find((c: any) => c.after !== null);
        logged.id = table(body, "handles").rows[0].doc._id;
      },
      refusal: { _tag: "SnapshotRowInconsistent", reason: "systemFields" },
    },
    {
      name: "a table listed empty and then populated",
      edit: (body) => {
        body.tables.unshift({ componentPath: "", table: "notes", rows: [] });
      },
      refusal: { _tag: "SnapshotRowInconsistent", reason: "duplicate" },
    },
    {
      name: "a table listed populated and then empty",
      edit: (body) => {
        body.tables.push({ componentPath: "", table: "notes", rows: [] });
      },
      refusal: { _tag: "SnapshotRowInconsistent", reason: "duplicate" },
    },
    {
      name: "one ID stored in two tables",
      edit: (body) => {
        table(body, "stamps").rows.push(table(body, "notes").rows[0]);
      },
      refusal: { _tag: "SnapshotRowInconsistent", reason: "duplicate" },
    },
    {
      name: "a job listed twice",
      edit: (body) => {
        body.jobs.push(body.jobs[0]);
      },
      refusal: { _tag: "SnapshotJobInconsistent", reason: "duplicate" },
    },
    {
      name: "a component listed twice",
      edit: (body) => {
        body.components.push(body.components[0]);
      },
      refusal: { _tag: "SnapshotMalformed", reason: "duplicate" },
    },
    {
      name: "commit timestamps that do not increase",
      edit: (body) => {
        body.log[1].commitTs = body.log[0].commitTs;
      },
      refusal: { _tag: "SnapshotTimestampInconsistent" },
    },
    {
      name: "a latest commit timestamp that is not the log's last",
      edit: (body) => {
        body.commitTs = "1";
      },
      refusal: { _tag: "SnapshotTimestampInconsistent" },
    },
    {
      name: "a job with no job row",
      edit: (body) => {
        body.jobs[0].id = table(body, "notes").rows[0].doc._id;
      },
      refusal: { _tag: "SnapshotJobInconsistent", reason: "row" },
    },
    {
      name: "a job row with no job",
      edit: (body) => {
        body.jobs.pop();
      },
      refusal: { _tag: "SnapshotJobInconsistent", reason: "untargeted" },
    },
    {
      name: "a job left running",
      edit: (body) => {
        const { id } = body.jobs[0];
        jobRow(body, id).doc.state = { kind: "inProgress" };
        const last = body.log
          .flatMap((commit: any) => commit.changes)
          .findLast((c: any) => c.after?._id === id);
        last.after.state = { kind: "inProgress" };
      },
      refusal: { _tag: "SnapshotJobInconsistent", reason: "inProgress" },
    },
    {
      name: "a job targeting a component the snapshot does not register",
      edit: (body) => {
        body.jobs[0].target.componentPath = "ghost";
      },
      refusal: { _tag: "SnapshotJobInconsistent", reason: "component" },
    },
    {
      name: "a job targeting a function its component does not export",
      edit: (body) => {
        body.jobs[0].target.udfPath = "app:missing";
      },
      refusal: { _tag: "SnapshotJobInconsistent", reason: "function" },
    },
  ])(
    "a rehashed snapshot with $name refuses before anything is installed",
    ({ edit, refusal }) =>
      Effect.gen(function* () {
        const d = driver();
        const t = backend(d);
        yield* before(t, d);
        const snapshot = t.exportSnapshot();
        const control = backend(driver());
        yield* call(() =>
          control.restoreSnapshot(
            rehash(snapshot, () => {}),
            { worlds: [mail] },
          ),
        );
        const restored = backend(driver());
        const failureResult = yield* failure(() =>
          restored.restoreSnapshot(rehash(snapshot, edit), {
            worlds: [mail],
          }),
        );
        expect(failureResult).toMatchObject(refusal);
        expect(restored.jobs()).toEqual([]);
        expect(text(restored.exportSnapshot())).toBe(
          text(backend(driver()).exportSnapshot()),
        );
      }),
  );
});

describe("snapshot while running", () => {
  it.effect(
    "a backend running an action, or a scheduler walk running a job, refuses to export or restore until it settles",
    () =>
      Effect.gen(function* () {
        gate = latch();
        reached = latch();
        const t = backend(driver());
        const running = t.action(app.waitGate, {});
        yield* call(() => reached.promise);
        expect(thrown(() => t.exportSnapshot())).toMatchObject({
          _tag: "SnapshotWorldRunning",
          registry: "running",
          count: 1,
        });
        const snapshot = backend(driver()).exportSnapshot();
        const failureResult = yield* failure(() => t.restoreSnapshot(snapshot));
        expect(failureResult).toMatchObject({ _tag: "SnapshotWorldRunning" });
        gate.release();
        yield* call(() => running);

        gate = latch();
        reached = latch();
        yield* call(() => t.mutation(app.scheduleGate, {}));
        const walking = t.finishAllScheduledFunctions();
        yield* call(() => reached.promise);
        expect(thrown(() => t.exportSnapshot())).toMatchObject({
          _tag: "SnapshotWorldRunning",
          registry: "walks",
        });
        gate.release();
        yield* call(() => walking);

        const restored = backend(driver());
        yield* call(() => restored.restoreSnapshot(t.exportSnapshot()));
        expect(
          Arr.map(
            (
              (yield* call(() => restored.query(app.dump, {}))) as {
                notes: Array<{ text: string }>;
              }
            ).notes,
            (note) => note.text,
          ),
        ).toEqual(["gated", "gated"]);
        expect(restored.jobs()).toEqual([]);
      }),
  );
});

describe("snapshot live state", () => {
  it.effect(
    "a nested mutation an action leaves running keeps export and restore refused until it settles, and its row is then in the snapshot",
    () =>
      Effect.gen(function* () {
        gate = latch();
        reached = latch();
        const t = backend(driver());
        yield* call(() => t.action(app.detach, {}));
        yield* call(() => reached.promise);
        expect(thrown(() => t.exportSnapshot())).toMatchObject({
          _tag: "SnapshotWorldRunning",
          registry: "functions",
        });
        const first = gate;
        const fresh = backend(driver());
        gate = latch();
        reached = latch();
        yield* call(() => fresh.action(app.detach, {}));
        yield* call(() => reached.promise);
        const failureResult = yield* failure(() =>
          fresh.restoreSnapshot(backend(driver()).exportSnapshot()),
        );
        expect(failureResult).toMatchObject({
          _tag: "SnapshotWorldRunning",
          registry: "functions",
        });
        first.release();
        gate.release();
        const exported = yield* call(() => settled(t));
        yield* call(() => settled(fresh));
        const restored = backend(driver());
        yield* call(() => restored.restoreSnapshot(exported));
        expect(
          Arr.map(
            (
              (yield* call(() => restored.query(app.dump, {}))) as {
                notes: Array<{ text: string }>;
              }
            ).notes,
            (note) => note.text,
          ),
        ).toEqual(["detached"]);
      }),
  );

  it.effect(
    "a backend with a subscriber refuses a restore, which would rewind the identity version that subscriber holds",
    () =>
      Effect.gen(function* () {
        const d = driver();
        const t = backend(d);
        yield* before(t, d);
        const snapshot = t.exportSnapshot();
        const restored = backend(driver());
        restored.subscriber().authenticate({ subject: "live" });
        const failureResult = yield* failure(() =>
          restored.restoreSnapshot(snapshot, { worlds: [mail] }),
        );
        expect(failureResult).toMatchObject({
          _tag: "SnapshotSubscribed",
          subscribers: 1,
        });
        expect(restored.jobs()).toEqual([]);
      }),
  );

  it.effect(
    "a restore refuses while any live registry the contract names is non-empty",
    () =>
      Effect.gen(function* () {
        const snapshot = backend(driver()).exportSnapshot();
        const refusal = (t: KernelControls) =>
          failure(() => t.restoreSnapshot(snapshot));
        const refusals: Record<string, unknown> = {};

        gate = latch();
        reached = latch();
        const running = backend(driver());
        const action = running.action(app.waitGate, {});
        yield* call(() => reached.promise);
        refusals["running"] = yield* refusal(running);
        gate.release();
        yield* call(() => action);

        gate = latch();
        reached = latch();
        const walking = backend(driver());
        yield* call(() => walking.mutation(app.scheduleGate, {}));
        const walk = walking.finishAllScheduledFunctions();
        yield* call(() => reached.promise);
        refusals["walks"] = yield* refusal(walking);
        gate.release();
        yield* call(() => walk);

        gate = latch();
        reached = latch();
        const detached = backend(driver());
        yield* call(() => detached.action(app.detach, {}));
        yield* call(() => reached.promise);
        refusals["functions"] = yield* refusal(detached);
        gate.release();
        yield* call(() => settled(detached));

        const holding = backend(driver());
        yield* call(() => holding.prepare(app.insert, { text: "held" }));
        refusals["held"] = yield* refusal(holding);

        const connected = backend(driver());
        const socket = new (connected.sync().WebSocket)("ws://kernel.invalid");
        refusals["sockets"] = yield* refusal(connected);
        socket.close();
        // The closed socket's subscriber outlives it, as any subscriber does.
        const afterClose = yield* refusal(connected);
        expect(afterClose).toMatchObject({ _tag: "SnapshotSubscribed" });

        const subscribed = backend(driver());
        subscribed.subscriber();
        refusals["subscribers"] = yield* refusal(subscribed);

        expect(Rec.keys(refusals).sort()).toEqual(
          Rec.keys(Snapshot.contract.live).sort(),
        );
        expect(refusals).toMatchObject({
          running: { _tag: "SnapshotWorldRunning", registry: "running" },
          walks: { _tag: "SnapshotWorldRunning", registry: "walks" },
          functions: { _tag: "SnapshotWorldRunning", registry: "functions" },
          held: { _tag: "SnapshotWorldBusy" },
          sockets: { _tag: "SnapshotSocketsOpen", sockets: 1 },
          subscribers: { _tag: "SnapshotSubscribed" },
        });
      }),
  );
});

describe("snapshot file storage", () => {
  const binary = Uint8Array.from([0, 1, 2, 254, 255, 0x7b, 0x0a]);
  type StorageId = GenericId<"_storage">;
  const storeFiles = (t: KernelControls) =>
    call(() =>
      t.action(async (ctx: any) => ({
        typed: await ctx.storage.store(
          new Blob([binary], { type: "application/octet-stream" }),
        ),
        untyped: await ctx.storage.store(new Blob(["plain"])),
        gone: await ctx.storage.store(new Blob(["deleted before export"])),
      })),
    );
  const describeFile = (t: KernelControls, id: StorageId | string) =>
    call(() =>
      t.query(async (ctx: any) => ({
        doc: await ctx.db.system.get(id),
        metadata: await ctx.storage.getMetadata(id),
        url: await ctx.storage.getUrl(id),
      })),
    );
  const contents = (t: KernelControls, id: StorageId) =>
    call(() =>
      t.action(async (ctx: any) => {
        const blob = await ctx.storage.get(id);
        return blob === null
          ? null
          : { type: blob.type, bytes: await blob.arrayBuffer() };
      }),
    );

  it.effect(
    "a stored file round-trips byte for byte, and getUrl and getMetadata answer after a restore as before it",
    () =>
      Effect.gen(function* () {
        const t = backend(driver());
        const ids = yield* storeFiles(t);
        yield* call(() => t.action((ctx: any) => ctx.storage.delete(ids.gone)));
        const exported = t.exportSnapshot();
        let exportedFiles: Array<string> = [];
        rehash(exported, (body) => {
          exportedFiles = body.files.map((file: any) => file.id);
        });
        expect(exportedFiles).toEqual(
          Arr.sort([ids.typed, ids.untyped], String.Order),
        );

        const restored = backend(driver());
        yield* call(() => restored.restoreSnapshot(exported));
        expect(text(restored.exportSnapshot())).toBe(text(exported));
        for (const id of [ids.typed, ids.untyped]) {
          const source = yield* describeFile(t, id);
          const describeFileResult = yield* describeFile(restored, id);
          expect(describeFileResult).toEqual(source);
          // A file's storage UUID still names it after a restore.
          const byUuid = yield* describeFile(
            restored,
            source.metadata.storageId,
          );
          expect([byUuid.metadata, byUuid.url]).toEqual([
            source.metadata,
            source.url,
          ]);
        }
        const read = yield* contents(restored, ids.typed);
        expect(read?.type).toBe("application/octet-stream");
        expect(new Uint8Array(read!.bytes)).toStrictEqual(binary);
        const contentsResult = yield* contents(restored, ids.gone);
        expect(contentsResult).toBeNull();
      }),
  );

  it.effect(
    "a restored backend mints the next storage UUID and upload token, never one its source handed out",
    () =>
      Effect.gen(function* () {
        const t = backend(driver());
        const ids = yield* storeFiles(t);
        const uploadUrl = () =>
          call(() => t.mutation((ctx: any) => ctx.storage.generateUploadUrl()));
        yield* uploadUrl();
        const restored = backend(driver());
        yield* call(() => restored.restoreSnapshot(t.exportSnapshot()));
        const next = yield* call(() =>
          restored.action((ctx: any) => ctx.storage.store(new Blob(["next"]))),
        );
        const uuids = yield* call(() =>
          restored.query((ctx: any) =>
            Promise.all(
              Arr.map([ids.typed, ids.untyped, ids.gone, next], (id) =>
                ctx.storage
                  .getMetadata(id)
                  .then((m: any) => m?.storageId ?? null),
              ),
            ),
          ),
        );
        expect(new Set(uuids).size).toBe(4);
        expect(uuids[3]).toBe("00000000-0000-4000-8000-000000000004");
        const callResult = yield* call(() =>
          restored.mutation((ctx: any) => ctx.storage.generateUploadUrl()),
        );
        expect(callResult).toMatch(/token=kernel-unsigned-2$/);
      }),
  );

  it.effect.each<{
    readonly name: string;
    readonly edit: (body: any, ids: Record<string, string>) => void;
    readonly refusal: Record<string, unknown>;
  }>([
    {
      name: "a file body changed after export",
      edit: (body, ids) => {
        const file = body.files.find((f: any) => f.id === ids["typed"]);
        file.bytes = btoa("tampered");
      },
      refusal: { _tag: "SnapshotFileInconsistent", reason: "digest" },
    },
    {
      name: "a file body of the right digest and another size",
      edit: (body, ids) => {
        const row = body.tables
          .flatMap((entry: any) => entry.rows)
          .find((r: any) => r.doc._id === ids["untyped"]);
        row.doc.size = 6;
        for (const commit of body.log)
          for (const change of commit.changes)
            if (change.id === ids["untyped"] && change.after !== null)
              change.after.size = 6;
      },
      refusal: { _tag: "SnapshotFileInconsistent", reason: "size" },
    },
    {
      name: "a `_storage` row whose file is missing",
      edit: (body, ids) => {
        body.files = body.files.filter((f: any) => f.id !== ids["untyped"]);
      },
      refusal: { _tag: "SnapshotFileInconsistent", reason: "untracked" },
    },
    {
      name: "two files under one storage UUID",
      edit: (body) => {
        body.files[1].uuid = body.files[0].uuid;
      },
      refusal: { _tag: "SnapshotFileInconsistent", reason: "uuid" },
    },
    {
      name: "a next file counter rewound onto a stored file's UUID",
      edit: (body) => {
        body.identity.nextFile = 1;
      },
      refusal: {
        _tag: "SnapshotAllocatorBehind",
        allocator: "nextFile",
        required: 4,
      },
    },
  ])("$name is refused before anything is restored", ({ edit, refusal }) =>
    Effect.gen(function* () {
      const t = backend(driver());
      const ids = yield* storeFiles(t);
      const forged = rehash(t.exportSnapshot(), (body) => edit(body, ids));
      const restored = backend(driver());
      const failureResult = yield* failure(() =>
        restored.restoreSnapshot(forged),
      );
      expect(failureResult).toMatchObject(refusal);
      expect(restored.exportSnapshot()).toStrictEqual(
        backend(driver()).exportSnapshot(),
      );
    }),
  );

  it.effect(
    "a flipped byte in an exported file body fails the snapshot's digest",
    () =>
      Effect.gen(function* () {
        const t = backend(driver());
        yield* storeFiles(t);
        const exported = t.exportSnapshot();
        const at =
          pipe(
            text(exported),
            String.indexOf('"bytes":"'),
            Option.getOrElse(() => -1),
          ) + '"bytes":"'.length;
        const flipped = Uint8Array.from(exported);
        flipped[at] = flipped[at] === 0x41 ? 0x42 : 0x41;
        const failureResult = yield* failure(() =>
          backend(driver()).restoreSnapshot(flipped),
        );
        expect(failureResult).toMatchObject({ _tag: "SnapshotDigestMismatch" });
      }),
  );
});

// Cron state across a snapshot. The world counts every draw from its stream,
// and each draw is a quarter of its bound, never a zero delay, so no run ever
// draws again after its first.
const cronTicks = {
  tick: makeFunctionReference<"mutation", { name: string }>("cronApp:tick"),
  list: makeFunctionReference<"query", {}, Array<{ name: string; at: number }>>(
    "cronApp:list",
  ),
};
const cronSchema = defineSchema({
  ticks: defineTable({ name: v.string(), at: v.number() }),
});
type Declare = (crons: ReturnType<typeof cronJobs>) => void;
const declareAll: Declare = (crons) => {
  crons.interval("interval", { minutes: 15 }, cronTicks.tick, {
    name: "interval",
  });
  crons.hourly("hourly", {}, cronTicks.tick, { name: "hourly" });
  crons.cron("expression", "*/7 * * * *", cronTicks.tick, {
    name: "expression",
  });
  crons.cron("weekday", "0 6 15W * *", cronTicks.tick, { name: "weekday" });
};
const cronModules = (declare: Declare) => {
  const crons = cronJobs();
  declare(crons);
  return {
    "_generated/server.ts": () => Promise.resolve({}),
    "cronApp.ts": () =>
      Promise.resolve({
        tick: mutationGeneric({
          args: { name: v.string() },
          handler: (ctx, { name }) =>
            ctx.db.insert("ticks", { name, at: Date.now() }).then(() => null),
        }),
        list: queryGeneric({
          args: {},
          handler: (ctx) =>
            ctx.db
              .query("ticks")
              .collect()
              .then((rows) => Arr.map(rows, ({ name, at }) => ({ name, at }))),
        }),
      }),
    "crons.ts": () => Promise.resolve({ default: crons }),
  };
};
const counted = () => {
  let draws = 0;
  const world: Invocation.World = {
    name: "crons",
    services: Context.empty(),
    clock: () => start,
    random: () => {
      draws += 1;
      return 0.25;
    },
  };
  return { world, draws: () => draws };
};
const cronBackend = (
  d: Driver,
  world: Invocation.World,
  declare: Declare = declareAll,
): KernelControls =>
  convexTest({
    schema: cronSchema,
    modules: cronModules(declare),
    runtime: d.runtime,
    world,
  });
const hours = (n: number) => n * 60 * 60 * 1000;

describe("snapshot cron state", () => {
  it.effect(
    "a restored backend's next cron runs equal the run that never stopped, byte for byte, and the restore draws nothing",
    () =>
      Effect.gen(function* () {
        const d = driver();
        const source = counted();
        const t = cronBackend(d, source.world);
        yield* call(() => t.advance(hours(30)));
        const snapshot = t.exportSnapshot();
        const atSnapshot = t.crons();
        yield* call(() => t.advance(hours(40)));
        const straightCrons = t.crons();
        const straightTicks = yield* call(() => t.query(cronTicks.list, {}));
        const straight = yield* Schema.encodeEffect(UnknownJson)({
          crons: straightCrons,
          ticks: straightTicks,
        });

        const restoring = counted();
        const restored = cronBackend(driver(), restoring.world);
        yield* call(() => restored.restoreSnapshot(snapshot));
        expect(restoring.draws()).toBe(0);
        expect(restored.crons()).toEqual(atSnapshot);
        yield* call(() => restored.advance(hours(40)));
        const replayedCrons = restored.crons();
        const replayedTicks = yield* call(() =>
          restored.query(cronTicks.list, {}),
        );
        const replayed = yield* Schema.encodeEffect(UnknownJson)({
          crons: replayedCrons,
          ticks: replayedTicks,
        });

        expect(replayed).toBe(straight);
        expect(restoring.draws()).toBe(0);
        expect(source.draws()).toBe(3);
        expect(text(restored.exportSnapshot())).toBe(text(t.exportSnapshot()));
      }),
  );

  it.effect(
    "a restore refuses when the app declares other cron jobs than the snapshot holds, and draws nothing",
    () =>
      Effect.gen(function* () {
        const t = cronBackend(driver(), counted().world);
        yield* call(() => t.advance(hours(1)));
        const snapshot = t.exportSnapshot();
        const into = (declare: Declare) => {
          const restoring = counted();
          const restored = cronBackend(driver(), restoring.world, declare);
          return failure(() => restored.restoreSnapshot(snapshot)).pipe(
            Effect.map((error) => ({ error, draws: restoring.draws() })),
          );
        };
        const intoResult = yield* into((crons) => {
          declareAll(crons);
          delete (crons as unknown as { crons: Record<string, unknown> }).crons[
            "expression"
          ];
        });
        expect(intoResult).toMatchObject({
          error: {
            _tag: "SnapshotCronMismatch",
            cronName: "expression",
            reason: "undeclared",
          },
          draws: 0,
        });
        const intoResult2 = yield* into((crons) => {
          declareAll(crons);
          crons.interval("extra", { seconds: 5 }, cronTicks.tick, {
            name: "extra",
          });
        });
        expect(intoResult2).toMatchObject({
          error: {
            _tag: "SnapshotCronMismatch",
            cronName: "extra",
            reason: "missing",
          },
          draws: 0,
        });
        const intoResult3 = yield* into((crons) => {
          crons.interval("interval", { seconds: 60 }, cronTicks.tick, {
            name: "interval",
          });
          crons.hourly("hourly", {}, cronTicks.tick, { name: "hourly" });
          crons.cron("expression", "*/7 * * * *", cronTicks.tick, {
            name: "expression",
          });
          crons.cron("weekday", "0 6 15W * *", cronTicks.tick, {
            name: "weekday",
          });
        });
        expect(intoResult3).toMatchObject({
          error: {
            _tag: "SnapshotCronMismatch",
            cronName: "interval",
            reason: "changed",
          },
          draws: 0,
        });
        const intoResult4 = yield* into((crons) => {
          declareAll(crons);
          (
            crons as unknown as {
              crons: Record<string, { args: Array<unknown> }>;
            }
          ).crons["hourly"]!.args = [{ name: "renamed" }];
        });
        expect(intoResult4).toMatchObject({
          error: {
            _tag: "SnapshotCronMismatch",
            cronName: "hourly",
            reason: "changed",
          },
          draws: 0,
        });
      }),
  );

  it.effect(
    "a cron job's world is restored by name, and a restore with no world of that name refuses",
    () =>
      Effect.gen(function* () {
        const t = cronBackend(driver(), counted().world);
        yield* call(() => t.advance(hours(1)));
        const snapshot = t.exportSnapshot();
        const elsewhere = convexTest({
          schema: cronSchema,
          modules: cronModules(declareAll),
          runtime: driver().runtime,
        });
        const failureResult = yield* failure(() =>
          elsewhere.restoreSnapshot(snapshot),
        );
        expect(failureResult).toMatchObject({
          _tag: "SnapshotWorldUnresolved",
          worldName: "crons",
          reason: "missing",
        });
        const named = convexTest({
          schema: cronSchema,
          modules: cronModules(declareAll),
          runtime: driver().runtime,
        });
        const restoring = counted();
        yield* call(() =>
          named.restoreSnapshot(snapshot, { worlds: [restoring.world] }),
        );
        expect(named.crons()).toEqual(t.crons());
        expect(restoring.draws()).toBe(0);
      }),
  );
});

describe("snapshot contract", () => {
  it.effect(
    "every field of a world is exported or excluded with a reason, so new state cannot be left out of a snapshot by accident",
    () =>
      Effect.sync(() => {
        const world = new Execution.World(null, {
          "_generated/server.ts": () => Promise.resolve({}),
        });
        expect(Rec.keys(world).sort()).toEqual(
          Rec.keys(Snapshot.contract.world).sort(),
        );
        expect(Rec.keys(world.liveCounts()).sort()).toEqual(
          Rec.keys(Snapshot.contract.live).sort(),
        );
      }),
  );
});

describe("provider commands", () => {
  // A port whose calls the kernel holds as commands.
  const charges = Egress.port("snapshotCharges", (_input: { url: string }) =>
    Promise.resolve("live"),
  );
  const pay = {
    leaveHeld: makeFunctionReference<"action">("pay:leaveHeld"),
    charge: makeFunctionReference<"action", {}, string>("pay:charge"),
  };
  const modules = {
    "_generated/server.ts": () => Promise.resolve({}),
    "pay.ts": () =>
      Promise.resolve({
        // Returns with its command still held, so the command is cancelled.
        leaveHeld: actionGeneric({
          args: {},
          handler: () => {
            void charges.call({ url: "https://example.com/" });
            return Promise.resolve(null);
          },
        }),
        charge: actionGeneric({
          args: {},
          handler: () => charges.call({ url: "https://example.com/" }),
        }),
      }),
  };
  const sources = inlineSources(modules);
  const kernel = (): KernelControls => convexTest({ modules, sources });

  // Why an answer to command `id` is refused, if it is.
  const staleReason = (t: KernelControls, id: string) => {
    try {
      t.answer(id, "late");
      return undefined;
    } catch (error) {
      return (error as { readonly reason?: string }).reason;
    }
  };

  // The next command's ID, and how an answer to the cancelled one is refused.
  const nextCommand = (t: KernelControls) =>
    Effect.gen(function* () {
      const charged = t.action(pay.charge, {});
      const held = yield* Effect.promise(() =>
        vi.waitFor(() => {
          const commands = t.commands();
          expect(commands).toHaveLength(1);
          return commands;
        }),
      );
      t.answer(held[0]!.id, "answered");
      yield* Effect.promise(() => charged);
      return { next: held[0]!.id, stale: staleReason(t, "command-1") };
    });

  it.effect(
    "a restore continues the command allocator and the cancelled commands, as the uninterrupted run does",
    () =>
      Effect.gen(function* () {
        const source = kernel();
        yield* Effect.promise(() => source.action(pay.leaveHeld, {}));
        const snapshot = source.exportSnapshot();
        const restored = kernel();
        yield* Effect.promise(() => restored.restoreSnapshot(snapshot));
        const uninterrupted = yield* nextCommand(source);
        const afterRestore = yield* nextCommand(restored);
        expect(uninterrupted).toEqual({
          next: "command-2",
          stale: "cancelled",
        });
        expect(afterRestore).toEqual(uninterrupted);
      }),
  );
});
