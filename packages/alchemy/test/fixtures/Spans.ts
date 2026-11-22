import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";
import { inspect } from "node:util";

/**
 * A tracer that records every span the native tracer starts, and the text of
 * each recorded span's name, attributes and end exit.
 *
 * @stability unstable
 */
export const recordSpans = Effect.gen(function* () {
  const native = yield* Tracer.Tracer;
  const spans: Tracer.Span[] = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = native.span(options);
      spans.push(span);
      return span;
    },
  });
  const text = () =>
    inspect(
      Arr.map(spans, (span) => ({
        name: span.name,
        attributes: span.attributes,
        status: span.status,
      })),
      { depth: null },
    );
  return { tracer, spans, text };
});
