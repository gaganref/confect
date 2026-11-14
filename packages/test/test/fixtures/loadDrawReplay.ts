// One module's draws at load through `TestConfect.layer` on the kernel target,
// printed as bytes. `Randomness.test.ts` runs this file in several processes
// and compares their output. `process.argv[2]`, when given, is the layer's
// seed.
import { DatabaseSchema } from "@confect/server";
import { defineSchema } from "convex/server";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestConfect from "../../src/TestConfect";

const UnknownJson = Schema.fromJsonString(Schema.Unknown);

const modules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "loadDraws.ts": () => import("./loadDraws"),
};

const schema = DatabaseSchema.make({});
const seed = process.argv[2];

const replay = Effect.gen(function* () {
  const test = yield* TestConfect.TestConfect<typeof schema>();
  // Any call opens the backend, which loads every module under the layer's
  // seeded stream.
  yield* test.finishInProgressScheduledFunctions();
  const { drawn } = yield* Effect.promise(() => import("./loadDraws"));
  const output = yield* Schema.encodeEffect(UnknownJson)(drawn);
  process.stdout.write(output);
}).pipe(
  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- This replay script is an entry point: it opens one kernel backend for its process and closes it.
  Effect.provide(
    TestConfect.layer(schema, defineSchema({}), modules, {
      target: "kernel",
      ...(seed === undefined ? {} : { seed: Number(seed) }),
    }),
  ),
);

void Effect.runPromise(replay);
