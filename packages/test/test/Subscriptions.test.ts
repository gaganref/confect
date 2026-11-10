// oxlint-disable effecttsgo/global-date -- The fixtures are plain Convex functions, which read the pinned `Date` as product code does.
import { describe, expect, it } from "@effect/vitest";
import {
  componentsGeneric,
  defineSchema,
  defineTable,
  makeFunctionReference,
  mutationGeneric,
  paginationOptsValidator,
  queryGeneric,
  type FunctionReference,
} from "convex/server";
import { v, type GenericId, type Value } from "convex/values";
import * as Effect from "effect/Effect";
import { convexTest, type KernelControls } from "../src/internal/ConvexTest";
import type * as Execution from "../src/internal/Execution";

type TaskId = GenericId<"tasks">;
type Task = { title: string; owner: string; due: number };

const tasks = {
  add: makeFunctionReference<"mutation", Task, TaskId>("tasks:add"),
  move: makeFunctionReference<"mutation", { id: TaskId; due: number }>(
    "tasks:move",
  ),
  give: makeFunctionReference<"mutation", { id: TaskId; owner: string }>(
    "tasks:give",
  ),
  remove: makeFunctionReference<"mutation", { id: TaskId }>("tasks:remove"),
  store: makeFunctionReference<"mutation", { text: string }>("tasks:store"),
  mine: makeFunctionReference<"query", {}, Array<string>>("tasks:mine"),
  overdue: makeFunctionReference<"query", {}, Array<string>>("tasks:overdue"),
  title: makeFunctionReference<"query", { id: TaskId }, string | null>(
    "tasks:title",
  ),
  next: makeFunctionReference<"query", {}, string | null>("tasks:next"),
  owned: makeFunctionReference<"query", { owner: string }, Array<string>>(
    "tasks:owned",
  ),
  page: makeFunctionReference<
    "query",
    { paginationOpts: { numItems: number; cursor: string | null } },
    Array<string>
  >("tasks:page"),
  only: makeFunctionReference<"query", {}, string>("tasks:only"),
  stored: makeFunctionReference<"query", {}, Array<string>>("tasks:stored"),
};

const store = (componentsGeneric() as any).store as {
  readonly rows: {
    readonly add: FunctionReference<"mutation", "internal", { text: string }>;
    readonly list: FunctionReference<"query", "internal", {}, Array<string>>;
  };
};

const titles = (rows: ReadonlyArray<{ readonly title: string }>) =>
  rows.map((row) => row.title);

const schema = defineSchema({
  tasks: defineTable({ title: v.string(), owner: v.string(), due: v.number() })
    .index("by_owner", ["owner"])
    .index("by_due", ["due"]),
});

const modules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "tasks.ts": () =>
    Promise.resolve({
      add: mutationGeneric({
        args: { title: v.string(), owner: v.string(), due: v.number() },
        handler: (ctx, task) => ctx.db.insert("tasks", task),
      }),
      move: mutationGeneric({
        args: { id: v.id("tasks"), due: v.number() },
        handler: (ctx, { id, due }) =>
          ctx.db.patch(id, { due }).then(() => null),
      }),
      give: mutationGeneric({
        args: { id: v.id("tasks"), owner: v.string() },
        handler: (ctx, { id, owner }) =>
          ctx.db.patch(id, { owner }).then(() => null),
      }),
      remove: mutationGeneric({
        args: { id: v.id("tasks") },
        handler: (ctx, { id }) => ctx.db.delete(id).then(() => null),
      }),
      store: mutationGeneric({
        args: { text: v.string() },
        handler: (ctx, { text }) =>
          ctx.runMutation(store.rows.add, { text }).then(() => null),
      }),
      mine: queryGeneric({
        args: {},
        handler: (ctx) =>
          ctx.auth.getUserIdentity().then((identity) =>
            identity === null
              ? []
              : ctx.db
                  .query("tasks")
                  .withIndex("by_owner", (q) => q.eq("owner", identity.subject))
                  .collect()
                  .then(titles),
          ),
      }),
      overdue: queryGeneric({
        args: {},
        handler: (ctx) =>
          ctx.db
            .query("tasks")
            .withIndex("by_due", (q) => q.lt("due", Date.now()))
            .collect()
            .then(titles),
      }),
      title: queryGeneric({
        args: { id: v.id("tasks") },
        handler: (ctx, { id }) =>
          ctx.db.get(id).then((task) => task?.title ?? null),
      }),
      next: queryGeneric({
        args: {},
        handler: (ctx) =>
          ctx.db
            .query("tasks")
            .withIndex("by_due")
            .first()
            .then((task) => task?.title ?? null),
      }),
      owned: queryGeneric({
        args: { owner: v.string() },
        handler: (ctx, { owner }) =>
          ctx.db
            .query("tasks")
            .withIndex("by_owner", (q) => q.eq("owner", owner))
            .collect()
            .then(titles),
      }),
      page: queryGeneric({
        args: { paginationOpts: paginationOptsValidator },
        handler: (ctx, { paginationOpts }) =>
          ctx.db
            .query("tasks")
            .withIndex("by_due")
            .paginate(paginationOpts)
            .then(({ page }) => titles(page)),
      }),
      only: queryGeneric({
        args: {},
        handler: (ctx) =>
          ctx.db
            .query("tasks")
            .unique()
            .then((task) => task?.title ?? "none"),
      }),
      stored: queryGeneric({
        args: {},
        handler: (ctx) => ctx.runQuery(store.rows.list, {}),
      }),
    }),
};

const storeSchema = defineSchema({ rows: defineTable({ text: v.string() }) });

const storeModules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "rows.ts": () =>
    Promise.resolve({
      add: mutationGeneric({
        args: { text: v.string() },
        handler: (ctx, { text }) =>
          ctx.db.insert("rows", { text }).then(() => null),
      }),
      list: queryGeneric({
        args: {},
        handler: (ctx) =>
          ctx.db
            .query("rows")
            .collect()
            .then((rows) => rows.map((row) => row.text)),
      }),
    }),
};

/**
 * A runtime whose clock the test moves.
 */
const clock = (start: number) => {
  let now = start;
  return {
    runtime: {
      now: () => now,
      commitTs: (version: number) => 1_000n + BigInt(version),
    },
    set: (to: number) => {
      now = to;
    },
  };
};

const world = (runtime = clock(1_000).runtime): KernelControls => {
  const t = convexTest({ schema, modules, runtime });
  t.registerComponent("store", storeSchema, storeModules);
  return t;
};

const call = <A>(thunk: () => Promise<A>) => Effect.promise(thunk);

const returned = (value: Value): Execution.Outcome => ({
  _tag: "returned",
  value,
});

const page = (numItems: number) => ({
  paginationOpts: { numItems, cursor: null },
});

describe("full-rerun reference", () => {
  it.effect(
    "after every step of a history, each subscription shows what a full rerun of its query answers",
    () =>
      Effect.gen(function* () {
        const time = clock(1_000);
        const t = world(time.runtime);
        const a = yield* call(() =>
          t.mutation(tasks.add, { title: "a", owner: "ada", due: 10 }),
        );
        const b = yield* call(() =>
          t.mutation(tasks.add, { title: "b", owner: "bob", due: 20 }),
        );
        yield* call(() =>
          t.mutation(tasks.add, { title: "c", owner: "ada", due: 30 }),
        );
        const ada = t.withIdentity({ subject: "ada" }).subscriber();
        const anyone = t.subscriber();
        const subscriptions = yield* call(() =>
          Promise.all([
            ada.subscribe(tasks.mine, {}),
            ada.subscribe(tasks.overdue, {}),
            anyone.subscribe(tasks.title, { id: b }),
            anyone.subscribe(tasks.next, {}),
            anyone.subscribe(tasks.owned, { owner: "cy" }),
            anyone.subscribe(tasks.page, page(2)),
            anyone.subscribe(tasks.only, {}),
            anyone.subscribe(tasks.stored, {}),
          ]),
        );
        const steps: ReadonlyArray<() => Promise<unknown>> = [
          () => t.mutation(tasks.add, { title: "d", owner: "cy", due: 5 }),
          () => t.mutation(tasks.move, { id: a, due: 40 }),
          () => t.mutation(tasks.give, { id: b, owner: "ada" }),
          () => t.mutation(tasks.remove, { id: b }),
          () => Promise.resolve(ada.authenticate({ subject: "cy" })),
          () => Promise.resolve(time.set(2_000)),
          () => t.mutation(tasks.add, { title: "e", owner: "cy", due: 1_500 }),
          () => t.mutation(tasks.store, { text: "row" }),
        ];
        const disagreements: Array<unknown> = [];
        for (const step of steps) {
          yield* call(step);
          yield* call(() => t.refresh());
          disagreements.push(...(yield* call(() => t.reference())));
        }
        expect(disagreements).toEqual([]);
        expect(subscriptions.map((s) => s.current().outcome)).toMatchObject([
          returned(["d", "e"]),
          returned(["d", "c", "a"]),
          returned(null),
          returned("d"),
          returned(["d", "e"]),
          returned(["d"]),
          { _tag: "failed" },
          returned(["row"]),
        ]);
      }),
  );

  it.effect(
    "a subscription a commit invalidated disagrees with the reference until it is refreshed",
    () =>
      Effect.gen(function* () {
        const t = world();
        const subscription = yield* call(() =>
          t.subscriber().subscribe(tasks.next, {}),
        );
        yield* call(() =>
          t.mutation(tasks.add, { title: "a", owner: "ada", due: 10 }),
        );
        const before = yield* call(() => t.reference());
        yield* call(() => t.refresh());
        const after = yield* call(() => t.reference());
        expect(before).toEqual([
          {
            subscription: subscription.id,
            incremental: returned(null),
            reference: returned("a"),
          },
        ]);
        expect(after).toEqual([]);
      }),
  );
});

describe("read sets", () => {
  it.effect(
    "a commit beside a subscription's reads leaves its run in place, and one inside them reruns it",
    () =>
      Effect.gen(function* () {
        const t = world();
        yield* call(() =>
          t.mutation(tasks.add, { title: "a", owner: "ada", due: 10 }),
        );
        yield* call(() =>
          t.mutation(tasks.add, { title: "c", owner: "ada", due: 30 }),
        );
        const subscription = yield* call(() =>
          t.subscriber().subscribe(tasks.next, {}),
        );
        const first = subscription.current().snapshot;
        yield* call(() =>
          t.mutation(tasks.add, { title: "b", owner: "bob", due: 20 }),
        );
        const past = yield* call(() => t.refresh());
        const kept = subscription.current().snapshot;
        yield* call(() =>
          t.mutation(tasks.add, { title: "z", owner: "bob", due: 0 }),
        );
        const inside = yield* call(() => t.refresh());
        expect(past).toEqual([]);
        expect(kept).toBe(first);
        expect(inside).toMatchObject([
          {
            subscription: subscription.id,
            from: returned("a"),
            to: returned("z"),
            because: { kind: "commit" },
          },
        ]);
      }),
  );

  it.effect(
    "an empty index range reruns when a commit inserts into it, and not when one inserts beside it",
    () =>
      Effect.gen(function* () {
        const t = world();
        const subscription = yield* call(() =>
          t.subscriber().subscribe(tasks.owned, { owner: "cy" }),
        );
        const empty = subscription.current().snapshot;
        yield* call(() =>
          t.mutation(tasks.add, { title: "a", owner: "ada", due: 10 }),
        );
        yield* call(() => t.refresh());
        const beside = subscription.current().snapshot;
        yield* call(() =>
          t.mutation(tasks.add, { title: "c", owner: "cy", due: 30 }),
        );
        const changed = yield* call(() => t.refresh());
        expect(beside).toBe(empty);
        expect(changed.map((transition) => transition.to)).toEqual([
          returned(["c"]),
        ]);
      }),
  );

  it.effect(
    "a commit to a mounted component reruns a host subscription that read it through a nested query",
    () =>
      Effect.gen(function* () {
        const t = world();
        const subscription = yield* call(() =>
          t.subscriber().subscribe(tasks.stored, {}),
        );
        yield* call(() => t.mutation(tasks.store, { text: "row" }));
        yield* call(() => t.refresh());
        expect(subscription.current().outcome).toEqual(returned(["row"]));
      }),
  );

  it.effect(
    "a paginated subscription keeps the page end its first run read, so an insert inside the page grows it",
    () =>
      Effect.gen(function* () {
        const t = world();
        for (const [title, due] of [
          ["a", 10],
          ["c", 30],
          ["e", 50],
        ] as const) {
          yield* call(() =>
            t.mutation(tasks.add, { title, owner: "ada", due }),
          );
        }
        const subscription = yield* call(() =>
          t.subscriber().subscribe(tasks.page, page(2)),
        );
        const first = subscription.current().outcome;
        yield* call(() =>
          t.mutation(tasks.add, { title: "b", owner: "ada", due: 20 }),
        );
        yield* call(() => t.refresh());
        expect(first).toEqual(returned(["a", "c"]));
        expect(subscription.current().outcome).toEqual(
          returned(["a", "b", "c"]),
        );
        expect(yield* call(() => t.reference())).toEqual([]);
      }),
  );

  it.effect("an unsubscribed query is never rerun", () =>
    Effect.gen(function* () {
      const t = world();
      const client = t.subscriber();
      const [dropped, kept] = yield* call(() =>
        Promise.all([
          client.subscribe(tasks.next, {}),
          client.subscribe(tasks.next, {}),
        ]),
      );
      dropped.unsubscribe();
      yield* call(() =>
        t.mutation(tasks.add, { title: "a", owner: "ada", due: 10 }),
      );
      const changed = yield* call(() => t.refresh());
      expect(changed.map((transition) => transition.subscription)).toEqual([
        kept.id,
      ]);
    }),
  );
});

describe("identity", () => {
  it.effect(
    "an identity change reruns each subscription that read the identity, under the new identity",
    () =>
      Effect.gen(function* () {
        const t = world();
        yield* call(() =>
          t.mutation(tasks.add, { title: "a", owner: "ada", due: 10 }),
        );
        yield* call(() =>
          t.mutation(tasks.add, { title: "b", owner: "bob", due: 20 }),
        );
        const client = t.withIdentity({ subject: "ada" }).subscriber();
        const subscription = yield* call(() =>
          client.subscribe(tasks.mine, {}),
        );
        client.authenticate({ subject: "bob" });
        const changed = yield* call(() => t.refresh());
        client.authenticate(null);
        yield* call(() => t.refresh());
        expect(changed).toMatchObject([
          {
            subscription: subscription.id,
            from: returned(["a"]),
            to: returned(["b"]),
            because: { kind: "identity", from: 0, to: 1 },
          },
        ]);
        expect(subscription.current().outcome).toEqual(returned([]));
      }),
  );

  it.effect(
    "an identity change leaves a subscription that never read the identity in place",
    () =>
      Effect.gen(function* () {
        const t = world();
        const client = t.withIdentity({ subject: "ada" }).subscriber();
        const subscription = yield* call(() =>
          client.subscribe(tasks.next, {}),
        );
        client.authenticate({ subject: "bob" });
        yield* call(() => t.refresh());
        expect(subscription.current().identityVersion).toBe(0);
      }),
  );
});

describe("time", () => {
  it.effect(
    "the clock moving alone never reruns a subscription that read the time, as the binary never does",
    () =>
      Effect.gen(function* () {
        const time = clock(100);
        const t = world(time.runtime);
        yield* call(() =>
          t.mutation(tasks.add, { title: "a", owner: "ada", due: 50 }),
        );
        yield* call(() =>
          t.mutation(tasks.add, { title: "b", owner: "ada", due: 150 }),
        );
        const subscription = yield* call(() =>
          t.subscriber().subscribe(tasks.overdue, {}),
        );
        time.set(200);
        const moved = yield* call(() => t.refresh());
        expect(moved).toEqual([]);
        expect(subscription.current().outcome).toEqual(returned(["a"]));
        expect(subscription.current().time).toBe(100);
        expect(yield* call(() => t.reference())).toEqual([]);
      }),
  );

  it.effect(
    "a subscription that read the time reruns at the kernel's time when a commit invalidates it",
    () =>
      Effect.gen(function* () {
        const time = clock(100);
        const t = world(time.runtime);
        yield* call(() =>
          t.mutation(tasks.add, { title: "b", owner: "ada", due: 150 }),
        );
        const subscription = yield* call(() =>
          t.subscriber().subscribe(tasks.overdue, {}),
        );
        time.set(200);
        yield* call(() =>
          t.mutation(tasks.add, { title: "a", owner: "ada", due: 50 }),
        );
        yield* call(() => t.refresh());
        expect(subscription.current().outcome).toEqual(returned(["a", "b"]));
        expect(subscription.current().time).toBe(200);
      }),
  );

  it.effect("a subscription that never read the time records no time", () =>
    Effect.gen(function* () {
      const t = world();
      const subscription = yield* call(() =>
        t.subscriber().subscribe(tasks.next, {}),
      );
      expect(subscription.current().time).toBe(null);
    }),
  );
});
