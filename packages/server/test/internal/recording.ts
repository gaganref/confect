import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Tracer from "effect/Tracer";

export const recording = () => {
  const spans: Array<Tracer.Span> = [];
  const messages: Array<unknown> = [];
  const lifecycle = { builds: 0, releases: 0 };
  const observability = Layer.mergeAll(
    Layer.effectDiscard(Effect.yieldNow),
    Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.sync(() => lifecycle.builds++),
        () => Effect.sync(() => lifecycle.releases++),
      ),
    ),
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
  const invocation = Effect.succeed({
    name: "test:run",
    type: "mutation" as const,
    visibility: "public" as const,
    componentPath: "counter",
  });
  return { spans, messages, observability, lifecycle, invocation };
};
