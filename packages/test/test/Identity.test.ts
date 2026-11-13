/* oxlint-disable effecttsgo/global-json, effecttsgo/prefer-effect-array, effecttsgo/prefer-effect-string, effecttsgo/yield-in-call-argument -- #134 (the JWT row) wrote this file before main moved to the Effect 4.1 lint rules. #134 brings it to those rules when it merges main, so row 7 leaves its code as #134 has it rather than rewrite it twice. */
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The replay test compares the exact stdout of two fresh Node processes.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import {
  defineSchema,
  makeFunctionReference,
  queryGeneric,
} from "convex/server";
import { jsonToConvex } from "convex/values";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { convexTest, type KernelControls } from "../src/internal/ConvexTest";
import * as KernelRefusal from "../src/internal/KernelRefusal";
import {
  jwksUrl,
  mint,
  provider,
  rsaKeys,
  sign,
  type VerifierCase,
  type VerifierOutcome,
} from "./fixtures/minted";
import { oversizedRsa } from "./fixtures/oversized";

const whoami = makeFunctionReference<"query", {}, object | null>(
  "identity:whoami",
);

const start = 1_800_000_000_000;

/**
 * A backend whose `auth.config` declares `providers`, and a count of the
 * handler runs, so a refusal is seen to come before any function.
 */
const world = (providers: ReadonlyArray<object> | undefined) => {
  const runs = { count: 0 };
  const t: KernelControls = convexTest({
    schema: defineSchema({}),
    modules: {
      "_generated/server.ts": () => Promise.resolve({}),
      ...(providers === undefined
        ? {}
        : {
            "auth.config.ts": () => Promise.resolve({ default: { providers } }),
          }),
      "identity.ts": () =>
        Promise.resolve({
          whoami: queryGeneric({
            args: {},
            handler: (ctx) => {
              runs.count++;
              return ctx.auth.getUserIdentity();
            },
          }),
        }),
    },
    runtime: { now: () => start, commitTs: (version) => BigInt(version) },
  });
  return { t, runs };
};

/**
 * The call's `VerifierOutcome`, or the error itself when it is not the
 * transport refusal.
 */
const outcome = (t: KernelControls, token: string) =>
  Effect.promise((): Promise<unknown> =>
    t
      .withToken(token)
      .query(whoami, {})
      .then(
        (identity) => ({ _tag: "accepted", identity }),
        (error: unknown) =>
          Schema.is(KernelRefusal.InvalidToken)(error)
            ? ({
                _tag: "refused",
                refusal: "InvalidToken",
                code: error.code,
              } satisfies VerifierOutcome)
            : error,
      ),
  );

const names: ReadonlyArray<VerifierCase["name"]> = [
  "valid control",
  "wrong issuer",
  "wrong audience",
  "foreign key",
  "expired",
];

describe("minted tokens on the kernel's verifier", () => {
  it.effect.each(names)("%s", (name) =>
    Effect.gen(function* () {
      const { jwks, cases } = yield* mint(start / 1000);
      const { t, runs } = world([{ ...provider, jwks }]);
      const minted = cases.find((c) => c.name === name)!;
      expect(yield* outcome(t, minted.token)).toEqual(minted.expected);
      expect(runs.count).toBe(minted.expected._tag === "accepted" ? 1 : 0);
    }),
  );
});

describe("token verification", () => {
  it.effect(
    "a token stays valid five seconds past its expiry on the kernel's clock and is refused after",
    () =>
      Effect.gen(function* () {
        const { jwks, cases } = yield* mint(start / 1000 - 3590);
        const { t } = world([{ ...provider, jwks }]);
        const valid = cases.find((c) => c.name === "valid control")!;
        yield* Effect.promise(() => t.advance(15_000));
        expect(yield* outcome(t, valid.token)).toEqual(valid.expected);
        yield* Effect.promise(() => t.advance(1_000));
        expect(yield* outcome(t, valid.token)).toEqual({
          _tag: "refused",
          refusal: "InvalidToken",
          code: "InvalidAuthHeader",
        });
      }),
  );

  it.effect("an app without an auth config matches no provider", () =>
    Effect.gen(function* () {
      const { cases } = yield* mint(start / 1000);
      const { t } = world(undefined);
      expect(yield* outcome(t, cases[0]!.token)).toEqual({
        _tag: "refused",
        refusal: "InvalidToken",
        code: "NoAuthProvider",
      });
    }),
  );

  it.effect(
    "an OIDC provider and a JWKS fetched over the network stay on the binary",
    () =>
      Effect.gen(function* () {
        const { cases } = yield* mint(start / 1000);
        const token = cases[0]!.token;
        const oidc = world([
          { domain: provider.issuer, applicationID: provider.applicationID },
        ]);
        expect(yield* outcome(oidc.t, token)).toMatchObject({
          _tag: "RequiresBinary",
          operation: "oidcDiscovery",
        });
        const remote = world([
          { ...provider, jwks: "https://confect-auth.invalid/jwks.json" },
        ]);
        expect(yield* outcome(remote.t, token)).toMatchObject({
          _tag: "RequiresBinary",
          operation: "remoteJwks",
        });
      }),
  );

  it.effect(
    "a subscriber that presents a token subscribes under the identity the kernel verified, a new token makes its identity-dependent subscription stale, and a refused token changes nothing and rejects a fresh subscriber's subscriptions",
    () =>
      Effect.gen(function* () {
        const { jwks, cases, signDeclared } = yield* mint(start / 1000);
        const { t, runs } = world([{ ...provider, jwks }]);
        const token = (name: VerifierCase["name"]) =>
          cases.find((c) => c.name === name)!;
        const valid = token("valid control");
        const subscriber = t.withToken(valid.token).subscriber();
        const subscription = yield* Effect.promise(() =>
          subscriber.subscribe(whoami, {}),
        );
        const identity = (
          valid.expected as { readonly identity: Record<string, unknown> }
        ).identity;
        expect(subscription.current().outcome).toEqual({
          _tag: "returned",
          value: identity,
        });

        const before = subscriber.identityVersion;
        const rejected = yield* Effect.promise(() =>
          subscriber.present(token("wrong issuer").token).then(
            () => undefined,
            (error: unknown) => error,
          ),
        );
        expect(rejected).toMatchObject({
          _tag: "InvalidToken",
          code: "NoAuthProvider",
        });
        expect(subscriber.identityVersion).toBe(before);
        expect(yield* Effect.promise(() => t.refresh())).toEqual([]);

        const other = yield* signDeclared({ sub: "other" });
        yield* Effect.promise(() => subscriber.present(other));
        expect(subscriber.identityVersion).toBeGreaterThan(before);
        expect(yield* Effect.promise(() => t.refresh())).toEqual([
          expect.objectContaining({
            subscription: subscription.id,
            to: {
              _tag: "returned",
              value: {
                ...identity,
                subject: "other",
                tokenIdentifier: `${provider.issuer}|other`,
              },
            },
            because: expect.objectContaining({ kind: "identity" }),
          }),
        ]);

        const counted = runs.count;
        const refused = yield* Effect.promise(() =>
          t
            .withToken(token("foreign key").token)
            .subscriber()
            .subscribe(whoami, {})
            .then(
              () => undefined,
              (error: unknown) => error,
            ),
        );
        expect(refused).toMatchObject({
          _tag: "InvalidToken",
          code: "InvalidAuthHeader",
        });
        expect(runs.count).toBe(counted);
      }),
  );

  it.effect("a provider the binary would refuse at push is refused", () =>
    Effect.gen(function* () {
      const { jwks, cases } = yield* mint(start / 1000);
      const { t } = world([{ ...provider, jwks, algorithm: "HS256" }]);
      expect(yield* outcome(t, cases[0]!.token)).toMatchObject({
        _tag: "InvalidAuthConfig",
        index: 0,
      });
    }),
  );

  it.effect(
    "a fractional expiry rounds to the nearest second, as the binary reads it",
    () =>
      Effect.gen(function* () {
        const now = start / 1000;
        const { jwks, signDeclared } = yield* mint(now);
        const { t } = world([{ ...provider, jwks }]);
        // Rounds to now - 5, inside the skew. Truncating gives now - 6.
        const inside = yield* signDeclared({ exp: now - 5.4 });
        expect(yield* outcome(t, inside)).toMatchObject({ _tag: "accepted" });
        const outside = yield* signDeclared({ exp: now - 5.6 });
        expect(yield* outcome(t, outside)).toEqual(
          refused("InvalidAuthHeader"),
        );
        const negative = yield* signDeclared({ nbf: -1 });
        expect(yield* outcome(t, negative)).toEqual(
          refused("InvalidAuthHeader"),
        );
      }),
  );

  it.effect("a JWKS data URL's fragment is dropped before it decodes", () =>
    Effect.gen(function* () {
      const { jwks, cases } = yield* mint(start / 1000);
      const { t } = world([{ ...provider, jwks: `${jwks}#review` }]);
      expect(yield* outcome(t, cases[0]!.token)).toEqual(cases[0]!.expected);
    }),
  );
});

/**
 * A backend that declares `jwk` under `kid` "test" for `algorithm`, and a token
 * over the valid claims signed with `alg`.
 */
const declaring = (jwk: object, algorithm: "RS256" | "ES256" = "RS256") =>
  world([{ ...provider, algorithm, jwks: jwksUrl([{ ...jwk, kid: "test" }]) }])
    .t;

const validClaims = {
  iss: provider.issuer,
  aud: provider.applicationID,
  sub: "person",
  iat: start / 1000,
  exp: start / 1000 + 3600,
};

const refused = (code: "NoAuthProvider" | "InvalidAuthHeader") => ({
  _tag: "refused",
  refusal: "InvalidToken",
  code,
});

describe("key constraints", () => {
  it.effect.each([
    { bits: 2048, expected: { _tag: "accepted" } },
    { bits: 1024, expected: refused("InvalidAuthHeader") },
  ])("an RS256 key of $bits bits", ({ bits, expected }) =>
    Effect.gen(function* () {
      const keys = yield* rsaKeys(bits);
      const jwk = yield* Effect.promise(() =>
        crypto.subtle.exportKey("jwk", keys.publicKey),
      );
      const token = yield* sign(keys.privateKey, validClaims);
      expect(yield* outcome(declaring(jwk), token)).toMatchObject(expected);
    }),
  );

  it.effect(
    "an RS256 key of 16,384 bits is refused, though Web Crypto verifies its signature",
    () =>
      Effect.gen(function* () {
        const key = oversizedRsa(16_384);
        expect(key.bits).toBe(16_384);
        const encode = (value: object) =>
          Buffer.from(JSON.stringify(value)).toString("base64url");
        const unsigned = `${encode({ alg: "RS256", kid: "test" })}.${encode(validClaims)}`;
        const message = new TextEncoder().encode(unsigned);
        const signature = yield* Effect.promise(() => key.sign(message));
        const verifies = yield* Effect.promise(() =>
          crypto.subtle
            .importKey(
              "jwk",
              key.jwk,
              { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
              false,
              ["verify"],
            )
            .then((imported) =>
              crypto.subtle.verify(
                "RSASSA-PKCS1-v1_5",
                imported,
                signature as BufferSource,
                message,
              ),
            ),
        );
        expect(verifies).toBe(true);
        const token = `${unsigned}.${Buffer.from(signature).toString("base64url")}`;
        expect(yield* outcome(declaring(key.jwk), token)).toEqual(
          refused("InvalidAuthHeader"),
        );
      }),
    120_000,
  );

  it.effect(
    "an ES256 key is its 32-byte coordinates, whatever curve it names",
    () =>
      Effect.gen(function* () {
        const keys = yield* Effect.promise(() =>
          crypto.subtle.generateKey(
            { name: "ECDSA", namedCurve: "P-256" },
            true,
            ["sign", "verify"],
          ),
        );
        const jwk = yield* Effect.promise(() =>
          crypto.subtle.exportKey("jwk", keys.publicKey),
        );
        const token = yield* sign(keys.privateKey, validClaims, "ES256");
        expect(
          yield* outcome(declaring({ ...jwk, crv: "P-384" }, "ES256"), token),
        ).toMatchObject({ _tag: "accepted" });
        expect(
          yield* outcome(
            declaring({ ...jwk, x: `${jwk.x}AA` }, "ES256"),
            token,
          ),
        ).toEqual(refused("InvalidAuthHeader"));
      }),
  );
});

describe("deployment signing", () => {
  it("two processes storing a signed token commit the same bytes", () => {
    const loader = pathToFileURL(
      createRequire(import.meta.url).resolve("tsx/esm"),
    ).href;
    const script = fileURLToPath(
      new URL("fixtures/signedReplay.ts", import.meta.url),
    );
    const replay = () =>
      spawnSync(process.execPath, ["--import", loader, script], {
        encoding: "utf8",
      });
    const [one, two] = [replay(), replay()];
    expect([one.status, one.stderr, two.status, two.stderr]).toEqual([
      0,
      "",
      0,
      "",
    ]);
    expect(one.stdout).toBe(two.stdout);
    const { held, applied, stored, rows } = jsonToConvex(
      JSON.parse(one.stdout),
    ) as unknown as {
      held: string;
      applied: string;
      stored: string;
      rows: ReadonlyArray<{ token: string }>;
    };
    expect(applied).toBe(held);
    expect(rows.map((row) => row.token)).toEqual([held, stored]);
  }, 60_000);

  it.effect(
    "a signed token verifies against the deployment's JWKS, and one runtime seed gives one key",
    () =>
      Effect.gen(function* () {
        const seeded = (value: number) =>
          convexTest({
            schema: defineSchema({}),
            modules: { "_generated/server.ts": () => Promise.resolve({}) },
            runtime: {
              now: () => start,
              commitTs: (version: number) => BigInt(version),
              random: () => value,
            },
          }) as KernelControls;
        const keys = (t: KernelControls) =>
          Effect.promise(() => t.jwks()).pipe(
            Effect.map((jwks) => jwks.keys[0]!),
          );
        const first = yield* keys(seeded(0.25));
        expect(yield* keys(seeded(0.25))).toEqual(first);
        expect((yield* keys(seeded(0.75))).kid).not.toBe(first.kid);
        const t = seeded(0.25);
        const token = yield* Effect.promise((): Promise<string> =>
          t.mutation((ctx: any) =>
            ctx.auth.signJwt({
              claims: { sub: "outbox" },
              expiresInSeconds: 60,
            }),
          ),
        );
        const [header, payload, signature] = token.split(".");
        const verified = yield* Effect.promise(() =>
          crypto.subtle
            .importKey(
              "jwk",
              first,
              { name: "ECDSA", namedCurve: "P-256" },
              false,
              ["verify"],
            )
            .then((key) =>
              crypto.subtle.verify(
                { name: "ECDSA", hash: "SHA-256" },
                key,
                Buffer.from(signature!, "base64url"),
                new TextEncoder().encode(`${header}.${payload}`),
              ),
            ),
        );
        expect(verified).toBe(true);
      }),
  );

  it.effect(
    "a backend that drew its signing key refuses a snapshot, which does not carry the key",
    () =>
      Effect.gen(function* () {
        const fresh = () =>
          convexTest({
            schema: defineSchema({}),
            modules: { "_generated/server.ts": () => Promise.resolve({}) },
            runtime: {
              now: () => start,
              commitTs: (version: number) => BigInt(version),
              random: () => 0.5,
            },
          }) as KernelControls;
        const source = fresh();
        const before = source.exportSnapshot();
        yield* Effect.promise(() => source.jwks());
        expect(() => source.exportSnapshot()).toThrow(
          expect.objectContaining({
            _tag: "SnapshotSigningKey",
            operation: "export",
          }),
        );
        const signed = fresh();
        yield* Effect.promise(() => signed.jwks());
        const restore = yield* Effect.promise(() =>
          signed.restoreSnapshot(before).then(
            () => undefined,
            (error: unknown) => error,
          ),
        );
        expect(restore).toMatchObject({
          _tag: "SnapshotSigningKey",
          operation: "restore",
        });
        yield* Effect.promise(() => fresh().restoreSnapshot(before));
      }),
  );
});
