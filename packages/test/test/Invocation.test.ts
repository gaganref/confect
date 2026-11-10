import * as FunctionSpec from "@confect/core/FunctionSpec";
import * as ActionCtx from "@confect/server/ActionCtx";
import * as DatabaseSchema from "@confect/server/DatabaseSchema";
import * as FunctionRegistryItem from "@confect/server/FunctionRegistryItem";
import type * as Handler from "@confect/server/Handler";
import * as MutationCtx from "@confect/server/MutationCtx";
import * as RegisteredConvexFunction from "@confect/server/RegisteredConvexFunction";
import { assert, describe, expect, it } from "@effect/vitest";
import { convexTest } from "convex-test";
import { type GenericDataModel, makeFunctionReference } from "convex/server";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Invocation from "../src/internal/Invocation";

class Mail extends Context.Service<Mail, { readonly answer: string }>()(
  "@confect/test/test/Invocation.test/Mail",
) {}

class Gate extends Context.Service<
  Gate,
  { readonly arrive: Effect.Effect<void> }
>()("@confect/test/test/Invocation.test/Gate") {}

type Job = {
  readonly mail: string | null;
  readonly request: Invocation.Invocation["request"] | undefined;
};

class Jobs extends Context.Service<
  Jobs,
  { readonly record: (job: Job) => void }
>()("@confect/test/test/Invocation.test/Jobs") {}

const database = DatabaseSchema.make({});

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
  return RegisteredConvexFunction.make(database, item);
};

// Handlers read test services optionally, so a handler that receives none
// answers null instead of dying.
const mail = Effect.serviceOption(Mail).pipe(
  Effect.map(Option.match({ onNone: () => null, onSome: (m) => m.answer })),
);

const Seen = Schema.Struct({
  now: Schema.Finite,
  random: Schema.Finite,
  mail: Schema.NullOr(Schema.String),
  subject: Schema.NullOr(Schema.String),
});

const look = Effect.gen(function* () {
  const ctx = yield* ActionCtx.ActionCtx<GenericDataModel>();
  const identity = yield* Effect.promise(() => ctx.auth.getUserIdentity());
  return {
    now: yield* Effect.clockWith((clock) => clock.currentTimeMillis),
    random: yield* Random.next,
    mail: yield* mail,
    subject: identity?.subject ?? null,
  };
});

const probe = makeFunctionReference<"query">("bridge:probe");
const observe = makeFunctionReference<"action">("bridge:observe");
const schedule = makeFunctionReference<"mutation">("bridge:schedule");
const job = makeFunctionReference<"mutation">("bridge:job");

const bridgeModule = {
  probe: register(
    FunctionSpec.internalQuery({
      name: "probe",
      args: () => ({}),
      returns: () => Schema.NullOr(Schema.String),
    }),
    () => mail,
  ),
  observe: register(
    FunctionSpec.publicAction({
      name: "observe",
      args: () => ({}),
      returns: () =>
        Schema.Struct({
          before: Seen,
          after: Seen,
          nested: Schema.NullOr(Schema.String),
        }),
    }),
    () =>
      Effect.gen(function* () {
        const before = yield* look;
        const gate = yield* Effect.serviceOption(Gate);
        if (Option.isSome(gate)) yield* gate.value.arrive;
        const after = yield* look;
        const ctx = yield* ActionCtx.ActionCtx<GenericDataModel>();
        const nested = yield* Effect.promise(() => ctx.runQuery(probe));
        return { before, after, nested };
      }),
  ),
  schedule: register(
    FunctionSpec.publicMutation({
      name: "schedule",
      args: () => ({}),
      returns: () => Schema.String,
    }),
    () =>
      Effect.gen(function* () {
        const ctx = yield* MutationCtx.MutationCtx<GenericDataModel>();
        return yield* Effect.promise(() => ctx.scheduler.runAfter(0, job, {}));
      }),
  ),
  job: register(
    FunctionSpec.internalMutation({
      name: "job",
      args: () => ({}),
      returns: () => Schema.Null,
    }),
    () =>
      Effect.gen(function* () {
        const jobs = yield* Effect.serviceOption(Jobs);
        const seen = {
          mail: yield* mail,
          request: Invocation.current()?.request,
        };
        if (Option.isSome(jobs)) jobs.value.record(seen);
        return null;
      }),
  ),
};

const backend = () =>
  convexTest(undefined, {
    "/bridge/_generated/api.js": () => Promise.resolve({}),
    "/bridge/bridge.ts": () => Promise.resolve(bridgeModule),
  });

const fixedClock = (millis: number): Clock.Clock => ({
  currentTimeMillisUnsafe: () => millis,
  currentTimeMillis: Effect.succeed(millis),
  currentTimeNanosUnsafe: () => BigInt(millis) * 1_000_000n,
  currentTimeNanos: Effect.succeed(BigInt(millis) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => BigInt(millis) * 1_000_000n,
  monotonicTimeNanos: Effect.succeed(BigInt(millis) * 1_000_000n),
  sleep: () => Effect.void,
});

const seeded = (seed: string) =>
  Effect.runSync(Random.withSeed(Effect.service(Random.Random), seed));

const draws = (seed: string) =>
  Effect.runSync(Random.withSeed(Effect.all([Random.next, Random.next]), seed));

/**
 * Resolves every arrival once `parties` handlers have arrived.
 */
const rendezvous = (parties: number): Gate["Service"] => {
  let waiting = parties;
  const everyone = Promise.withResolvers<void>();
  return {
    arrive: Effect.promise(() => {
      waiting -= 1;
      if (waiting === 0) everyone.resolve();
      return everyone.promise;
    }),
  };
};

const request = (requestId: string) => ({
  ip: null,
  userAgent: null,
  requestId,
  scheduledFunctionId: null,
});

const invocationIn = (
  world: Invocation.World,
  services = world.services,
): Invocation.Invocation => ({
  world,
  componentPath: "",
  attempt: 1,
  request: request(`${world.name}-request`),
  services,
});

describe("bind", () => {
  it.effect(
    "two overlapping handlers each see their own invocation's clock, random stream, identity and provider",
    () =>
      Effect.gen(function* () {
        const gate = rendezvous(2);
        const worldOf = (name: string, millis: number) => ({
          name,
          services: Context.make(Mail, { answer: `${name} mail` }).pipe(
            Context.add(Gate, gate),
            Context.add(Random.Random, seeded(name)),
            Context.add(Clock.Clock, fixedClock(millis)),
          ),
        });
        const ada = worldOf("ada", 1_000);
        const grace = worldOf("grace", 2_000);
        const [adaSeen, graceSeen] = yield* Effect.promise(() =>
          Promise.all([
            Invocation.bind(invocationIn(ada), () =>
              backend().withIdentity({ subject: "ada" }).action(observe, {}),
            ),
            Invocation.bind(invocationIn(grace), () =>
              backend().withIdentity({ subject: "grace" }).action(observe, {}),
            ),
          ]),
        );
        const expected = (name: string, now: number) => {
          const [first, second] = draws(name);
          const seen = { now, mail: `${name} mail`, subject: name };
          return {
            before: { ...seen, random: first },
            after: { ...seen, random: second },
            nested: `${name} mail`,
          };
        };
        expect(adaSeen).toEqual(expected("ada", 1_000));
        expect(graceSeen).toEqual(expected("grace", 2_000));
      }),
  );

  it.effect(
    "a handler outside any bound invocation keeps the production runtime",
    () =>
      Effect.gen(function* () {
        const seen = yield* Effect.promise(() => backend().query(probe, {}));
        expect(seen).toBeNull();
      }),
  );

  it.effect(
    "a job a bound mutation schedules runs as its own request with its world's services",
    () =>
      Effect.gen(function* () {
        const recorded: Array<Job> = [];
        const jobs = { record: (seen: Job) => recorded.push(seen) };
        const world = {
          name: "world",
          services: Context.make(Mail, { answer: "world mail" }).pipe(
            Context.add(Jobs, jobs),
          ),
        };
        const caller = invocationIn(
          world,
          Context.make(Mail, { answer: "caller mail" }).pipe(
            Context.add(Jobs, jobs),
          ),
        );
        const t = backend();
        const jobId = yield* Effect.promise(() =>
          Invocation.bind(caller, () => t.mutation(schedule, {})),
        );
        // Real timers, so the job inherits the async context of the caller
        // that scheduled it, as it does outside fake timers.
        yield* Effect.promise(() => t.finishAllScheduledFunctions(() => {}));
        expect(recorded).toEqual([
          {
            mail: "world mail",
            request: {
              ip: null,
              userAgent: null,
              requestId: expect.not.stringMatching(caller.request.requestId),
              scheduledFunctionId: jobId,
            },
          },
        ]);
      }),
  );
});
