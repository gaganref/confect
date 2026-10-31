import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Tracer from "effect/Tracer";

export const recording = () => {
  const spans: Array<Tracer.Span> = [];
  const messages: Array<unknown> = [];
  const observability = Layer.mergeAll(
    Layer.succeed(
      Tracer.Tracer,
      Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      }),
    ),
    Logger.layer([Logger.make(({ message }) => messages.push(message))]),
  );
  return { spans, messages, observability };
};
