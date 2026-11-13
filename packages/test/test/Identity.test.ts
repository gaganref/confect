import { describe, expect, it } from "@effect/vitest";
import {
  defineSchema,
  makeFunctionReference,
  queryGeneric,
} from "convex/server";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { convexTest, type KernelControls } from "../src/internal/ConvexTest";
import * as KernelRefusal from "../src/internal/KernelRefusal";
import {
  mint,
  provider,
  type VerifierCase,
  type VerifierOutcome,
} from "./fixtures/minted";

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
});
