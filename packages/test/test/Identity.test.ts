// oxlint-disable-next-line effecttsgo/node-builtin-import -- The replay test compares the exact stdout of two fresh Node processes.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import {
  defineSchema,
  defineTable,
  httpActionGeneric,
  httpRouter,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { convexTest, type KernelControls } from "../src/internal/ConvexTest";
import * as Json from "../src/internal/Json";
import * as KernelRefusal from "../src/internal/KernelRefusal";
import * as Redaction from "../src/internal/Redaction";
import {
  jwksUrl,
  mint,
  throughHop,
  provider,
  rsaKeys,
  sign,
  type VerifierCase,
  type VerifierOutcome,
} from "../../../tools/local-backend/fixtures/minted";
import * as TokenReview from "../../../tools/local-backend/fixtures/tokenReview";
import * as TokenReviewHop from "../../../tools/local-backend/fixtures/plain/convex/tokenReview";
import { oversizedRsa } from "./fixtures/oversized";
import { withSources } from "./fixtures/inlineSources";
import { plainSource } from "./fixtures/fixtureSources";

const whoami = makeFunctionReference<"query", {}, object | null>(
  "identity:whoami",
);

const UnknownJson = Schema.fromJsonString(Schema.Unknown);

const start = 1_800_000_000_000;

/**
 * What `run` throws, or `undefined` when it returns.
 */
const thrown = (run: () => unknown): unknown => {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
};

/**
 * The route the local-backend fixture answers at `TokenReview.path`, as a plain
 * Convex HTTP action.
 */
const reviewRouter = () => {
  const router = httpRouter();
  router.route({
    path: TokenReview.path,
    method: "GET",
    handler: httpActionGeneric((ctx) =>
      ctx.auth.getUserIdentity().then(
        (identity) => Response.json(TokenReview.identified(identity)),
        (error: unknown) => Response.json(TokenReview.threw(error)),
      ),
    ),
  });
  return router;
};

/**
 * A backend whose `auth.config` declares `providers`, and a count of the
 * handler runs, so a refusal is seen to come before any function. Its modules
 * load once `loaded` settles.
 */
const world = (
  providers: ReadonlyArray<object> | undefined,
  loaded: Promise<void> = Promise.resolve(),
) => {
  const runs = { count: 0 };
  const t: KernelControls = convexTest({
    schema: defineSchema({}),
    modules: {
      "_generated/server.ts": () => loaded.then(() => ({})),
      "http.ts": () => Promise.resolve({ default: reviewRouter() }),
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
      const minted = Option.getOrThrow(
        Arr.findFirst(cases, (c) => c.name === name),
      );
      const outcome1 = yield* outcome(t, minted.token);
      expect(outcome1).toEqual(minted.expected);
      expect(runs.count).toBe(minted.expected._tag === "accepted" ? 1 : 0);
    }),
  );
});

describe("HTTP actions under a presented token", () => {
  it.effect.each(names)("%s", (name) =>
    Effect.gen(function* () {
      const { jwks, cases } = yield* mint(start / 1000);
      const { t } = world([{ ...provider, jwks }]);
      const minted = Option.getOrThrow(
        Arr.findFirst(cases, (c) => c.name === name),
      );
      const response = yield* Effect.promise(() =>
        t.withToken(minted.token).fetch(TokenReview.path),
      );
      expect(response.status).toBe(200);
      const review = yield* Effect.promise(() => response.json());
      expect(review).toEqual(minted.review(start / 1000));
    }),
  );
});

/**
 * A backend of the local-backend suite's plain fixture, whose `auth.config`
 * declares the minted tokens' provider with `jwks`.
 */
const plainWorld = (jwks: string): KernelControls =>
  convexTest({
    schema: defineSchema({}),
    // The plain fixture's files are their own sources.
    ...withSources(
      {
        "_generated/server.ts": () => Promise.resolve({}),
        "auth.config.ts": () =>
          Promise.resolve({ default: { providers: [{ ...provider, jwks }] } }),
        "convexErrors.ts": () =>
          import("../../../tools/local-backend/fixtures/plain/convex/convexErrors"),
        "tokenReview.ts": () =>
          import("../../../tools/local-backend/fixtures/plain/convex/tokenReview"),
        "http.ts": () =>
          import("../../../tools/local-backend/fixtures/plain/convex/http"),
      },
      {
        "convexErrors.ts": plainSource("convexErrors.ts"),
        "tokenReview.ts": plainSource("tokenReview.ts"),
        "http.ts": plainSource("http.ts"),
      },
    ),
    runtime: { now: () => start, commitTs: (version) => BigInt(version) },
  });

describe("an HTTP action's calls under a presented token", () => {
  it.effect.each(
    Arr.flatMap(names, (name) =>
      Arr.map(TokenReviewHop.hops, (hop) => ({ name, hop })),
    ),
  )("$name, through $hop", ({ name, hop }) =>
    Effect.gen(function* () {
      const { jwks, cases } = yield* mint(start / 1000);
      const t = plainWorld(jwks);
      const minted = Option.getOrThrow(
        Arr.findFirst(cases, (c) => c.name === name),
      );
      const response = yield* Effect.promise(() =>
        t.withToken(minted.token).fetch(`${TokenReviewHop.path}?hop=${hop}`),
      );
      expect(response.status).toBe(200);
      const review = yield* Effect.promise(() => response.json());
      expect(review).toEqual(throughHop(minted.review(start / 1000), hop));
    }),
  );
});

describe("a presented token is part of its call", () => {
  const calls = {
    query: (t: KernelControls) => t.query(() => null),
    mutation: (t: KernelControls) => t.mutation(() => null),
    action: (t: KernelControls) => t.action(() => null),
    fetch: (t: KernelControls) => t.fetch(TokenReview.path),
  };
  it.effect.each(Rec.keys(calls))(
    "a %s whose token is still being verified refuses export and restore, as a call without a token does",
    (kind) =>
      Effect.gen(function* () {
        const blank = world(undefined).t.exportSnapshot();
        const { promise: loaded, resolve: load } =
          Promise.withResolvers<void>();
        const { t } = world(undefined, loaded);
        const settled = calls[kind](t.withToken("not-a-jwt")).then(
          () => undefined,
          () => undefined,
        );
        const running = {
          _tag: "SnapshotWorldRunning",
          registry: "running",
          count: 1,
        };
        expect(thrown(() => t.exportSnapshot())).toMatchObject(running);
        const restore = yield* Effect.promise(() =>
          t.restoreSnapshot(blank).then(
            () => undefined,
            (error: unknown) => error,
          ),
        );
        expect(restore).toMatchObject(running);
        load();
        yield* Effect.promise(() => settled);
        expect(thrown(() => t.exportSnapshot())).toBeUndefined();
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
        const valid = Option.getOrThrow(
          Arr.findFirst(cases, (c) => c.name === "valid control"),
        );
        yield* Effect.promise(() => t.advance(15_000));
        const outcome2 = yield* outcome(t, valid.token);
        expect(outcome2).toEqual(valid.expected);
        yield* Effect.promise(() => t.advance(1_000));
        const outcome3 = yield* outcome(t, valid.token);
        expect(outcome3).toEqual({
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
      const outcome4 = yield* outcome(t, cases[0]!.token);
      expect(outcome4).toEqual({
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
        const outcome5 = yield* outcome(oidc.t, token);
        expect(outcome5).toMatchObject({
          _tag: "RequiresBinary",
          operation: "oidcDiscovery",
        });
        const remote = world([
          { ...provider, jwks: "https://confect-auth.invalid/jwks.json" },
        ]);
        const outcome6 = yield* outcome(remote.t, token);
        expect(outcome6).toMatchObject({
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
          pipe(
            Arr.findFirst(cases, (c) => c.name === name),
            Option.getOrThrow,
          ).token;
        const valid = pipe(
          Arr.findFirst(cases, (c) => c.name === "valid control"),
          Option.getOrThrow,
        );
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
          subscriber.present(token("wrong issuer")).then(
            () => undefined,
            (error: unknown) => error,
          ),
        );
        expect(rejected).toMatchObject({
          _tag: "InvalidToken",
          code: "NoAuthProvider",
        });
        expect(subscriber.identityVersion).toBe(before);
        const unchanged = yield* Effect.promise(() => t.refresh());
        expect(unchanged).toEqual([]);

        const other = yield* signDeclared({ sub: "other" });
        yield* Effect.promise(() => subscriber.present(other));
        expect(subscriber.identityVersion).toBeGreaterThan(before);
        const refreshed = yield* Effect.promise(() => t.refresh());
        expect(refreshed).toEqual([
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
            .withToken(token("foreign key"))
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
      const outcome7 = yield* outcome(t, cases[0]!.token);
      expect(outcome7).toMatchObject({
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
        const outcome8 = yield* outcome(t, inside);
        expect(outcome8).toMatchObject({ _tag: "accepted" });
        const outside = yield* signDeclared({ exp: now - 5.6 });
        const outcome9 = yield* outcome(t, outside);
        expect(outcome9).toEqual(refused("InvalidAuthHeader"));
        const negative = yield* signDeclared({ nbf: -1 });
        const outcome10 = yield* outcome(t, negative);
        expect(outcome10).toEqual(refused("InvalidAuthHeader"));
      }),
  );

  it.effect.each([
    { claim: "exp", offset: -60, message: "Token expired 60 seconds ago" },
    { claim: "nbf", offset: 60, message: "Token will be valid in 60 seconds" },
    { claim: "iat", offset: 60, message: "Token will be valid in 60 seconds" },
  ])(
    "a token outside its times is refused with biscuit's message, counting the seconds: $message",
    ({ claim, offset, message }) =>
      Effect.gen(function* () {
        const now = start / 1000;
        const { jwks, signDeclared } = yield* mint(now);
        const { t } = world([{ ...provider, jwks }]);
        const token = yield* signDeclared({ [claim]: now + offset });
        const refusal = yield* Effect.promise(() =>
          t
            .withToken(token)
            .query(whoami, {})
            .then(
              () => undefined,
              (error: unknown) => error,
            ),
        );
        expect(refusal).toMatchObject({
          _tag: "InvalidToken",
          code: "InvalidAuthHeader",
          message: `Could not validate token: ${message}`,
        });
      }),
  );

  it.effect("a JWKS data URL's fragment is dropped before it decodes", () =>
    Effect.gen(function* () {
      const { jwks, cases } = yield* mint(start / 1000);
      const { t } = world([{ ...provider, jwks: `${jwks}#review` }]);
      const outcome11 = yield* outcome(t, cases[0]!.token);
      expect(outcome11).toEqual(cases[0]!.expected);
    }),
  );
});

/**
 * A backend that declares `jwk` under `kid` "test" for `algorithm`, and a token
 * over the valid claims signed with `alg`.
 */
const declaring = (jwk: object, algorithm: "RS256" | "ES256" = "RS256") =>
  Effect.map(
    jwksUrl([{ ...jwk, kid: "test" }]),
    (jwks) => world([{ ...provider, algorithm, jwks }]).t,
  );

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
      const backend = yield* declaring(jwk);
      const outcome12 = yield* outcome(backend, token);
      expect(outcome12).toMatchObject(expected);
    }),
  );

  it.effect(
    "an RS256 key of 16,384 bits is refused, though Web Crypto verifies its signature",
    () =>
      Effect.gen(function* () {
        const key = oversizedRsa(16_384);
        expect(key.bits).toBe(16_384);
        const encode = (value: object) =>
          Effect.map(Schema.encodeEffect(UnknownJson)(value), (json) =>
            Buffer.from(json).toString("base64url"),
          );
        const header = yield* encode({ alg: "RS256", kid: "test" });
        const payload = yield* encode(validClaims);
        const unsigned = `${header}.${payload}`;
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
        const backend = yield* declaring(key.jwk);
        const outcome13 = yield* outcome(backend, token);
        expect(outcome13).toEqual(refused("InvalidAuthHeader"));
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
        const labelled = yield* declaring({ ...jwk, crv: "P-384" }, "ES256");
        const outcome14 = yield* outcome(labelled, token);
        expect(outcome14).toMatchObject({ _tag: "accepted" });
        const malformed = yield* declaring(
          { ...jwk, x: `${jwk.x}AA` },
          "ES256",
        );
        const outcome15 = yield* outcome(malformed, token);
        expect(outcome15).toEqual(refused("InvalidAuthHeader"));
      }),
  );
});

/**
 * A test world whose stream is mulberry32 from `seed`, as `TestConfect.layer`'s
 * kernel target makes.
 */
const worldOf = (seed: number) => {
  let state = seed >>> 0;
  const stream = {
    name: `seed ${seed}`,
    services: Context.empty(),
    clock: () => start,
    random: () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    },
  };
  return stream;
};

const tokens = {
  store: makeFunctionReference<"mutation", {}, string>("tokens:store"),
  list: makeFunctionReference<"query", {}, Array<string>>("tokens:list"),
};

/**
 * A backend that signs and stores tokens, opened in `world` or in none.
 */
const signer = (own?: ReturnType<typeof worldOf>) =>
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
                .then((rows) => Arr.map(rows, (row) => row.token)),
          }),
        }),
    },
    runtime: { now: () => start, commitTs: (version) => BigInt(version) },
    ...(own === undefined ? {} : { world: own }),
  }) as KernelControls;

const verifies = (key: JsonWebKey, token: string) => {
  const [header, payload, signature] = pipe(token, Str.split("."));
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

const kidOf = (token: string): string => {
  const [header] = pipe(token, Str.split("."));
  return Json.parse(Buffer.from(header, "base64url").toString()).kid;
};

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
      Arr.flatMap([one, two, other], ({ status, stderr }) => [status, stderr]),
    ).toEqual([0, "", 0, "", 0, ""]);
    expect(one.stdout).toBe(two.stdout);
    const read = (stdout: string) =>
      Json.parse(stdout) as {
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
        const key1 = yield* keyOf(signer(worldOf(1)));
        expect(key1).toEqual(first);
        const other = yield* keyOf(signer(worldOf(2)));
        expect(other.kid).not.toBe(first.kid);
        const t = signer(worldOf(1));
        const token = yield* Effect.promise(() => t.mutation(tokens.store, {}));
        const verified1 = yield* verifies(first, token);
        expect(verified1).toBe(true);
      }),
  );

  it.effect(
    "a backend with no world, and no invocation bound, refuses to draw its signing key",
    () =>
      Effect.gen(function* () {
        const t = signer();
        const refusal1 = yield* failure(() => t.jwks());
        expect(refusal1).toMatchObject({
          _tag: "SigningKeyRandomUnavailable",
        });
        const refusal2 = yield* failure(() => t.mutation(tokens.store, {}));
        expect(refusal2).toMatchObject({ _tag: "SigningKeyRandomUnavailable" });
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
        const sourceJwks = yield* Effect.promise(() => source.jwks());
        const [key] = sourceJwks.keys;
        const bytes = source.exportSnapshot();
        const text = new TextDecoder().decode(bytes);
        // The seed is the stream's first 32 draws as bytes, in hex.
        const replica = worldOf(3);
        const seed = pipe(
          Arr.makeBy(32, () =>
            pipe(
              Math.floor(replica.random() * 256).toString(16),
              Str.padStart(2, "0"),
            ),
          ),
          Arr.join(""),
        );
        expect(text).not.toContain(seed);
        const [, bodyText] = pipe(text, Str.split("\n"));
        const body = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Struct({ signingKey: Schema.Unknown })),
        )(bodyText);
        expect(body.signingKey).toEqual({
          [Redaction.markerKey]: expect.any(Number),
        });

        const restored = signer();
        yield* Effect.promise(() =>
          restored.restoreSnapshot(bytes, { secrets: source.secrets() }),
        );
        const restoredJwks = yield* Effect.promise(() => restored.jwks());
        expect(restoredJwks.keys).toEqual([key]);
        const [stored] = yield* Effect.promise(() =>
          restored.query(tokens.list, {}),
        );
        expect(stored).toBe(token);
        const verified2 = yield* verifies(key!, stored!);
        expect(verified2).toBe(true);
        const next = yield* Effect.promise(() =>
          restored.mutation(tokens.store, {}),
        );
        const verified3 = yield* verifies(key!, next);
        expect(verified3).toBe(true);

        const refusal3 = yield* failure(() => signer().restoreSnapshot(bytes));
        expect(refusal3).toMatchObject({ _tag: "SnapshotSecretMissing" });
      }),
  );
});
