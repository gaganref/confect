/**
 * A signed webhook envelope: the route-local ingress rule that the mock-backend
 * fixture's and the local-backend fixture's `POST /ingress/events` routes both
 * check. The secret is the test's own. A sender signs the exact body bytes with
 * HMAC-SHA-256 and sends `x-confect-signature: sha256=<hex>`. The route accepts
 * a JSON body `{ id, event }` only when the signature matches those bytes, and
 * answers every other shape with the refusal declared for it below, before it
 * writes anything.
 */
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Arr from "effect/Array";
import * as String from "effect/String";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";

export const path = "/ingress/events";
export const signatureHeader = "x-confect-signature";

/**
 * The test-owned secret both fixtures verify with.
 */
export const secret = "confect-test-ingress-secret";

export interface Refusal {
  readonly status: number;
  readonly body: string;
}

/**
 * Each malformed shape's refusal, checked in this order.
 */
export const refusals = {
  contentType: { status: 415, body: "envelope must be application/json" },
  missingSignature: { status: 401, body: `missing ${signatureHeader}` },
  malformedSignature: {
    status: 400,
    body: `${signatureHeader} must be sha256=<64 hex digits>`,
  },
  badSignature: { status: 401, body: "signature does not match the body" },
  malformedJson: { status: 400, body: "envelope is not JSON" },
  malformedEnvelope: {
    status: 422,
    body: "envelope needs a string id and event",
  },
} as const satisfies Record<string, Refusal>;

export type Verdict =
  | { readonly kind: "accepted"; readonly id: string; readonly event: string }
  | { readonly kind: "refused"; readonly refusal: Refusal };

const encoder = new TextEncoder();

const hmacKey = (key: string) =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

const toHex = (bytes: ArrayBuffer) =>
  Arr.join(
    Array.from(new Uint8Array(bytes), (byte) =>
      pipe(byte.toString(16), String.padStart(2, "0")),
    ),
    "",
  );

const fromHex = (hex: string) =>
  Uint8Array.from(
    pipe(
      hex,
      String.match(/../g),
      Option.getOrElse((): ReadonlyArray<string> => []),
    ),
    (pair) => Number.parseInt(pair, 16),
  );

/**
 * The signature header value for `body`, with the test's secret unless another
 * key is given.
 */
export const sign = (body: Uint8Array, key: string = secret): Promise<string> =>
  hmacKey(key)
    .then((cryptoKey) =>
      crypto.subtle.sign("HMAC", cryptoKey, body as Uint8Array<ArrayBuffer>),
    )
    .then((signature) => `sha256=${toHex(signature)}`);

const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const Envelope = Schema.Struct({ id: Schema.String, event: Schema.String });
const utf8 = new TextDecoder("utf-8", { fatal: true });

const refused = (refusal: Refusal): Verdict => ({ kind: "refused", refusal });

/**
 * Check an envelope's headers and exact body bytes.
 */
export const verify = (
  header: (name: string) => string | null | undefined,
  body: Uint8Array,
): Promise<Verdict> => {
  const contentType = header("content-type");
  const mediaType =
    typeof contentType === "string"
      ? pipe(
          contentType,
          String.split(";"),
          Arr.headNonEmpty,
          String.trim,
          String.toLowerCase,
        )
      : undefined;
  if (mediaType !== "application/json") {
    return Promise.resolve(refused(refusals.contentType));
  }
  const signature = header(signatureHeader);
  if (signature === null || signature === undefined) {
    return Promise.resolve(refused(refusals.missingSignature));
  }
  const digest = /^sha256=([0-9a-f]{64})$/.exec(signature)?.[1];
  if (digest === undefined) {
    return Promise.resolve(refused(refusals.malformedSignature));
  }
  return hmacKey(secret)
    .then((cryptoKey) =>
      crypto.subtle.verify(
        "HMAC",
        cryptoKey,
        fromHex(digest),
        body as Uint8Array<ArrayBuffer>,
      ),
    )
    .then((valid): Verdict => {
      if (!valid) return refused(refusals.badSignature);
      let text: string;
      try {
        text = utf8.decode(body);
      } catch {
        return refused(refusals.malformedJson);
      }
      const json = Schema.decodeResult(UnknownJson)(text);
      if (Result.isFailure(json)) return refused(refusals.malformedJson);
      const envelope = Schema.decodeUnknownResult(Envelope)(json.success);
      return Result.isFailure(envelope)
        ? refused(refusals.malformedEnvelope)
        : { kind: "accepted", ...envelope.success };
    });
};
