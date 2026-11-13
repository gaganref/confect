// oxlint-disable effecttsgo/global-date -- The fixture's mutation reads the pinned `Date` as product code does.
// One cron history on the test kernel, printed as bytes. `Scheduling.test.ts`
// runs this file in two processes and compares their output. Every random
// value comes from the bound world's stream, a fixed generator here.
import {
  cronJobs,
  defineSchema,
  defineTable,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { convexTest, type KernelControls } from "../../src/internal/ConvexTest";
import * as Invocation from "../../src/internal/Invocation";
import * as Array from "effect/Array";

const schema = defineSchema({
  ticks: defineTable({ name: v.string(), at: v.number() }),
});

const tick = makeFunctionReference<"mutation", { name: string }>("cron:tick");

const crons = cronJobs();
crons.interval("interval", { minutes: 10 }, tick, { name: "interval" });
crons.hourly("hourly", {}, tick, { name: "hourly" });
crons.hourly("pinned", { minuteUTC: 7 }, tick, { name: "pinned" });
crons.daily("daily", { hourUTC: 3 }, tick, { name: "daily" });
crons.cron("expression", "*/13 * * * *", tick, { name: "expression" });
crons.cron("weekday", "0 2 15W * *", tick, { name: "weekday" });

const modules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "cron.ts": () =>
    Promise.resolve({
      tick: mutationGeneric({
        args: { name: v.string() },
        handler: (ctx, { name }) =>
          ctx.db.insert("ticks", { name, at: Date.now() }).then(() => null),
      }),
      ticks: queryGeneric({
        args: {},
        handler: (ctx) =>
          ctx.db
            .query("ticks")
            .collect()
            .then((rows) => Array.map(rows, ({ name, at }) => ({ name, at }))),
      }),
    }),
  "crons.ts": () => Promise.resolve({ default: crons }),
};

// A linear congruential generator, so both processes draw the same stream.
let seed = 20_261_113;
const random = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
};

const start = Date.UTC(2026, 0, 14, 22, 30, 0);
const world: Invocation.World = {
  name: "replay",
  services: Context.empty(),
  clock: () => start,
  random,
};

const history = Effect.gen(function* () {
  const t: KernelControls = convexTest({
    schema,
    modules,
    runtime: {
      now: () => start,
      commitTs: (version: number) => 1_000n + BigInt(version),
    },
  });
  const call = <A>(thunk: () => Promise<A>) => Effect.promise(thunk);
  yield* call(() =>
    Invocation.bind(
      {
        world,
        componentPath: "",
        attempt: 1,
        request: {
          ip: null,
          userAgent: null,
          requestId: "replay-open",
          scheduledFunctionId: null,
        },
        services: world.services,
        startedAt: start,
        random,
      },
      () =>
        (
          t as unknown as {
            run: (handler: () => Promise<null>) => Promise<null>;
          }
        ).run(() => Promise.resolve(null)),
    ),
  );
  const opened = Array.map(t.crons(), ({ name, nextRun }) => ({
    name,
    nextRun,
  }));
  yield* call(() => t.advance(36 * 60 * 60 * 1000));
  const ticks = yield* call(() =>
    t.query(makeFunctionReference<"query">("cron:ticks"), {}),
  );
  const after = Array.map(t.crons(), ({ name, nextRun }) => ({
    name,
    nextRun,
  }));
  // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- The bytes compared are the deadlines as plain JSON.
  process.stdout.write(JSON.stringify({ opened, ticks, crons: after }));
});

void Effect.runPromise(history);
