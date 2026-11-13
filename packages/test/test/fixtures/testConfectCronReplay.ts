// oxlint-disable effecttsgo/global-date -- The fixture steps a fake `Date`, which the kernel target's clock follows, and its mutation reads the pinned `Date` as product code does.
// One cron history through `TestConfect.layer` on the kernel target, printed as
// bytes. `TestConfect.test.ts` runs this file in several processes and
// compares their output. `process.argv[2]`, when given, is the layer's seed.
import { DatabaseSchema } from "@confect/server";
import {
  cronJobs,
  defineSchema,
  makeFunctionReference,
  mutationGeneric,
} from "convex/server";
import { v } from "convex/values";
import * as Effect from "effect/Effect";
import * as TestConfect from "../../src/TestConfect";
import * as Schema from "effect/Schema";

const jsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

let now = Date.UTC(2026, 0, 14, 22, 15, 0);
const RealDate = globalThis.Date;
class SteppedDate extends RealDate {
  constructor(...args: Array<unknown>) {
    if (args.length === 0) super(now);
    else super(...(args as [number]));
  }
  static override now() {
    return now;
  }
}
globalThis.Date = SteppedDate as DateConstructor;

const ticks: Array<{ readonly name: string; readonly at: number }> = [];
const tick = makeFunctionReference<"mutation", { name: string }>("ticks:tick");

const crons = cronJobs();
crons.hourly("hourly", {}, tick, { name: "hourly" });
crons.cron("expression", "*/20 * * * *", tick, { name: "expression" });

const modules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "ticks.ts": () =>
    Promise.resolve({
      tick: mutationGeneric({
        args: { name: v.string() },
        handler: (_ctx, { name }) => {
          ticks.push({ name, at: Date.now() });
          return Promise.resolve(null);
        },
      }),
    }),
  "crons.ts": () => Promise.resolve({ default: crons }),
};

const schema = DatabaseSchema.make({});
const seed = process.argv[2];

const history = Effect.gen(function* () {
  const test = yield* TestConfect.TestConfect<typeof schema>();
  for (let second = 0; second < 2.5 * 60 * 60; second += 1) {
    now += 1000;
    yield* test.finishInProgressScheduledFunctions();
  }
  const output = yield* jsonText(ticks);
  process.stdout.write(output);
}).pipe(
  Effect.provide(
    TestConfect.layer(schema, defineSchema({}), modules, {
      target: "kernel",
      ...(seed === undefined ? {} : { seed: Number(seed) }),
    }),
  ),
);

void Effect.runPromise(history);
