// oxlint-disable-next-line effecttsgo/node-builtin-import -- The replay test compares the exact stdout of two fresh Node processes.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import {
  defineSchema,
  defineTable,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { convexTest, type KernelControls } from "../src/internal/ConvexTest";
import * as KernelRefusal from "../src/internal/KernelRefusal";
import * as Redaction from "../src/internal/Redaction";
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

  it.effect("a subscriber that presents a token waits for Sync", () =>
    Effect.gen(function* () {
      const { jwks, cases } = yield* mint(start / 1000);
      const { t } = world([{ ...provider, jwks }]);
      expect(() => t.withToken(cases[0]!.token).subscriber()).toThrow(
        expect.objectContaining({ _tag: "KernelRowPending", row: 7 }),
      );
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

/**
 * A test world whose stream is mulberry32 from `seed`, as `TestConfect.layer`'s
 * kernel target makes, counting its draws.
 */
const worldOf = (seed: number) => {
  let state = seed >>> 0;
  const world = {
    name: `seed ${seed}`,
    services: Context.empty(),
    clock: () => start,
    draws: 0,
    random: () => {
      world.draws++;
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    },
  };
  return world;
};

const tokens = {
  store: makeFunctionReference<"mutation", {}, string>("tokens:store"),
  list: makeFunctionReference<"query", {}, Array<string>>("tokens:list"),
};

/**
 * A backend that signs and stores tokens, opened in `world` or in none.
 */
const signer = (world?: ReturnType<typeof worldOf>) =>
  convexTest({
    schema: defineSchema({ tokens: defineTable({ token: v.string() }) }),
    modules: {
      "_generated/server.ts": () => Promise.resolve({}),
      "tokens.ts": () =>
        Promise.resolve({
          store: mutationGeneric({
            args: {},
            handler: (ctx) =>
              (
                ctx.auth as unknown as {
                  signJwt: (options: object) => Promise<string>;
                }
              )
                .signJwt({ claims: { sub: "outbox" }, expiresInSeconds: 60 })
                .then((token) =>
                  ctx.db.insert("tokens", { token }).then(() => token),
                ),
          }),
          list: queryGeneric({
            args: {},
            handler: (ctx) =>
              ctx.db
                .query("tokens")
                .collect()
                .then((rows) => rows.map((row) => row.token)),
          }),
        }),
    },
    runtime: { now: () => start, commitTs: (version) => BigInt(version) },
    ...(world === undefined ? {} : { world }),
  }) as KernelControls;

const verifies = (key: JsonWebKey, token: string) => {
  const [header, payload, signature] = token.split(".");
  return Effect.promise(() =>
    crypto.subtle
      .importKey("jwk", key, { name: "ECDSA", namedCurve: "P-256" }, false, [
        "verify",
      ])
      .then((imported) =>
        crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          imported,
          Buffer.from(signature!, "base64url"),
          new TextEncoder().encode(`${header}.${payload}`),
        ),
      ),
  );
};

const kidOf = (token: string): string =>
  JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString()).kid;

const failure = (run: () => Promise<unknown>) =>
  Effect.promise(() =>
    run().then(
      () => undefined,
      (error: unknown) => error,
    ),
  );

describe("deployment signing", () => {
  it("two processes storing signed tokens through TestConfect.layer with one seed commit the same bytes, and another seed signs with another key", () => {
    const loader = pathToFileURL(
      createRequire(import.meta.url).resolve("tsx/esm"),
    ).href;
    const script = fileURLToPath(
      new URL("fixtures/signedReplay.ts", import.meta.url),
    );
    const replay = (...seed: Array<string>) =>
      spawnSync(process.execPath, ["--import", loader, script, ...seed], {
        encoding: "utf8",
      });
    const [one, two, other] = [replay(), replay(), replay("7")];
    expect(
      [one, two, other].flatMap(({ status, stderr }) => [status, stderr]),
    ).toEqual([0, "", 0, "", 0, ""]);
    expect(one.stdout).toBe(two.stdout);
    const read = (stdout: string) =>
      JSON.parse(stdout) as {
        returned: ReadonlyArray<string>;
        rows: ReadonlyArray<string>;
      };
    const ours = read(one.stdout);
    expect(ours.rows).toEqual(ours.returned);
    expect(kidOf(read(other.stdout).returned[0]!)).not.toBe(
      kidOf(ours.returned[0]!),
    );
  }, 60_000);

  it.effect(
    "a signed token verifies against the JWKS of the key its world drew, and one seed gives one key",
    () =>
      Effect.gen(function* () {
        const keyOf = (t: KernelControls) =>
          Effect.promise(() => t.jwks()).pipe(
            Effect.map((jwks) => jwks.keys[0]!),
          );
        const first = yield* keyOf(signer(worldOf(1)));
        expect(yield* keyOf(signer(worldOf(1)))).toEqual(first);
        expect((yield* keyOf(signer(worldOf(2)))).kid).not.toBe(first.kid);
        const t = signer(worldOf(1));
        const token = yield* Effect.promise(() => t.mutation(tokens.store, {}));
        expect(yield* verifies(first, token)).toBe(true);
      }),
  );

  it.effect(
    "a backend with no world, and no invocation bound, refuses to draw its signing key",
    () =>
      Effect.gen(function* () {
        const t = signer();
        expect(yield* failure(() => t.jwks())).toMatchObject({
          _tag: "SigningKeyRandomUnavailable",
        });
        expect(
          yield* failure(() => t.mutation(tokens.store, {})),
        ).toMatchObject({ _tag: "SigningKeyRandomUnavailable" });
      }),
  );

  it.effect(
    "a snapshot carries the signing key's seed as a secret marker, and a restore given the secrets verifies the same tokens without drawing",
    () =>
      Effect.gen(function* () {
        const source = signer(worldOf(3));
        const token = yield* Effect.promise(() =>
          source.mutation(tokens.store, {}),
        );
        const [key] = (yield* Effect.promise(() => source.jwks())).keys;
        const bytes = source.exportSnapshot();
        const text = new TextDecoder().decode(bytes);
        // The seed is the stream's first 32 draws as bytes, in hex.
        const replica = worldOf(3);
        const seed = Array.from({ length: 32 }, () =>
          Math.floor(replica.random() * 256)
            .toString(16)
            .padStart(2, "0"),
        ).join("");
        expect(text).not.toContain(seed);
        expect(
          JSON.parse(text.slice(text.indexOf("\n") + 1)).signingKey,
        ).toEqual({ [Redaction.markerKey]: expect.any(Number) });

        const restored = signer();
        yield* Effect.promise(() =>
          restored.restoreSnapshot(bytes, { secrets: source.secrets() }),
        );
        expect((yield* Effect.promise(() => restored.jwks())).keys).toEqual([
          key,
        ]);
        const [stored] = yield* Effect.promise(() =>
          restored.query(tokens.list, {}),
        );
        expect(stored).toBe(token);
        expect(yield* verifies(key!, stored!)).toBe(true);
        const next = yield* Effect.promise(() =>
          restored.mutation(tokens.store, {}),
        );
        expect(yield* verifies(key!, next)).toBe(true);

        expect(
          yield* failure(() => signer().restoreSnapshot(bytes)),
        ).toMatchObject({ _tag: "SnapshotSecretMissing" });
      }),
  );
});
