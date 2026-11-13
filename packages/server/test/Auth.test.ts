import * as Auth from "@confect/server/Auth";
import { expect, expectTypeOf, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

it("requires Auth without a typed failure", () => {
  expectTypeOf(Auth.getUserIdentity).toEqualTypeOf<
    Effect.Effect<Auth.Identity, never, Auth.Auth>
  >();
});

const verifiedIdentity = {
  tokenIdentifier: "https://synthetic.invalid|person",
  issuer: "https://synthetic.invalid",
  subject: "person",
  name: "Synthetic Person",
  role: "student",
};

it.effect("reports an absent identity without failing", () =>
  Effect.gen(function* () {
    const identity = yield* Auth.getUserIdentity;
    expect(identity).toEqual({ _tag: "Absent" });
  }).pipe(
    Effect.provide(
      Auth.layer({ getUserIdentity: () => Promise.resolve(null) }),
    ),
  ),
);

it.effect(
  "returns Convex's verified identity without changing its claims",
  () =>
    Effect.gen(function* () {
      const identity = yield* Auth.getUserIdentity;
      expect(identity).toEqual({ _tag: "Valid", identity: verifiedIdentity });
    }).pipe(
      Effect.provide(
        Auth.layer({
          getUserIdentity: () => Promise.resolve(verifiedIdentity),
        }),
      ),
    ),
);

it.effect("reads identity again when the effect runs again", () => {
  let signedIn = true;
  return Effect.gen(function* () {
    const first = yield* Auth.getUserIdentity;
    signedIn = false;
    const second = yield* Auth.getUserIdentity;
    expect([first, second]).toEqual([
      { _tag: "Valid", identity: verifiedIdentity },
      { _tag: "Absent" },
    ]);
  }).pipe(
    Effect.provide(
      Auth.layer({
        getUserIdentity: () =>
          Promise.resolve(signedIn ? verifiedIdentity : null),
      }),
    ),
  );
});

it.effect(
  "preserves interruption instead of reporting invalid credentials",
  () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(Auth.getUserIdentity);
      expect(Exit.hasInterrupts(result)).toBe(true);
    }).pipe(
      Effect.provideService(Auth.Auth, {
        getUserIdentity: Effect.interrupt,
      }),
    ),
);

it.effect("keeps the existing service member's missing-identity error", () =>
  Effect.gen(function* () {
    const auth = yield* Auth.Auth;
    const error = yield* Effect.flip(auth.getUserIdentity);
    expect(error).toBeInstanceOf(Auth.NoUserIdentityFoundError);
  }).pipe(
    Effect.provide(
      Auth.layer({ getUserIdentity: () => Promise.resolve(null) }),
    ),
  ),
);

it.effect("reports credentials rejected by Convex without failing", () =>
  Effect.gen(function* () {
    const identity = yield* Auth.getUserIdentity;
    expect(identity).toEqual({ _tag: "Invalid" });
  }).pipe(
    Effect.provide(
      Auth.layer({
        getUserIdentity: () => Promise.reject(new Error("InvalidAuthHeader")),
      }),
    ),
  ),
);
