import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Rec from "effect/Record";
import * as Entropy from "../src/internal/Entropy";

const draws = [0.125, 0.25, 0.5, 0.75, 0.875];

const cycling = () => {
  let next = 0;
  return () => draws[next++ % draws.length]!;
};

/**
 * The kernel's `crypto` over the host's, answering `source` on every call.
 */
const cryptoIn = (source: Entropy.Source | undefined) =>
  Entropy.kernelCrypto(
    crypto,
    () => source,
    () => 0.5,
  );

const settle = (thunk: () => Promise<unknown>) =>
  Effect.promise(() =>
    Promise.resolve()
      .then(thunk)
      .then(
        () => "ran",
        (error: unknown) => error,
      ),
  );

/**
 * Keys made with the host's own `subtle`, outside any source.
 */
const keys = Effect.promise(() =>
  Promise.all([
    crypto.subtle.generateKey(
      {
        name: "RSA-OAEP",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["encrypt", "decrypt"],
    ),
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]),
    crypto.subtle.generateKey(
      {
        name: "RSA-PSS",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    ),
    crypto.subtle.importKey(
      "raw",
      new Uint8Array(32),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    ),
    crypto.subtle.importKey("raw", new Uint8Array(16), "AES-GCM", false, [
      "encrypt",
    ]),
  ]),
);

const data = new Uint8Array([1, 2, 3]);

describe("Entropy", () => {
  it("randomUUID builds a version 4 UUID from 16 bytes of the stream, as the binary's does, in the host's format", () => {
    const random = cycling();
    let drawn = 0;
    const counted = () => {
      drawn++;
      return random();
    };
    // Bytes 32, 64, 128, 192, 224 repeating, with byte 6's high nibble set to
    // version 4 and byte 8's top bits to the RFC 4122 variant.
    expect(Entropy.uuid(counted)).toBe("204080c0-e020-4080-80e0-204080c0e020");
    expect(drawn).toBe(16);
    const shape =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect([
      shape.test(Entropy.uuid(cycling())),
      // oxlint-disable-next-line effecttsgo/crypto-random-uuid -- The test compares the binary's UUID layout with the host's.
      shape.test(crypto.randomUUID()),
    ]).toEqual([true, true]);
  });

  it("Math.random and crypto resolve their source on every call, so a reference kept under one source draws from the next", () => {
    let source: Entropy.Source | undefined = {
      phase: "load",
      random: () => 0.125,
    };
    const math = Entropy.kernelMath(Math, () => source);
    const kernelCrypto = Entropy.kernelCrypto(
      crypto,
      () => source,
      () => 0.5,
    );
    const { random } = math;
    // oxlint-disable-next-line typescript/unbound-method -- The test keeps the method detached, as a module may.
    const { getRandomValues } = kernelCrypto;
    expect([random(), ...getRandomValues(new Uint8Array(1))]).toEqual([
      0.125, 32,
    ]);
    source = { phase: "query", random: () => 0.625 };
    expect([random(), ...getRandomValues(new Uint8Array(1))]).toEqual([
      0.625, 160,
    ]);
    // A source with no stream fills from the host, with the binary's checks.
    source = { phase: "query", random: undefined };
    expect(getRandomValues(new Uint8Array(1))).toEqual(new Uint8Array([128]));
    expect(() => getRandomValues(new Uint8Array(65_537))).toThrow(TypeError);
    // Outside a source, both are the host's.
    source = undefined;
    expect(random()).not.toBe(0.625);
    expect(Entropy.isBuilt(math) && Entropy.isBuilt(kernelCrypto)).toBe(true);
    expect(Entropy.isBuilt(Math)).toBe(false);
  });

  it.effect(
    "crypto.subtle refuses the operations that draw cryptographic randomness with the binary's error in a query, a mutation and a module load, and with RequiresBinary in an action",
    () =>
      Effect.gen(function* () {
        const [oaep, ecdsa, pss, hmac, aes] = yield* keys;
        const drawing = (subtle: SubtleCrypto) => ({
          generateKey: () =>
            subtle.generateKey({ name: "AES-GCM", length: 128 }, true, [
              "encrypt",
            ]),
          encrypt: () =>
            subtle.encrypt({ name: "RSA-OAEP" }, oaep.publicKey, data),
          signEcdsa: () =>
            subtle.sign(
              { name: "ECDSA", hash: "SHA-256" },
              ecdsa.privateKey,
              data,
            ),
          signPss: () =>
            subtle.sign(
              { name: "rsa-pss", saltLength: 32 },
              pss.privateKey,
              data,
            ),
        });
        for (const phase of ["query", "mutation", "load"] as const) {
          const outcomes = drawing(
            cryptoIn({ phase, random: cycling() }).subtle,
          );
          for (const [operation, run] of Rec.toEntries(outcomes)) {
            const outcome = yield* settle(run);
            expect(outcome, `${phase} ${operation}`).toMatchObject({
              name: "Error",
              message: Entropy.noCryptoRngInQueriesOrMutations,
            });
          }
        }
        const inAction = drawing(
          cryptoIn({ phase: "action", random: cycling() }).subtle,
        );
        const refusals = {
          generateKey: "subtleGenerateKey",
          encrypt: "subtleEncrypt",
          signEcdsa: "subtleSign",
          signPss: "subtleSign",
        } as const;
        for (const [operation, run] of Rec.toEntries(inAction)) {
          const outcome = yield* settle(run);
          expect(outcome, operation).toMatchObject({
            _tag: "RequiresBinary",
            operation: refusals[operation as keyof typeof refusals],
          });
        }
        // Outside any source, the host's subtle draws as before.
        const outside = drawing(cryptoIn(undefined).subtle);
        for (const [operation, run] of Rec.toEntries(outside)) {
          const outcome = yield* settle(run);
          expect(outcome, operation).toBe("ran");
        }
        // The deterministic operations run in every phase.
        for (const phase of ["query", "mutation", "action", "load"] as const) {
          const subtle = cryptoIn({ phase, random: cycling() }).subtle;
          const deterministic = [
            () => subtle.digest("SHA-256", data),
            () => subtle.sign("HMAC", hmac, data),
            () =>
              subtle.encrypt(
                { name: "AES-GCM", iv: new Uint8Array(12) },
                aes,
                data,
              ),
            () => subtle.exportKey("jwk", oaep.publicKey),
            () =>
              subtle
                .sign("HMAC", hmac, data)
                .then((signature) =>
                  subtle.verify("HMAC", hmac, signature, data),
                ),
          ];
          for (const run of deterministic) {
            const outcome = yield* settle(run);
            expect(outcome, phase).toBe("ran");
          }
        }
      }),
  );
});
