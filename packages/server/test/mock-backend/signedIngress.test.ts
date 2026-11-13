import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SignedEnvelope from "../signedEnvelope";
import refs from "./fixtures/confect/_generated/refs";
import * as TestConfect from "./TestConfect";
import * as Array from "effect/Array";
import * as String from "effect/String";
import { pipe } from "effect/Function";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";

const encoder = new TextEncoder();
// oxlint-disable-next-line effecttsgo/global-json -- A sender's envelope bytes, built at module scope and in the sync thunks of the cases' table.
const json = (value: unknown) => encoder.encode(JSON.stringify(value));

const accepted = { id: "evt_1", event: "paid" };
const acceptedBody = json(accepted);

type Envelope = {
  readonly path?: string;
  readonly method?: string;
  readonly headers: Record<string, string>;
  readonly body?: Uint8Array;
};

/**
 * `body` with a content type and its signature, unless a shape overrides one.
 */
const signed = (
  body: Uint8Array,
  options: { readonly key?: string; readonly over?: Uint8Array } = {},
): Promise<Envelope> =>
  SignedEnvelope.sign(options.over ?? body, options.key).then((signature) => ({
    headers: {
      "content-type": "application/json",
      [SignedEnvelope.signatureHeader]: signature,
    },
    body,
  }));

const send = (envelope: Envelope) =>
  Effect.flatMap(TestConfect.TestConfect, (c) =>
    c.fetch(envelope.path ?? SignedEnvelope.path, {
      method: envelope.method ?? "POST",
      headers: envelope.headers,
      ...(envelope.body === undefined
        ? {}
        : { body: envelope.body as Uint8Array<ArrayBuffer> }),
    }),
  ).pipe(
    Effect.flatMap((response) =>
      Effect.promise(() =>
        response.text().then((body) => ({ status: response.status, body })),
      ),
    ),
  );

/**
 * The protected table, serialized, so a refusal can be shown to change nothing.
 */
const protectedRows = Effect.flatMap(TestConfect.TestConfect, (c) =>
  c.query(refs.public.groups.notes.list),
).pipe(
  Effect.flatMap((rows) =>
    Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(rows),
  ),
  Effect.orDie,
);

const notFound = { status: 404, body: "" };

const flipped = (body: Uint8Array) => {
  const copy = Uint8Array.from(body);
  copy[copy.length - 2] ^= 1;
  return copy;
};

const shapes: ReadonlyArray<{
  readonly name: string;
  readonly envelope: () => Promise<Envelope>;
  readonly refusal: SignedEnvelope.Refusal;
}> = [
  {
    name: "no content type",
    envelope: () =>
      signed(acceptedBody).then((envelope) => ({
        ...envelope,
        headers: {
          [SignedEnvelope.signatureHeader]:
            envelope.headers[SignedEnvelope.signatureHeader]!,
        },
      })),
    refusal: SignedEnvelope.refusals.contentType,
  },
  {
    name: "a text/plain content type",
    envelope: () =>
      signed(acceptedBody).then((envelope) => ({
        ...envelope,
        headers: { ...envelope.headers, "content-type": "text/plain" },
      })),
    refusal: SignedEnvelope.refusals.contentType,
  },
  {
    name: "no signature",
    envelope: () =>
      Promise.resolve({
        headers: { "content-type": "application/json" },
        body: acceptedBody,
      }),
    refusal: SignedEnvelope.refusals.missingSignature,
  },
  {
    name: "a signature without its sha256= prefix",
    envelope: () =>
      signed(acceptedBody).then((envelope) => ({
        ...envelope,
        headers: {
          ...envelope.headers,
          [SignedEnvelope.signatureHeader]: pipe(
            envelope.headers[SignedEnvelope.signatureHeader]!,
            String.slice("sha256=".length),
          ),
        },
      })),
    refusal: SignedEnvelope.refusals.malformedSignature,
  },
  {
    name: "a truncated signature",
    envelope: () =>
      signed(acceptedBody).then((envelope) => ({
        ...envelope,
        headers: {
          ...envelope.headers,
          [SignedEnvelope.signatureHeader]: pipe(
            envelope.headers[SignedEnvelope.signatureHeader]!,
            String.slice(0, -2),
          ),
        },
      })),
    refusal: SignedEnvelope.refusals.malformedSignature,
  },
  {
    name: "a signature over another body",
    envelope: () =>
      signed(acceptedBody, { over: json({ id: "evt_2", event: "paid" }) }),
    refusal: SignedEnvelope.refusals.badSignature,
  },
  {
    name: "a body changed by one bit after signing",
    envelope: () => signed(flipped(acceptedBody), { over: acceptedBody }),
    refusal: SignedEnvelope.refusals.badSignature,
  },
  {
    name: "a signature made with another secret",
    envelope: () => signed(acceptedBody, { key: "an attacker's secret" }),
    refusal: SignedEnvelope.refusals.badSignature,
  },
  {
    name: "an empty signed body",
    envelope: () => signed(new Uint8Array()),
    refusal: SignedEnvelope.refusals.malformedJson,
  },
  {
    name: "a signed body that is not JSON",
    envelope: () => signed(encoder.encode("id=evt_1&event=paid")),
    refusal: SignedEnvelope.refusals.malformedJson,
  },
  {
    name: "a signed body that is not UTF-8",
    envelope: () => signed(Uint8Array.of(0x7b, 0xff, 0x7d)),
    refusal: SignedEnvelope.refusals.malformedJson,
  },
  {
    name: "a signed envelope without an event",
    envelope: () => signed(json({ id: "evt_1" })),
    refusal: SignedEnvelope.refusals.malformedEnvelope,
  },
  {
    name: "a signed envelope whose id is a number",
    envelope: () => signed(json({ id: 1, event: "paid" })),
    refusal: SignedEnvelope.refusals.malformedEnvelope,
  },
  {
    name: "a signed JSON array",
    envelope: () => signed(json([accepted])),
    refusal: SignedEnvelope.refusals.malformedEnvelope,
  },
  {
    name: "a GET to the route",
    envelope: () =>
      signed(acceptedBody).then(({ headers }) => ({ method: "GET", headers })),
    refusal: notFound,
  },
  {
    name: "a POST to a path beside the route",
    envelope: () =>
      signed(acceptedBody).then((envelope) => ({
        ...envelope,
        path: `${SignedEnvelope.path}/extra`,
      })),
    refusal: notFound,
  },
];

describe("signed ingress", () => {
  it.effect("accepts a correctly signed envelope and records it", () =>
    Effect.gen(function* () {
      const services2 = yield* Layer.build(TestConfect.layer);
      return yield* Effect.gen(function* () {
        const protectedRowsValue = yield* protectedRows;
        expect(protectedRowsValue).toBe("[]");
        const resolved = yield* Effect.promise(() => signed(acceptedBody));
        const sendResult = yield* send(resolved);
        expect(sendResult).toStrictEqual({
          status: 200,
          body: "accepted paid evt_1",
        });
        const c = yield* TestConfect.TestConfect;
        const query2 = yield* c.query(refs.public.groups.notes.list);
        expect(Array.map(query2, (row) => row.text)).toStrictEqual([
          "paid:evt_1",
        ]);
      }).pipe(Effect.provideContext(services2));
    }).pipe(Effect.scoped),
  );

  it.effect.each(shapes)(
    "refuses $name with its declared refusal and leaves the protected table unchanged",
    ({ envelope, refusal }) =>
      Effect.gen(function* () {
        const services = yield* Layer.build(TestConfect.layer);
        return yield* Effect.gen(function* () {
          const resolved = yield* Effect.promise(() => signed(acceptedBody));
          yield* send(resolved);
          const before = yield* protectedRows;
          const resolved2 = yield* Effect.promise(envelope);
          const sendResult = yield* send(resolved2);
          expect(sendResult).toStrictEqual(refusal);
          const protectedRowsValue = yield* protectedRows;
          expect(protectedRowsValue).toBe(before);
        }).pipe(Effect.provideContext(services));
      }).pipe(Effect.scoped),
  );
});
