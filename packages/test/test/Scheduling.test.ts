// oxlint-disable effecttsgo/async-function, effecttsgo/global-date -- The fixtures are plain Convex functions, which are async and read the pinned `Date` as product code does.
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The replay test compares the exact stdout of two fresh Node processes.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as FunctionSpec from "@confect/core/FunctionSpec";
import * as ActionCtx from "@confect/server/ActionCtx";
import * as DatabaseSchema from "@confect/server/DatabaseSchema";
import * as FunctionRegistryItem from "@confect/server/FunctionRegistryItem";
import type * as Handler from "@confect/server/Handler";
import * as MutationCtx from "@confect/server/MutationCtx";
import * as RegisteredConvexFunction from "@confect/server/RegisteredConvexFunction";
import { assert, describe, expect, it } from "@effect/vitest";
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
  type GenericDataModel,
} from "convex/server";
import { v, type GenericId } from "convex/values";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { convexTest, type KernelControls } from "../src/internal/ConvexTest";
import * as Invocation from "../src/internal/Invocation";
import * as Arr from "effect/Array";
import * as Json from "../src/internal/Json";

const start = 1_000_000;
const runtime = {
  now: () => start,
  commitTs: (version: number) => 10n + BigInt(version),
};

type Job = GenericId<"_scheduled_functions">;
type Next = { readonly label: string; readonly ms: number };

const jobs = {
  mark: makeFunctionReference<"mutation", { label: string; next?: Next }>(
    "jobs:mark",
  ),
  schedule: makeFunctionReference<
    "mutation",
    { marks: ReadonlyArray<{ label: string; ms: number; next?: Next }> },
    Array<Job>
  >("jobs:schedule"),
  scheduleThenCancel: makeFunctionReference<"mutation", {}, Job>(
    "jobs:scheduleThenCancel",
  ),
  scheduleThenFail: makeFunctionReference<"mutation">("jobs:scheduleThenFail"),
  scheduleFromAction: makeFunctionReference<"action">(
    "jobs:scheduleFromAction",
  ),
  cancel: makeFunctionReference<"mutation", { id: Job }>("jobs:cancel"),
  cancelFromAction: makeFunctionReference<"action", { id: Job }>(
    "jobs:cancelFromAction",
  ),
  state: makeFunctionReference<"query", { id: Job }, string | null>(
    "jobs:state",
  ),
  marks: makeFunctionReference<
    "query",
    {},
    Array<{ label: string; at: number }>
  >("jobs:marks"),
  now: makeFunctionReference<"mutation", {}, number>("jobs:now"),
  scheduleProbe: makeFunctionReference<"mutation", {}, Job>(
    "jobs:scheduleProbe",
  ),
  probe: makeFunctionReference<"mutation", { label: string }>("jobs:probe"),
  probes: makeFunctionReference<"query", {}, Array<Record<string, unknown>>>(
    "jobs:probes",
  ),
  sendMail: makeFunctionReference<"mutation", { text: string }>(
    "jobs:sendMail",
  ),
  delivered: makeFunctionReference<"mutation", { text: string }>(
    "jobs:delivered",
  ),
};

const components = componentsGeneric() as unknown as {
  readonly beat: {
    readonly public: {
      readonly start: FunctionReference<"mutation", "internal">;
      readonly count: FunctionReference<"query", "internal", {}, number>;
    };
  };
  readonly flow: {
    readonly flow: {
      readonly start: FunctionReference<"mutation", "internal", {}, string>;
      readonly send: FunctionReference<
        "mutation",
        "internal",
        { id: string; value: string }
      >;
      readonly get: FunctionReference<
        "query",
        "internal",
        { id: string },
        { state: string; value?: string }
      >;
    };
  };
  readonly mailer: {
    readonly mailer: {
      readonly send: FunctionReference<
        "mutation",
        "internal",
        { handle: string; text: string }
      >;
    };
  };
};

const hostSchema = defineSchema({
  marks: defineTable({ label: v.string(), at: v.number() }),
  probes: defineTable({ probe: v.any() }),
});

const mark = mutationGeneric({
  args: {
    label: v.string(),
    next: v.optional(v.object({ label: v.string(), ms: v.number() })),
  },
  handler: async (ctx, { label, next }) => {
    await ctx.db.insert("marks", { label, at: Date.now() });
    if (next !== undefined)
      await ctx.scheduler.runAfter(next.ms, jobs.mark, { label: next.label });
    return null;
  },
});

const probe = mutationGeneric({
  args: { label: v.string() },
  handler: async (ctx, { label }) => {
    const identity = await ctx.auth.getUserIdentity();
    const request = await (
      ctx as unknown as {
        meta: { getRequestMetadata: () => Promise<Record<string, unknown>> };
      }
    ).meta.getRequestMetadata();
    await ctx.db.insert("probes", {
      probe: {
        label,
        subject: identity?.subject ?? null,
        ip: request.ip,
        userAgent: request.userAgent,
        requestId: request.requestId,
        scheduledFunctionId: request.scheduledFunctionId,
      },
    });
    return null;
  },
});

const hostModules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "jobs.ts": () =>
    Promise.resolve({
      mark,
      probe,
      schedule: mutationGeneric({
        args: { marks: v.array(v.any()) },
        handler: (ctx, { marks }) =>
          Promise.all(
            Arr.map(marks, ({ label, ms, next }) =>
              ctx.scheduler.runAfter(ms, jobs.mark, {
                label,
                ...(next === undefined ? {} : { next }),
              }),
            ),
          ),
      }),
      scheduleThenCancel: mutationGeneric({
        args: {},
        handler: async (ctx) => {
          const id = await ctx.scheduler.runAfter(10, jobs.mark, {
            label: "canceled",
          });
          await ctx.scheduler.cancel(id);
          return id;
        },
      }),
      scheduleThenFail: mutationGeneric({
        args: {},
        handler: async (ctx) => {
          await ctx.scheduler.runAfter(0, jobs.mark, { label: "orphan" });
          throw new Error("The scheduling mutation failed.");
        },
      }),
      scheduleFromAction: actionGeneric({
        args: {},
        handler: async (ctx) => {
          await ctx.scheduler.runAfter(0, jobs.mark, { label: "from action" });
          throw new Error("The action failed after it scheduled.");
        },
      }),
      cancel: mutationGeneric({
        args: { id: v.id("_scheduled_functions") },
        handler: (ctx, { id }) => ctx.scheduler.cancel(id).then(() => null),
      }),
      cancelFromAction: actionGeneric({
        args: { id: v.id("_scheduled_functions") },
        handler: (ctx, { id }) => ctx.scheduler.cancel(id).then(() => null),
      }),
      state: queryGeneric({
        args: { id: v.id("_scheduled_functions") },
        handler: (ctx, { id }) =>
          ctx.db.system.get(id).then((job) => job?.state.kind ?? null),
      }),
      marks: queryGeneric({
        args: {},
        handler: (ctx) =>
          ctx.db
            .query("marks")
            .collect()
            .then((rows) => Arr.map(rows, ({ label, at }) => ({ label, at }))),
      }),
      now: mutationGeneric({
        args: {},
        handler: () => Promise.resolve(Date.now()),
      }),
      scheduleProbe: mutationGeneric({
        args: {},
        handler: async (ctx) => {
          await ctx.runMutation(jobs.probe, { label: "caller" });
          return ctx.scheduler.runAfter(0, jobs.probe, { label: "job" });
        },
      }),
      probes: queryGeneric({
        args: {},
        handler: (ctx) =>
          ctx.db
            .query("probes")
            .collect()
            .then((rows) => Arr.map(rows, (row) => row.probe)),
      }),
      sendMail: mutationGeneric({
        args: { text: v.string() },
        handler: async (ctx, { text }) => {
          const handle = await createFunctionHandle(jobs.delivered);
          await ctx.runMutation(components.mailer.mailer.send, {
            handle,
            text,
          });
          return null;
        },
      }),
      delivered: mutationGeneric({
        args: { text: v.string() },
        handler: (ctx, { text }) =>
          ctx.db
            .insert("marks", { label: `delivered ${text}`, at: Date.now() })
            .then(() => null),
      }),
    }),
};

// A component whose `tick` schedules its own next run forever, as the official
// crons component's `public:rescheduler` does.
const beatModules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "public.ts": () =>
    Promise.resolve({
      start: mutationGeneric({
        args: {},
        handler: (ctx) =>
          ctx.scheduler
            .runAfter(1000, makeFunctionReference<"mutation">("public:tick"), {
              n: 0,
            })
            .then(() => null),
      }),
      tick: mutationGeneric({
        args: { n: v.number() },
        handler: async (ctx, { n }) => {
          await ctx.db.insert("beats", { n });
          await ctx.scheduler.runAfter(
            1000,
            makeFunctionReference<"mutation">("public:tick"),
            {
              n: n + 1,
            },
          );
          return null;
        },
      }),
      count: queryGeneric({
        args: {},
        handler: (ctx) =>
          ctx.db
            .query("beats")
            .collect()
            .then((rows) => rows.length),
      }),
    }),
};
const beatSchema = defineSchema({ beats: defineTable({ n: v.number() }) });

// A workflow whose step awaits an event, as the official Workflow component's
// `awaitEvent` does: the step parks the run, and `send` schedules it again.
const flowStep = makeFunctionReference<"mutation", { id: string }>("flow:step");
const flowModules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "flow.ts": () =>
    Promise.resolve({
      start: mutationGeneric({
        args: {},
        handler: async (ctx) => {
          const id = await ctx.db.insert("flows", { state: "running" });
          await ctx.scheduler.runAfter(0, flowStep, { id });
          return id;
        },
      }),
      step: mutationGeneric({
        args: { id: v.id("flows") },
        handler: async (ctx, { id }) => {
          const event = await ctx.db
            .query("events")
            .filter((q) => q.eq(q.field("flow"), id))
            .first();
          await ctx.db.patch(
            id,
            event === null
              ? { state: "waiting" }
              : { state: "done", value: event.value },
          );
          return null;
        },
      }),
      send: mutationGeneric({
        args: { id: v.id("flows"), value: v.string() },
        handler: async (ctx, { id, value }) => {
          await ctx.db.insert("events", { flow: id, value });
          await ctx.scheduler.runAfter(0, flowStep, { id });
          return null;
        },
      }),
      get: queryGeneric({
        args: { id: v.id("flows") },
        handler: (ctx, { id }) =>
          ctx.db.get(id).then((flow) => ({
            state: flow!.state,
            ...(flow!.value === undefined ? {} : { value: flow!.value }),
          })),
      }),
    }),
};
const flowSchema = defineSchema({
  flows: defineTable({ state: v.string(), value: v.optional(v.string()) }),
  events: defineTable({ flow: v.id("flows"), value: v.string() }),
});

// A component that stores the host's callback handle in a row, and from a
// scheduled job schedules the handle, as the crons component's rescheduler
// schedules its target.
const mailerModules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "mailer.ts": () =>
    Promise.resolve({
      send: mutationGeneric({
        args: { handle: v.string(), text: v.string() },
        handler: async (ctx, { handle, text }) => {
          const id = await ctx.db.insert("outbox", { handle, text });
          await ctx.scheduler.runAfter(
            10,
            makeFunctionReference<"mutation">("mailer:deliver"),
            {
              id,
            },
          );
          return null;
        },
      }),
      deliver: mutationGeneric({
        args: { id: v.id("outbox") },
        handler: async (ctx, { id }) => {
          const row = await ctx.db.get(id);
          await ctx.scheduler.runAfter(
            0,
            row!.handle as FunctionHandle<"mutation">,
            { text: row!.text },
          );
          return null;
        },
      }),
    }),
};
const mailerSchema = defineSchema({
  outbox: defineTable({ handle: v.string(), text: v.string() }),
});

const world = (
  register: (t: {
    registerComponent: (
      path: string,
      schema: unknown,
      modules: unknown,
      options?: { readonly standing?: ReadonlyArray<string> },
    ) => unknown;
  }) => void = () => {},
): KernelControls => {
  const t = convexTest({ schema: hostSchema, modules: hostModules, runtime });
  register(t);
  return t;
};

const call = <A>(thunk: () => Promise<A>) => Effect.promise(thunk);
const failure = (thunk: () => Promise<unknown>) =>
  call(() =>
    thunk().then(
      () => null,
      (error: unknown) => error,
    ),
  );

describe("the controlled clock", () => {
  it.effect(
    "advance walks every deadline in order, a job's own schedule included, and pins each job's start to its deadline",
    () =>
      Effect.gen(function* () {
        const t = world();
        yield* call(() =>
          t.mutation(jobs.schedule, {
            marks: [
              { label: "c", ms: 100 },
              { label: "b", ms: 30 },
              { label: "chain", ms: 20, next: { label: "chained", ms: 15 } },
              { label: "a", ms: 10 },
            ],
          }),
        );
        yield* call(() => t.advance(50));
        const callResult = yield* call(() => t.query(jobs.marks, {}));
        expect(callResult).toEqual([
          { label: "a", at: start + 10 },
          { label: "chain", at: start + 20 },
          { label: "b", at: start + 30 },
          { label: "chained", at: start + 35 },
        ]);
        expect(t.jobs()).toEqual([
          expect.objectContaining({
            name: "jobs:mark",
            scheduledTime: start + 100,
            standing: false,
          }),
        ]);
        const callResult2 = yield* call(() => t.mutation(jobs.now, {}));
        expect(callResult2).toBe(start + 50);
      }),
  );

  it.effect(
    "settling runs the jobs due now and never crosses a future deadline",
    () =>
      Effect.gen(function* () {
        const t = world();
        yield* call(() =>
          t.mutation(jobs.schedule, {
            marks: [
              { label: "now", ms: 0 },
              { label: "later", ms: 10 },
            ],
          }),
        );
        yield* call(() => t.finishInProgressScheduledFunctions());
        const callResult = yield* call(() => t.query(jobs.marks, {}));
        expect(callResult).toEqual([{ label: "now", at: start }]);
        expect(Arr.map(t.jobs(), (job) => job.scheduledTime)).toEqual([
          start + 10,
        ]);
      }),
  );
});

describe("jobs", () => {
  it.effect(
    "a canceled job never runs, whether its own mutation, a later mutation or an action cancels it",
    () =>
      Effect.gen(function* () {
        const t = world();
        const same = yield* call(() => t.mutation(jobs.scheduleThenCancel, {}));
        const [later, fromAction] = yield* call(() =>
          t.mutation(jobs.schedule, {
            marks: [
              { label: "later", ms: 10 },
              { label: "from action", ms: 10 },
            ],
          }),
        );
        yield* call(() => t.mutation(jobs.cancel, { id: later! }));
        yield* call(() => t.action(jobs.cancelFromAction, { id: fromAction! }));
        yield* call(() => t.finishAllScheduledFunctions());
        const callResult = yield* call(() => t.query(jobs.marks, {}));
        expect(callResult).toEqual([]);
        const callResult2 = yield* call(() =>
          Promise.all(
            Arr.map([same, later!, fromAction!], (id) =>
              t.query(jobs.state, { id }),
            ),
          ),
        );
        expect(callResult2).toEqual(["canceled", "canceled", "canceled"]);
      }),
  );

  it.effect(
    "a job exists only if the mutation that scheduled it commits, and an action's schedule commits at once",
    () =>
      Effect.gen(function* () {
        const t = world();
        yield* failure(() => t.mutation(jobs.scheduleThenFail, {}));
        expect(t.jobs()).toEqual([]);
        yield* failure(() => t.action(jobs.scheduleFromAction, {}));
        yield* call(() => t.finishAllScheduledFunctions());
        const callResult = yield* call(() => t.query(jobs.marks, {}));
        expect(callResult).toEqual([{ label: "from action", at: start }]);
      }),
  );

  it.effect(
    "a scheduled call runs with no identity and fresh request metadata that carries its job id",
    () =>
      Effect.gen(function* () {
        const t = world() as KernelControls & {
          withIdentity: (identity: object) => {
            withRequestMetadata: (metadata: object) => KernelControls;
          };
        };
        const id = yield* call(() =>
          t
            .withIdentity({ subject: "ada" })
            .withRequestMetadata({ ip: "203.0.113.7", userAgent: "probe" })
            .mutation(jobs.scheduleProbe, {}),
        );
        yield* call(() => t.finishAllScheduledFunctions());
        const [caller, job] = yield* call(() => t.query(jobs.probes, {}));
        expect(caller).toMatchObject({
          label: "caller",
          subject: "ada",
          ip: "203.0.113.7",
          userAgent: "probe",
          scheduledFunctionId: null,
        });
        expect(job).toEqual({
          label: "job",
          subject: null,
          ip: null,
          userAgent: null,
          requestId: expect.any(String),
          scheduledFunctionId: id,
        });
        expect(job!["requestId"]).not.toBe(caller!["requestId"]);
      }),
  );

  it.effect(
    "a host handle a component stores in a row is called back after the drain",
    () =>
      Effect.gen(function* () {
        const t = world((kit) =>
          kit.registerComponent("mailer", mailerSchema, mailerModules),
        );
        yield* call(() => t.mutation(jobs.sendMail, { text: "hello" }));
        const callResult = yield* call(() => t.query(jobs.marks, {}));
        expect(callResult).toEqual([]);
        yield* call(() => t.finishAllScheduledFunctions());
        const callResult2 = yield* call(() => t.query(jobs.marks, {}));
        expect(callResult2).toEqual([
          { label: "delivered hello", at: start + 10 },
        ]);
      }),
  );

  it.effect(
    "a workflow that awaits an event holds through the drain until the event is sent",
    () =>
      Effect.gen(function* () {
        const t = world((kit) =>
          kit.registerComponent("flow", flowSchema, flowModules),
        );
        const id = yield* call(() =>
          t.mutation(components.flow.flow.start, {}),
        );
        yield* call(() => t.finishAllScheduledFunctions());
        const callResult = yield* call(() =>
          t.query(components.flow.flow.get, { id }),
        );
        expect(callResult).toEqual({
          state: "waiting",
        });
        expect(t.jobs()).toEqual([]);
        yield* call(() =>
          t.mutation(components.flow.flow.send, { id, value: "approved" }),
        );
        yield* call(() => t.finishAllScheduledFunctions());
        const callResult2 = yield* call(() =>
          t.query(components.flow.flow.get, { id }),
        );
        expect(callResult2).toEqual({
          state: "done",
          value: "approved",
        });
      }),
  );
});

describe("standing sources", () => {
  it.effect(
    "the drain fails its budget on a self-rescheduling job no kit declared standing",
    () =>
      Effect.gen(function* () {
        const t = world((kit) =>
          kit.registerComponent("beat", beatSchema, beatModules),
        );
        yield* call(() => t.mutation(components.beat.public.start, {}));
        const error = yield* failure(() => t.finishAllScheduledFunctions());
        expect(error).toMatchObject({
          _tag: "DrainBudgetExceeded",
          budget: 100,
          pending: [{ componentPath: "beat", name: "public:tick" }],
        });
      }),
  );

  it.effect(
    "a declared standing source leaves the drain quiescent with its next run pending, and advancing time fires it",
    () =>
      Effect.gen(function* () {
        const t = world((kit) =>
          kit.registerComponent("beat", beatSchema, beatModules, {
            standing: ["public:tick"],
          }),
        );
        yield* call(() => t.mutation(components.beat.public.start, {}));
        yield* call(() => t.finishAllScheduledFunctions());
        const callResult = yield* call(() =>
          t.query(components.beat.public.count, {}),
        );
        expect(callResult).toBe(0);
        expect(t.jobs()).toEqual([
          expect.objectContaining({
            componentPath: "beat",
            name: "public:tick",
            scheduledTime: start + 1000,
            standing: true,
          }),
        ]);
        yield* call(() => t.advance(2500));
        const callResult2 = yield* call(() =>
          t.query(components.beat.public.count, {}),
        );
        expect(callResult2).toBe(2);
        expect(Arr.map(t.jobs(), (job) => job.scheduledTime)).toEqual([
          start + 3000,
        ]);
      }),
  );

  it.effect(
    "a standing name the component does not export is refused when the backend opens",
    () =>
      Effect.gen(function* () {
        const t = world((kit) =>
          kit.registerComponent("beat", beatSchema, beatModules, {
            standing: ["public:rescheduler"],
          }),
        );
        const failureResult = yield* failure(() => t.query(jobs.marks, {}));
        expect(failureResult).toMatchObject({
          _tag: "UnknownStandingSource",
          componentPath: "beat",
          name: "public:rescheduler",
        });
      }),
  );
});

// Declared cron jobs. The clock starts ten seconds into 2026. Each backend
// opens under a bound invocation of `cronOwner`, whose random stream every cron
// run's delay draws from: a quarter of its bound, 15 seconds for a pinned
// minute.
const cronStart = Date.UTC(2026, 0, 1, 0, 0, 10);
const cronRuntime = {
  now: () => cronStart,
  commitTs: (version: number) => 10n + BigInt(version),
};
const cronOwner: Invocation.World = {
  name: "crons",
  services: Context.empty(),
  clock: () => cronStart,
  random: () => 0.25,
};

/**
 * Open `t` under a bound invocation of `owner`, as the call that opens the
 * backend binds the world its cron jobs draw from.
 */
const openIn = (t: KernelControls, owner: Invocation.World = cronOwner) =>
  Invocation.bind(
    {
      world: owner,
      componentPath: "",
      attempt: 1,
      request: {
        ip: null,
        userAgent: null,
        requestId: `${owner.name}-open`,
        scheduledFunctionId: null,
      },
      services: owner.services,
      startedAt: owner.clock(),
      random: owner.random,
    },
    () =>
      (
        t as unknown as {
          run: (handler: () => Promise<null>) => Promise<null>;
        }
      ).run(() => Promise.resolve(null)),
  );
const utc = (minutes: number, seconds: number) =>
  Date.UTC(2026, 0, 1, 0, minutes, seconds);

const ticks = {
  log: makeFunctionReference<"mutation", { label: string }>("ticks:log"),
  logFromAction: makeFunctionReference<"action", { label: string }>(
    "ticks:logFromAction",
  ),
  failAfterScheduling: makeFunctionReference<"mutation">(
    "ticks:failAfterScheduling",
  ),
  scheduledRows: makeFunctionReference<"query", {}, number>(
    "ticks:scheduledRows",
  ),
  missing: makeFunctionReference<"mutation">("ticks:missing"),
  scheduleMany: makeFunctionReference<"mutation", { count: number }>(
    "ticks:scheduleMany",
  ),
};

const ticksModule = {
  log: mutationGeneric({
    args: { label: v.string() },
    handler: (ctx, { label }) =>
      ctx.db.insert("marks", { label, at: Date.now() }).then(() => null),
  }),
  logFromAction: actionGeneric({
    args: { label: v.string() },
    handler: (ctx, { label }) => ctx.runMutation(ticks.log, { label }),
  }),
  failAfterScheduling: mutationGeneric({
    args: {},
    handler: async (ctx) => {
      await ctx.db.insert("marks", { label: "failed", at: Date.now() });
      await ctx.scheduler.runAfter(0, jobs.mark, { label: "orphan" });
      throw new Error("The cron's mutation failed.");
    },
  }),
  scheduleMany: mutationGeneric({
    args: { count: v.number() },
    handler: (ctx, { count }) =>
      Promise.all(
        Array.from({ length: count }, (_, i) =>
          ctx.scheduler.runAfter(60_000, jobs.mark, { label: `job ${i}` }),
        ),
      ).then(() => null),
  }),
  scheduledRows: queryGeneric({
    args: {},
    handler: (ctx) =>
      ctx.db.system
        .query("_scheduled_functions")
        .collect()
        .then((rows) => rows.length),
  }),
};

const cronControls = (
  declare: (crons: ReturnType<typeof cronJobs>) => void,
  register: Parameters<typeof world>[0] = () => {},
): KernelControls => {
  const crons = cronJobs();
  declare(crons);
  const t = convexTest({
    schema: hostSchema,
    modules: {
      ...hostModules,
      "ticks.ts": () => Promise.resolve(ticksModule),
      "crons.ts": () => Promise.resolve({ default: crons }),
    },
    runtime: cronRuntime,
  });
  register(t);
  return t;
};

const cronWorld = (
  declare: (crons: ReturnType<typeof cronJobs>) => void,
  register: Parameters<typeof world>[0] = () => {},
) =>
  Effect.promise(() => {
    const t = cronControls(declare, register);
    return openIn(t).then(() => t);
  });

// A component that declares its own cron job.
const tickerModules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "ticker.ts": () =>
    Promise.resolve({
      tick: mutationGeneric({
        args: {},
        handler: (ctx) =>
          ctx.db.insert("ticks", { at: Date.now() }).then(() => null),
      }),
      list: queryGeneric({
        args: {},
        handler: (ctx) =>
          ctx.db
            .query("ticks")
            .collect()
            .then((rows) => Arr.map(rows, ({ at }) => at)),
      }),
    }),
  "crons.ts": () => {
    const crons = cronJobs();
    crons.interval(
      "tick",
      { seconds: 20 },
      makeFunctionReference<"mutation">("ticker:tick"),
    );
    return Promise.resolve({ default: crons });
  },
};
const tickerSchema = defineSchema({ ticks: defineTable({ at: v.number() }) });
const ticker = (
  componentsGeneric() as unknown as {
    readonly ticker: {
      readonly ticker: {
        readonly list: FunctionReference<
          "query",
          "internal",
          {},
          Array<number>
        >;
      };
    };
  }
).ticker.ticker;

describe("declared cron jobs", () => {
  it.effect(
    "advance runs two crons and a scheduled job in time order, each at its own time: an interval first at once, a cron expression in the current minute after its delay",
    () =>
      Effect.gen(function* () {
        const t = yield* cronWorld((crons) => {
          crons.interval("pulse", { seconds: 45 }, ticks.log, {
            label: "pulse",
          });
          crons.cron("minutely", "* * * * *", ticks.logFromAction, {
            label: "minutely",
          });
        });
        yield* call(() =>
          t.mutation(jobs.schedule, { marks: [{ label: "job", ms: 60_000 }] }),
        );
        expect(t.crons()).toEqual([
          expect.objectContaining({ name: "pulse", nextRun: cronStart }),
          expect.objectContaining({ name: "minutely", nextRun: utc(0, 15) }),
        ]);
        yield* call(() => t.advance(130_000));
        const callResult = yield* call(() => t.query(jobs.marks, {}));
        expect(callResult).toEqual([
          { label: "pulse", at: utc(0, 10) },
          { label: "minutely", at: utc(0, 15) },
          { label: "pulse", at: utc(0, 55) },
          { label: "job", at: utc(1, 10) },
          { label: "minutely", at: utc(1, 15) },
          { label: "pulse", at: utc(1, 40) },
          { label: "minutely", at: utc(2, 15) },
        ]);
        expect(t.crons()).toEqual([
          {
            componentPath: "",
            name: "pulse",
            udfPath: "ticks:log",
            nextRun: utc(2, 25),
            last: { kind: "success" },
          },
          {
            componentPath: "",
            name: "minutely",
            udfPath: "ticks:logFromAction",
            nextRun: utc(3, 15),
            last: { kind: "success" },
          },
        ]);
      }),
  );

  it.effect(
    "a drain never runs a cron, so with the kit's self-rescheduler declared standing it ends within budget",
    () =>
      Effect.gen(function* () {
        const t = yield* cronWorld(
          (crons) =>
            crons.interval("pulse", { seconds: 1 }, ticks.log, {
              label: "pulse",
            }),
          (kit) =>
            kit.registerComponent("beat", beatSchema, beatModules, {
              standing: ["public:tick"],
            }),
        );
        yield* call(() => t.mutation(components.beat.public.start, {}));
        yield* call(() => t.finishAllScheduledFunctions());
        const callResult = yield* call(() => t.query(jobs.marks, {}));
        expect(callResult).toEqual([]);
        expect(t.crons()).toEqual([
          expect.objectContaining({ name: "pulse", nextRun: cronStart }),
        ]);
      }),
  );

  it.effect(
    "a cron whose mutation throws leaves no job row and no write, and its next run is still scheduled",
    () =>
      Effect.gen(function* () {
        const t = yield* cronWorld((crons) =>
          crons.interval("failing", { minutes: 1 }, ticks.failAfterScheduling),
        );
        yield* call(() => t.advance(0));
        const callResult = yield* call(() => t.query(ticks.scheduledRows, {}));
        expect(callResult).toBe(0);
        expect(t.jobs()).toEqual([]);
        yield* call(() => t.finishAllScheduledFunctions());
        const callResult2 = yield* call(() => t.query(jobs.marks, {}));
        expect(callResult2).toEqual([]);
        expect(t.crons()).toEqual([
          expect.objectContaining({
            name: "failing",
            nextRun: cronStart + 60_000,
            last: {
              kind: "failed",
              error: expect.stringContaining("The cron's mutation failed."),
            },
          }),
        ]);
      }),
  );

  it.effect(
    "a cron run has no identity and fresh request metadata with no scheduled function id",
    () =>
      Effect.gen(function* () {
        const t = (yield* cronWorld((crons) =>
          crons.interval("probe", { seconds: 30 }, jobs.probe, {
            label: "cron",
          }),
        )) as KernelControls & {
          withIdentity: (identity: object) => KernelControls;
        };
        yield* call(() => t.withIdentity({ subject: "ada" }).advance(30_000));
        const probes = yield* call(() => t.query(jobs.probes, {}));
        expect(probes).toEqual([
          {
            label: "cron",
            subject: null,
            ip: null,
            userAgent: null,
            requestId: expect.any(String),
            scheduledFunctionId: null,
          },
          {
            label: "cron",
            subject: null,
            ip: null,
            userAgent: null,
            requestId: expect.any(String),
            scheduledFunctionId: null,
          },
        ]);
        expect(probes[0]!["requestId"]).not.toBe(probes[1]!["requestId"]);
      }),
  );

  it.effect(
    "a cron run's commit makes a subscription that read its table stale, and refresh catches it up",
    () =>
      Effect.gen(function* () {
        const t = yield* cronWorld((crons) =>
          crons.interval("pulse", { seconds: 30 }, ticks.log, {
            label: "pulse",
          }),
        );
        const subscription = yield* call(() =>
          t.subscriber().subscribe(jobs.marks, {}),
        );
        yield* call(() => t.advance(0));
        const callResult = yield* call(() => t.refresh());
        expect(callResult).toHaveLength(1);
        expect(subscription.current().outcome).toEqual({
          _tag: "returned",
          value: [{ label: "pulse", at: cronStart }],
        });
        const callResult2 = yield* call(() => t.reference());
        expect(callResult2).toEqual([]);
      }),
  );

  it.effect(
    "a cron run's mutation is metered as any mutation: it schedules 1000 jobs, and one that schedules 1001 fails with the binary's message and leaves no row",
    () =>
      Effect.gen(function* () {
        const t = yield* cronWorld((crons) => {
          crons.interval("most", { minutes: 1 }, ticks.scheduleMany, {
            count: 1000,
          });
          crons.interval("over", { minutes: 1 }, ticks.scheduleMany, {
            count: 1001,
          });
        });
        yield* call(() => t.advance(0));
        const callResult = yield* call(() => t.query(ticks.scheduledRows, {}));
        expect(callResult).toBe(1000);
        expect(t.crons()).toEqual([
          expect.objectContaining({ name: "most", last: { kind: "success" } }),
          expect.objectContaining({
            name: "over",
            last: {
              kind: "failed",
              error: expect.stringContaining(
                "Too many functions scheduled by this mutation (limit: 1000)",
              ),
            },
          }),
        ]);
      }),
  );

  it.effect("a component's crons.ts runs in that component", () =>
    Effect.gen(function* () {
      const t = yield* cronWorld(
        () => {},
        (kit) => kit.registerComponent("ticker", tickerSchema, tickerModules),
      );
      yield* call(() => t.advance(45_000));
      const callResult = yield* call(() => t.query(ticker.list, {}));
      expect(callResult).toEqual([
        cronStart,
        cronStart + 20_000,
        cronStart + 40_000,
      ]);
      expect(t.crons()).toEqual([
        expect.objectContaining({
          componentPath: "ticker",
          name: "tick",
          udfPath: "ticker:tick",
        }),
      ]);
    }),
  );

  it.effect(
    "the backend refuses at open a cron job whose function is a query or is missing",
    () =>
      Effect.gen(function* () {
        const ofQuery = cronControls((crons) =>
          crons.interval(
            "reads",
            { seconds: 5 },
            jobs.marks as unknown as typeof ticks.log,
            { label: "reads" },
          ),
        );
        const failureResult = yield* failure(() => openIn(ofQuery));
        expect(failureResult).toMatchObject({
          _tag: "InvalidCron",
          name: "reads",
          message: expect.stringContaining(
            "schedules a query function, only actions and mutations can be scheduled",
          ),
        });
        const ofMissing = cronControls((crons) =>
          crons.interval("gone", { seconds: 5 }, ticks.missing),
        );
        const failureResult2 = yield* failure(() => openIn(ofMissing));
        expect(failureResult2).toMatchObject({
          _tag: "InvalidCron",
          message: expect.stringContaining(
            "schedules a function that does not exist: ticks:missing",
          ),
        });
      }),
  );

  it.effect(
    "a clock schedule's delay has no stream to draw from when no world is bound at open, so the backend refuses, though an interval opens",
    () =>
      Effect.gen(function* () {
        const daily = cronControls((crons) =>
          crons.daily("report", { hourUTC: 6, minuteUTC: 0 }, ticks.log, {
            label: "report",
          }),
        );
        const failureResult = yield* failure(() => daily.query(jobs.marks, {}));
        expect(failureResult).toMatchObject({
          _tag: "CronRandomUnavailable",
          name: "report",
        });
        const interval = cronControls((crons) =>
          crons.interval("pulse", { seconds: 5 }, ticks.log, {
            label: "pulse",
          }),
        );
        yield* call(() => interval.advance(0));
        const callResult = yield* call(() => interval.query(jobs.marks, {}));
        expect(callResult).toEqual([{ label: "pulse", at: cronStart }]);
      }),
  );

  it.effect(
    "a backend the driver gives a world opens with no invocation bound, and its cron delays draw from that world",
    () =>
      Effect.gen(function* () {
        const crons = cronJobs();
        crons.cron("minutely", "* * * * *", ticks.log, { label: "minutely" });
        const t: KernelControls = convexTest({
          schema: hostSchema,
          modules: {
            ...hostModules,
            "ticks.ts": () => Promise.resolve(ticksModule),
            "crons.ts": () => Promise.resolve({ default: crons }),
          },
          runtime: cronRuntime,
          world: cronOwner,
        });
        yield* call(() => t.query(jobs.marks, {}));
        expect(t.crons()).toEqual([
          expect.objectContaining({ name: "minutely", nextRun: utc(0, 15) }),
        ]);
      }),
  );

  it("two processes replaying one cron history print the same deadlines", () => {
    const loader = pathToFileURL(
      createRequire(import.meta.url).resolve("tsx/esm"),
    ).href;
    const script = fileURLToPath(
      new URL("fixtures/cronReplay.ts", import.meta.url),
    );
    const replay = () =>
      spawnSync(process.execPath, ["--import", loader, script], {
        encoding: "utf8",
      });
    const [one, two] = [replay(), replay()];
    expect([one.status, one.stderr, two.status, two.stderr]).toEqual([
      0,
      "",
      0,
      "",
    ]);
    expect(one.stdout).toBe(two.stdout);
    expect(Json.parse(one.stdout)).toMatchObject({
      crons: expect.arrayContaining([
        expect.objectContaining({ name: "hourly" }),
      ]),
    });
  }, 60_000);
});

class Mail extends Context.Service<Mail, { readonly answer: string }>()(
  "@confect/test/test/Scheduling.test/Mail",
) {}

const register = (
  functionSpec: FunctionSpec.AnyWithProps,
  handler: Handler.Any,
) => {
  const item = FunctionRegistryItem.make({
    functionSpec,
    groupMiddlewareAttachments: [],
    handler,
  });
  assert(item._tag === "Confect");
  return RegisteredConvexFunction.make(DatabaseSchema.make({}), item);
};

// What each registered job saw, cleared by each test.
const seenByJobs: Array<{
  readonly mail: string | null;
  readonly scheduledFunctionId: string | null | undefined;
}> = [];

const timedByJobs: Array<{ readonly now: number; readonly random: number }> =
  [];

const bridged = {
  schedule: makeFunctionReference<"mutation", {}, Job>("bridge:schedule"),
  scheduleTimed: makeFunctionReference<"mutation", {}, number>(
    "bridge:scheduleTimed",
  ),
  timedJob: makeFunctionReference<"mutation">("bridge:timedJob"),
  job: makeFunctionReference<"mutation">("bridge:job"),
  scheduleFromAction: makeFunctionReference<"action", {}, Job>(
    "bridge:scheduleFromAction",
  ),
  actionJob: makeFunctionReference<"action">("bridge:actionJob"),
};

const recordJob = Effect.gen(function* () {
  const mail = yield* Effect.serviceOption(Mail);
  seenByJobs.push({
    mail: Option.match(mail, {
      onNone: () => null,
      onSome: ({ answer }) => answer,
    }),
    scheduledFunctionId: Invocation.current()?.request.scheduledFunctionId,
  });
  return null;
});

const bridgeModules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "bridge.ts": () =>
    Promise.resolve({
      schedule: register(
        FunctionSpec.publicMutation({
          name: "schedule",
          args: () => ({}),
          returns: () => Schema.String,
        }),
        () =>
          Effect.gen(function* () {
            const ctx = yield* MutationCtx.MutationCtx<GenericDataModel>();
            return yield* Effect.promise(() =>
              ctx.scheduler.runAfter(0, bridged.job, {}),
            );
          }),
      ),
      scheduleTimed: register(
        FunctionSpec.publicMutation({
          name: "scheduleTimed",
          args: () => ({}),
          returns: () => Schema.Finite,
        }),
        () =>
          Effect.gen(function* () {
            const ctx = yield* MutationCtx.MutationCtx<GenericDataModel>();
            yield* Effect.promise(() =>
              ctx.scheduler.runAfter(500, bridged.timedJob, {}),
            );
            // oxlint-disable-next-line effecttsgo/global-date-in-effect -- The handler reads the ambient Date that `runAfter` reads.
            return Date.now();
          }),
      ),
      timedJob: register(
        FunctionSpec.internalMutation({
          name: "timedJob",
          args: () => ({}),
          returns: () => Schema.Null,
        }),
        () =>
          Effect.sync(() => {
            // oxlint-disable-next-line effecttsgo/global-date-in-effect, effecttsgo/global-random-in-effect -- The job reads the ambient Date and Math.random the bridge pins.
            timedByJobs.push({ now: Date.now(), random: Math.random() });
            return null;
          }),
      ),
      job: register(
        FunctionSpec.internalMutation({
          name: "job",
          args: () => ({}),
          returns: () => Schema.Null,
        }),
        () => recordJob,
      ),
      scheduleFromAction: register(
        FunctionSpec.publicAction({
          name: "scheduleFromAction",
          args: () => ({}),
          returns: () => Schema.String,
        }),
        () =>
          Effect.gen(function* () {
            const ctx = yield* ActionCtx.ActionCtx<GenericDataModel>();
            return yield* Effect.promise(() =>
              ctx.scheduler.runAfter(0, bridged.actionJob, {}),
            );
          }),
      ),
      actionJob: register(
        FunctionSpec.internalAction({
          name: "actionJob",
          args: () => ({}),
          returns: () => Schema.Null,
        }),
        () => recordJob,
      ),
    }),
};

const worldNamed = (name: string): Invocation.World => ({
  name,
  services: Context.make(Mail, { answer: `${name} mail` }),
  clock: () => 0,
  random: () => 0.5,
});

const invocationIn = (
  owner: Invocation.World,
  services = owner.services,
): Invocation.Invocation => ({
  world: owner,
  componentPath: "",
  attempt: 1,
  request: {
    ip: null,
    userAgent: null,
    requestId: `${owner.name}-request`,
    scheduledFunctionId: null,
  },
  services,
  startedAt: owner.clock(),
  random: owner.random,
});

describe("registered handlers", () => {
  // The caller's own services differ from its world's, so a job that reused
  // the caller's invocation would see the caller's mail.
  const asCallerIn = <A>(owner: Invocation.World, run: () => Promise<A>) =>
    Invocation.bind(
      invocationIn(owner, Context.make(Mail, { answer: "caller mail" })),
      run,
    );
  const scheduleIn = (t: KernelControls, owner: Invocation.World) =>
    asCallerIn(owner, () => t.mutation(bridged.schedule, {}));

  it.effect(
    "a job a bound mutation schedules runs as a fresh invocation of its world, though the drain runs unbound",
    () =>
      Effect.gen(function* () {
        seenByJobs.length = 0;
        const t = convexTest({ modules: bridgeModules, runtime });
        const id = yield* call(() => scheduleIn(t, worldNamed("owner")));
        yield* call(() => t.finishAllScheduledFunctions());
        expect(seenByJobs).toEqual([
          { mail: "owner mail", scheduledFunctionId: id },
        ]);
      }),
  );

  it.effect(
    "a bound mutation and its job read the kernel's clock, whatever start time the invocation carries, so the job runs at its deadline",
    () =>
      Effect.gen(function* () {
        timedByJobs.length = 0;
        const t: KernelControls = convexTest({
          modules: bridgeModules,
          runtime,
        });
        const owner = worldNamed("owner");
        const now = yield* call(() =>
          asCallerIn(owner, () => t.mutation(bridged.scheduleTimed, {})),
        );
        expect(now).toBe(start);
        expect(Arr.map(t.jobs(), (job) => job.scheduledTime)).toEqual([
          start + 500,
        ]);
        yield* call(() => t.advance(499));
        expect(timedByJobs).toEqual([]);
        yield* call(() => t.advance(1));
        expect(timedByJobs).toEqual([{ now: start + 500, random: 0.5 }]);
      }),
  );

  it.effect(
    "a drain bound to another world still runs each job in the world that scheduled it",
    () =>
      Effect.gen(function* () {
        seenByJobs.length = 0;
        const t = convexTest({ modules: bridgeModules, runtime });
        const id = yield* call(() => scheduleIn(t, worldNamed("owner")));
        yield* call(() =>
          Invocation.bind(invocationIn(worldNamed("other")), () =>
            t.finishAllScheduledFunctions(),
          ),
        );
        expect(seenByJobs).toEqual([
          { mail: "owner mail", scheduledFunctionId: id },
        ]);
      }),
  );

  it.effect(
    "an action job a bound action schedules runs as a fresh invocation of its world",
    () =>
      Effect.gen(function* () {
        seenByJobs.length = 0;
        const t = convexTest({ modules: bridgeModules, runtime });
        const id = yield* call(() =>
          asCallerIn(worldNamed("owner"), () =>
            t.action(bridged.scheduleFromAction, {}),
          ),
        );
        yield* call(() =>
          Invocation.bind(invocationIn(worldNamed("other")), () =>
            t.finishAllScheduledFunctions(),
          ),
        );
        expect(seenByJobs).toEqual([
          { mail: "owner mail", scheduledFunctionId: id },
        ]);
      }),
  );

  it.effect(
    "a job scheduled with no invocation bound keeps the production runtime under a bound drain",
    () =>
      Effect.gen(function* () {
        seenByJobs.length = 0;
        const t = convexTest({ modules: bridgeModules, runtime });
        yield* call(() => t.mutation(bridged.schedule, {}));
        yield* call(() =>
          Invocation.bind(invocationIn(worldNamed("other")), () =>
            t.finishAllScheduledFunctions(),
          ),
        );
        expect(seenByJobs).toEqual([
          { mail: null, scheduledFunctionId: undefined },
        ]);
      }),
  );

  it.effect(
    "a cron run starts as a fresh invocation of the world bound when the backend opened, whatever world advance runs under",
    () =>
      Effect.gen(function* () {
        seenByJobs.length = 0;
        const crons = cronJobs();
        crons.interval("record", { seconds: 10 }, bridged.job);
        const modules = {
          ...bridgeModules,
          "crons.ts": () => Promise.resolve({ default: crons }),
        };
        const bound = convexTest({ modules, runtime });
        yield* call(() =>
          Invocation.bind(invocationIn(worldNamed("owner")), () =>
            bound.run(() => Promise.resolve(null)),
          ),
        );
        yield* call(() =>
          Invocation.bind(invocationIn(worldNamed("other")), () =>
            bound.advance(0),
          ),
        );
        const unbound = convexTest({ modules, runtime });
        yield* call(() =>
          Invocation.bind(invocationIn(worldNamed("other")), () =>
            unbound.advance(0),
          ),
        );
        expect(seenByJobs).toEqual([
          { mail: "owner mail", scheduledFunctionId: null },
          { mail: null, scheduledFunctionId: undefined },
        ]);
      }),
  );
});
