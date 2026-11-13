import * as RegisteredFunction from "@confect/server/RegisteredFunction";
import * as Effect from "effect/Effect";

export const capture = (domain: { readonly run: string }) =>
  Effect.gen(function* () {
    const received = yield* RegisteredFunction.Received;
    if (received === undefined)
      return yield* Effect.die("Fixture invocation context is missing");
    return {
      args: domain,
      received: {
        ...received,
        value: received.value ?? null,
        deployment: received.deployment ?? null,
      },
    };
  });
