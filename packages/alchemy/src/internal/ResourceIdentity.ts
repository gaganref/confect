import * as Effect from "effect/Effect";
import * as String from "effect/String";
import { pipe } from "effect/Function";

export const resourceName = Effect.fn("ResourceIdentity.name")(function* (
  kind: string,
  fqn: string,
  instanceId: string,
) {
  const hash = yield* Effect.promise(() =>
    crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${fqn}:${instanceId}`),
    ),
  );
  const suffix = pipe(
    Array.from(new Uint8Array(hash), (byte) =>
      pipe(byte.toString(16), String.padStart(2, "0")),
    ).join(""),
    String.slice(0, 24),
  );
  return `confect-${kind}-${suffix}`;
});
