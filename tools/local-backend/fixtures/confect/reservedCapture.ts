import * as RegisteredFunction from "@confect/server/RegisteredFunction";
import * as Effect from "effect/Effect";

export const capture = (domain: { readonly run: string }) =>
  Effect.gen(function* () {
    const received = yield* RegisteredFunction.Received;
    if (received === undefined)
      return yield* Effect.die("Fixture invocation context is missing");
    const { requestId } = received;
    if (requestId === undefined)
      return yield* Effect.die("Fixture invocation has no request ID");
    return {
      args: domain,
      received: {
        ...received,
        requestId,
        value: received.value ?? null,
        deployment: received.deployment ?? null,
      },
    };
  });
