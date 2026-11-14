// Every plain function in `drawingBackend.ts`, each under a bound invocation
// with its own stream, printed as bytes. `Randomness.test.ts` runs this file
// in two processes and compares their output with each other and with the
// streams.
import * as Effect from "effect/Effect";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Invocation from "../../src/internal/Invocation";
import {
  calls,
  drawingBackend,
  invocationOf,
  streamFor,
} from "./drawingBackend";

const UnknownJson = Schema.fromJsonString(Schema.Unknown);

const replay = Effect.gen(function* () {
  const t = drawingBackend();
  const drawn: Record<string, unknown> = {};
  for (const [index, [name, [kind, ref]]] of Rec.toEntries(calls).entries()) {
    drawn[name] = yield* Effect.promise(() =>
      Invocation.bind(invocationOf(streamFor(index)), () =>
        t[kind](ref as never, {}),
      ),
    );
  }
  const output = yield* Schema.encodeEffect(UnknownJson)(drawn);
  process.stdout.write(output);
});

void Effect.runPromise(replay);
