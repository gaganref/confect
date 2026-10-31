import * as Ref from "@confect/core/Ref";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";

export const Forward = Context.Reference<
  ((span: Tracer.Span) => unknown) | undefined
>("@confect/server/RegisteredFunction/Forward", {
  defaultValue: () => undefined,
});

const inject = (
  ref: Ref.Any,
  encoded: unknown,
  context: Context.Context<never>,
): unknown => {
  if (ref.reservedArgument === undefined || ref.functionType === "query")
    return encoded;
  const forward = Context.get(context, Forward);
  const span = Context.getOrUndefined(context, Tracer.ParentSpan);
  if (forward === undefined || span?._tag !== "Span") return encoded;
  try {
    const value = forward(span);
    return value === undefined
      ? encoded
      : {
          ...(encoded as Record<string, unknown>),
          [ref.reservedArgument]: value,
        };
  } catch {
    return encoded;
  }
};

export const runWithCodec = <Ref_ extends Ref.Any>(
  ref: Ref_,
  args: Ref.Args<Ref_>,
  call: (
    native: Ref.FunctionReference<Ref_>,
    encoded: unknown,
  ) => PromiseLike<unknown>,
) =>
  Effect.withFiber((fiber) =>
    Ref.runWithCodec(ref, args, (native, encoded) =>
      call(native, inject(ref, encoded, fiber.context)),
    ),
  );

export const encodeArgs = <Ref_ extends Ref.Any>(
  ref: Ref_,
  args: Ref.Args<Ref_>,
) =>
  Effect.withFiberSucceed((fiber) =>
    inject(ref, Ref.encodeArgsSync(ref, args), fiber.context),
  );
