// Two unbound runs through `TestConfect.layer` on the kernel target, each
// drawing from every random source, printed as bytes. No invocation is bound,
// so each draws from the layer's own world, whose stream its seed starts.
// `Randomness.test.ts` runs this file in several processes and compares their
// output. `process.argv[2]`, when given, is the layer's seed.
import { DatabaseSchema } from "@confect/server";
import { defineSchema } from "convex/server";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestConfect from "../../src/TestConfect";

const UnknownJson = Schema.fromJsonString(Schema.Unknown);

const modules = {
  "_generated/server.ts": () => Promise.resolve({}),
};

const schema = DatabaseSchema.make({});
const seed = process.argv[2];

const drawn: Array<unknown> = [];

const draw = Effect.sync(() => {
  drawn.push({
    // oxlint-disable-next-line effecttsgo/global-random-in-effect -- The run reads the ambient Math.random the kernel gives an unbound function.
    random: Math.random(),
    bytes: Array.from(crypto.getRandomValues(new Uint8Array(2))),
    // oxlint-disable-next-line effecttsgo/crypto-random-uuid-in-effect -- The run reads the ambient crypto.randomUUID the kernel gives an unbound function.
    uuid: crypto.randomUUID(),
  });
});

const replay = Effect.gen(function* () {
  const test = yield* TestConfect.TestConfect<typeof schema>();
  yield* test.run(draw);
  yield* test.run(draw);
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
