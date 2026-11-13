// oxlint-disable effecttsgo/global-date, effecttsgo/global-date-in-effect, effecttsgo/global-random, effecttsgo/global-random-in-effect -- These tests read the ambient Date, Math.random and crypto that the bridge pins for each handler.
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
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Invocation from "../src/internal/Invocation";
import * as Arr from "effect/Array";

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
  readonly now: number;
  readonly random: number;
};

class Jobs extends Context.Service<
  Jobs,
  { readonly record: (job: Job) => void }
>()("@confect/test/test/Invocation.test/Jobs") {}

const database = DatabaseSchema.make({});

const testInvocation = Symbol.for("@confect/test/Invocation");

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

/**
 * What a handler reads from its ambient globals. Each read happens inside the
 * handler, through the globals its runtime gives it.
 */
const ambient = () => ({
  now: Date.now(),
  dated: new Date().getTime(),
  random: Math.random(),
  bytes: Array.from(crypto.getRandomValues(new Uint8Array(4))),
});

const Ambient = Schema.Struct({
  now: Schema.Finite,
  dated: Schema.Finite,
  random: Schema.Finite,
  bytes: Schema.Array(Schema.Finite),
});

const errorName = (call: () => unknown) => {
  try {
    call();
    return null;
  } catch (error) {
    return error instanceof Error ? error.name : String(error);
  }
};

/**
 * The parts of `Date` and `crypto` a pinned handler must answer as the host
 * does. Only `Date()` reads the time, so it alone differs from the host's.
 */
const contract = () => {
  const words = new Uint32Array(2);
  return {
    fixed: new Date(86_400_000).toISOString(),
    local: new Date(2000, 0, 2, 3, 4, 5).getTime(),
    utc: Date.UTC(2000, 0, 1),
    parsed: Date.parse("2000-01-01T00:00:00.000Z"),
    called: Date(),
    instance: new Date() instanceof Date,
    same: crypto.getRandomValues(words) === words,
    full: crypto.getRandomValues(new Uint8Array(65_536)).length,
    quota: errorName(() => crypto.getRandomValues(new Uint8Array(65_537))),
    float: errorName(() => crypto.getRandomValues(new Float64Array(1))),
    detached: errorName(() => {
      // oxlint-disable-next-line typescript/unbound-method -- Called detached on purpose, as production code could.
      const getRandomValues = crypto.getRandomValues;
      return getRandomValues(new Uint8Array(1));
    }),
    rebound: errorName(() =>
      crypto.getRandomValues.call({}, new Uint8Array(1)),
    ),
    digest: typeof crypto.subtle.digest,
    wide: Array.from(new Uint8Array(words.buffer)),
  };
};

const Contract = Schema.Struct({
  fixed: Schema.String,
  local: Schema.Finite,
  utc: Schema.Finite,
  parsed: Schema.Finite,
  called: Schema.String,
  instance: Schema.Boolean,
  same: Schema.Boolean,
  full: Schema.Finite,
  quota: Schema.NullOr(Schema.String),
  float: Schema.NullOr(Schema.String),
  detached: Schema.NullOr(Schema.String),
  rebound: Schema.NullOr(Schema.String),
  digest: Schema.String,
  wide: Schema.Array(Schema.Finite),
});

const original = {
  Date: globalThis.Date,
  now: globalThis.Date.now,
  Math: globalThis.Math,
  random: globalThis.Math.random,
  crypto: globalThis.crypto,
  // oxlint-disable-next-line typescript/unbound-method -- Compared by identity, never called.
  getRandomValues: globalThis.crypto.getRandomValues,
};

/**
 * Whether test code, outside every handler, still sees the host's own globals,
 * each an unmodified object.
 */
const hostKept = () => ({
  Date: globalThis.Date === original.Date && Date.now === original.now,
  Math: globalThis.Math === original.Math && Math.random === original.random,
  crypto:
    globalThis.crypto === original.crypto &&
    crypto.getRandomValues === original.getRandomValues,
});

const kept = { Date: true, Math: true, crypto: true };

const clockMillis = Effect.clockWith((clock) => clock.currentTimeMillis);

const Seen = Schema.Struct({
  ...Ambient.fields,
  clock: Schema.Finite,
  effectRandom: Schema.Finite,
  mail: Schema.NullOr(Schema.String),
  subject: Schema.NullOr(Schema.String),
});

const Probed = Schema.Struct({
  ...Ambient.fields,
  clock: Schema.Finite,
  unsafe: Schema.Finite,
  mail: Schema.NullOr(Schema.String),
});

const Stamped = Schema.Struct({
  ...Ambient.fields,
  clock: Schema.Finite,
});

// The handlers' services carry no `Random` and no `Clock`, so Effect's defaults
// read the ambient globals, as they do in a door-built handler.
const look = Effect.gen(function* () {
  const ctx = yield* ActionCtx.ActionCtx<GenericDataModel>();
  const identity = yield* Effect.promise(() => ctx.auth.getUserIdentity());
  return {
    ...ambient(),
    clock: yield* clockMillis,
    effectRandom: yield* Random.next,
    mail: yield* mail,
    subject: identity?.subject ?? null,
  };
});

const probe = makeFunctionReference<"query">("bridge:probe");
const stamp = makeFunctionReference<"mutation">("bridge:stamp");
const observe = makeFunctionReference<"action">("bridge:observe");
const schedule = makeFunctionReference<"mutation">("bridge:schedule");
const job = makeFunctionReference<"mutation">("bridge:job");
const keeps = makeFunctionReference<"action">("bridge:keeps");
const fails = makeFunctionReference<"action">("bridge:fails");
const holds = makeFunctionReference<"mutation">("bridge:holds");
const drives = makeFunctionReference<"action">("bridge:drives");

/**
 * The time a handler reads three ways: `Date.now()`, `new Date()` and Effect's
 * default `Clock`.
 */
const readTime = Effect.gen(function* () {
  return [Date.now(), new Date().getTime(), yield* clockMillis];
});

const Times = Schema.Array(Schema.Finite);

// Arrives at the world's gate, if it has one, which may move the world's clock.
const arrive = Effect.serviceOption(Gate).pipe(
  Effect.flatMap(
    Option.match({ onNone: () => Effect.void, onSome: (g) => g.arrive }),
  ),
);

const bridgeModule = {
  probe: register(
    FunctionSpec.internalQuery({
      name: "probe",
      args: () => ({}),
      returns: () => Probed,
    }),
    () =>
      Effect.gen(function* () {
        return {
          ...ambient(),
          // The query base's clock: tracked effectful reads, untracked
          // constant unsafe reads.
          clock: yield* clockMillis,
          unsafe: yield* Effect.clockWith((clock) =>
            Effect.succeed(clock.currentTimeMillisUnsafe()),
          ),
          mail: yield* mail,
        };
      }),
  ),
  stamp: register(
    FunctionSpec.internalMutation({
      name: "stamp",
      args: () => ({}),
      returns: () => Stamped,
    }),
    () =>
      Effect.gen(function* () {
        return { ...ambient(), clock: yield* clockMillis };
      }),
  ),
  observe: register(
    FunctionSpec.publicAction({
      name: "observe",
      args: () => ({}),
      returns: () =>
        Schema.Struct({
          before: Seen,
          after: Seen,
          nested: Probed,
          stamped: Stamped,
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
        const stamped = yield* Effect.promise(() => ctx.runMutation(stamp));
        return { before, after, nested, stamped };
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
          now: Date.now(),
          random: Math.random(),
        };
        if (Option.isSome(jobs)) jobs.value.record(seen);
        return null;
      }),
  ),
  keeps: register(
    FunctionSpec.publicAction({
      name: "keeps",
      args: () => ({}),
      returns: () => Contract,
    }),
    () => Effect.sync(contract),
  ),
  fails: register(
    FunctionSpec.publicAction({
      name: "fails",
      args: () => ({}),
      returns: () => Schema.Null,
    }),
    () =>
      Effect.sync(ambient).pipe(
        Effect.andThen(Effect.die(new Error("the handler fails"))),
      ),
  ),
  holds: register(
    FunctionSpec.internalMutation({
      name: "holds",
      args: () => ({}),
      returns: () => Schema.Struct({ before: Times, after: Times }),
    }),
    () =>
      Effect.gen(function* () {
        const before = yield* readTime;
        yield* arrive;
        return { before, after: yield* readTime };
      }),
  ),
  drives: register(
    FunctionSpec.publicAction({
      name: "drives",
      args: () => ({}),
      returns: () =>
        Schema.Struct({
          before: Times,
          after: Times,
          held: Schema.Struct({ before: Times, after: Times }),
          last: Times,
        }),
    }),
    () =>
      Effect.gen(function* () {
        const before = yield* readTime;
        yield* arrive;
        const after = yield* readTime;
        const ctx = yield* ActionCtx.ActionCtx<GenericDataModel>();
        const held = yield* Effect.promise(() => ctx.runMutation(holds));
        return { before, after, held, last: yield* readTime };
      }),
  ),
};

const backend = () =>
  convexTest(undefined, {
    "/bridge/_generated/api.js": () => Promise.resolve({}),
    "/bridge/bridge.ts": () => Promise.resolve(bridgeModule),
  });

/**
 * A deterministic stream on [low, low + 0.25), so a draw shows whose stream it
 * came from.
 */
const stream = (low: number) => {
  let state = 1;
  return () => {
    state = (state * 48_271) % 2_147_483_647;
    return low + (state / 2_147_483_647) * 0.25;
  };
};

const inBand = (low: number) => (value: number) =>
  value >= low && value < low + 0.25;

const byteInBand = (low: number) => (value: number) =>
  value >= low * 256 && value < (low + 0.25) * 256;

/**
 * Resolves every arrival once `parties` handlers have arrived. `released`
 * resolves then too, in the async context of whoever awaits it.
 */
const rendezvous = (
  parties: number,
): Gate["Service"] & { readonly released: Promise<void> } => {
  let waiting = parties;
  const everyone = Promise.withResolvers<void>();
  return {
    arrive: Effect.promise(() => {
      waiting -= 1;
      if (waiting === 0) everyone.resolve();
      return everyone.promise;
    }),
    released: everyone.promise,
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
  overrides: Partial<
    Pick<Invocation.Invocation, "services" | "startedAt" | "random">
  > = {},
): Invocation.Invocation => ({
  world,
  componentPath: "",
  attempt: 1,
  request: request(`${world.name}-request`),
  services: world.services,
  startedAt: world.clock(),
  random: world.random,
  ...overrides,
});

describe("bind", () => {
  it.effect(
    "two overlapping handlers each see their own invocation's time, random stream, identity and provider, and replay",
    () =>
      Effect.gen(function* () {
        const overlap = () => {
          const gate = rendezvous(2);
          const worldOf = (name: string, millis: number, low: number) => ({
            name,
            services: Context.make(Mail, { answer: `${name} mail` }).pipe(
              Context.add(Gate, gate),
            ),
            clock: () => millis,
            random: stream(low),
          });
          const run = (world: Invocation.World) =>
            Invocation.bind(invocationIn(world), () =>
              backend()
                .withIdentity({ subject: world.name })
                .action(observe, {}),
            );
          return Promise.all([
            run(worldOf("ada", 1_000_000, 0)),
            run(worldOf("grace", 2_000_000, 0.75)),
            // Test code reads its globals while both handlers wait, pinned.
            gate.released.then(hostKept),
          ]);
        };
        const [adaSeen, graceSeen, meanwhile] = yield* Effect.promise(overlap);
        expect(meanwhile).toEqual(kept);
        const check = (
          seen: typeof adaSeen,
          name: string,
          millis: number,
          low: number,
        ) => {
          const { before, after, nested, stamped } = seen;
          const times = Arr.flatMap(
            [before, after, nested, stamped],
            (read) => [read.now, read.dated, read.clock],
          );
          expect(times).toEqual(Arr.map(times, () => millis));
          const draws = [
            before.random,
            before.effectRandom,
            after.random,
            after.effectRandom,
            nested.random,
            stamped.random,
          ];
          expect(Arr.filter(draws, inBand(low))).toEqual(draws);
          const bytes = Arr.flatMap(
            [before, after, nested, stamped],
            (read): ReadonlyArray<number> => read.bytes,
          );
          expect(Arr.filter(bytes, byteInBand(low))).toEqual(bytes);
          expect(nested.unsafe).toBe(0);
          expect([before.mail, after.mail, nested.mail]).toEqual([
            `${name} mail`,
            `${name} mail`,
            `${name} mail`,
          ]);
          expect([before.subject, after.subject]).toEqual([name, name]);
        };
        check(adaSeen, "ada", 1_000_000, 0);
        check(graceSeen, "grace", 2_000_000, 0.75);
        expect(yield* Effect.promise(overlap)).toEqual([
          adaSeen,
          graceSeen,
          kept,
        ]);
        expect(hostKept()).toEqual(kept);
      }),
  );

  /**
   * A world whose gate moves its clock on by a million milliseconds at each
   * arrival, as a test driver advancing time while a handler waits.
   */
  const moving = (name: string) => {
    let now = 1_000_000;
    return {
      name,
      services: Context.make(Gate, {
        arrive: Effect.sync(() => {
          now += 1_000_000;
        }),
      }),
      clock: () => now,
      random: stream(0),
    };
  };

  const at = (millis: number) => [millis, millis, millis];

  it.effect(
    "a bound action's Date follows its world's clock, and a query or mutation it calls starts at the action's time then",
    () =>
      Effect.gen(function* () {
        const world = moving("moving");
        const seen = yield* Effect.promise(() =>
          Invocation.bind(invocationIn(world), () =>
            backend().action(observe, {}),
          ),
        );
        const read = (r: { now: number; dated: number; clock: number }) => [
          r.now,
          r.dated,
          r.clock,
        ];
        expect({
          before: read(seen.before),
          after: read(seen.after),
          query: read(seen.nested),
          mutation: read(seen.stamped),
        }).toEqual({
          before: at(1_000_000),
          after: at(2_000_000),
          query: at(2_000_000),
          mutation: at(2_000_000),
        });
      }),
  );

  it.effect(
    "a mutation a bound action calls keeps its own start time while the world's clock moves on, and the action sees the clock moved",
    () =>
      Effect.gen(function* () {
        const world = moving("moving");
        const seen = yield* Effect.promise(() =>
          Invocation.bind(invocationIn(world), () =>
            backend().action(drives, {}),
          ),
        );
        expect(seen).toEqual({
          before: at(1_000_000),
          after: at(2_000_000),
          held: { before: at(2_000_000), after: at(2_000_000) },
          last: at(3_000_000),
        });
        // A bound mutation the test calls directly keeps its invocation's
        // start time through its run too.
        const direct = yield* Effect.promise(() =>
          Invocation.bind(invocationIn(world, { startedAt: 500_000 }), () =>
            backend().mutation(holds, {}),
          ),
        );
        expect(direct).toEqual({ before: at(500_000), after: at(500_000) });
        expect(world.clock()).toBe(4_000_000);
      }),
  );

  it.effect(
    "a bound handler's Date and crypto keep the host's contract, apart from the pinned time and stream",
    () =>
      Effect.gen(function* () {
        const world = {
          name: "world",
          services: Context.empty(),
          clock: () => 3_000_000,
          random: stream(0.25),
        };
        const seen = yield* Effect.promise(() =>
          Invocation.bind(invocationIn(world), () =>
            backend().action(keeps, {}),
          ),
        );
        const { wide, ...rest } = seen;
        const { wide: _hostWide, ...hosted } = contract();
        expect(rest).toEqual({
          ...hosted,
          called: new Date(3_000_000).toString(),
        });
        expect(rest.same).toBe(true);
        expect(rest.quota).not.toBeNull();
        expect(rest.float).not.toBeNull();
        expect(rest.detached).not.toBeNull();
        expect(rest.rebound).not.toBeNull();
        expect(wide.filter(byteInBand(0.25))).toEqual(wide);
      }),
  );

  it.effect(
    "a bound handler that fails leaves test code the host's Date, Math and crypto",
    () =>
      Effect.gen(function* () {
        const world = {
          name: "world",
          services: Context.empty(),
          clock: () => 4_000_000,
          random: stream(0.5),
        };
        const failure = yield* Effect.promise(() =>
          Invocation.bind(invocationIn(world), () =>
            backend().action(fails, {}),
          ).then(
            () => null,
            (error: unknown) => String(error),
          ),
        );
        expect(failure).toContain("the handler fails");
        expect(hostKept()).toEqual(kept);
        expect(Date.now()).toBeGreaterThan(4_000_000);
      }),
  );

  it.effect(
    "a bound handler without convex-test's per-handler globals refuses before it runs and leaves the host's",
    () =>
      Effect.gen(function* () {
        const world = {
          name: "world",
          services: Context.empty(),
          clock: () => 6_000_000,
          random: stream(0),
        };
        let ran = false;
        const outcome = yield* Effect.promise(() =>
          Invocation.bind(invocationIn(world), () => {
            // What `runHandlerPromise` reaches, called from test code, where
            // no convex-test handler gives the call its own globals.
            const bridge = (
              globalThis as {
                readonly [testInvocation]?: {
                  readonly start: (
                    meta: {
                      readonly getFunctionMetadata: () => Promise<{
                        readonly name: string;
                        readonly componentPath: string;
                      }>;
                    },
                    run: () => Promise<void>,
                    functionType: "query",
                  ) => Promise<void> | undefined;
                };
              }
            )[testInvocation];
            const started = bridge?.start(
              {
                getFunctionMetadata: () =>
                  Promise.resolve({ name: "bridge:probe", componentPath: "" }),
              },
              () => {
                ran = true;
                return Promise.resolve();
              },
              "query",
            );
            return (started ?? Promise.resolve()).then(
              () => ({ refused: null, kept: hostKept() }),
              (error: unknown) => ({
                refused: String(error),
                kept: hostKept(),
              }),
            );
          }).finally(() => {
            // Undo a pin that reached test code, so the suite's later tests
            // keep the host's globals. Node's `crypto` cannot be assigned
            // here, so a pin never reaches it.
            if (globalThis.Date !== original.Date)
              globalThis.Date = original.Date;
            if (globalThis.Math !== original.Math)
              globalThis.Math = original.Math;
          }),
        );
        expect(outcome).toEqual({
          refused: expect.stringContaining("cannot pin"),
          kept,
        });
        expect(ran).toBe(false);
      }),
  );

  it.effect(
    "a handler outside any bound invocation keeps the production runtime",
    () =>
      Effect.gen(function* () {
        const host = Date.now();
        const seen = yield* Effect.promise(() => backend().query(probe, {}));
        expect(seen.mail).toBeNull();
        expect(seen.now).toBeGreaterThanOrEqual(host);
        expect(seen.now).toBeLessThanOrEqual(Date.now());
        expect(seen.unsafe).toBe(0);
      }),
  );

  it.effect(
    "a job a bound mutation schedules runs as its own request with its world's services, clock and random stream",
    () =>
      Effect.gen(function* () {
        const recorded: Array<Job> = [];
        const jobs = { record: (seen: Job) => recorded.push(seen) };
        const world = {
          name: "world",
          services: Context.make(Mail, { answer: "world mail" }).pipe(
            Context.add(Jobs, jobs),
          ),
          clock: () => 5_000_000,
          random: stream(0.5),
        };
        const caller = invocationIn(world, {
          services: Context.make(Mail, { answer: "caller mail" }).pipe(
            Context.add(Jobs, jobs),
          ),
          startedAt: 1_000_000,
          random: stream(0),
        });
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
            now: 5_000_000,
            // The first draw of the world's stream, which nothing else read.
            random: stream(0.5)(),
          },
        ]);
      }),
  );
});
