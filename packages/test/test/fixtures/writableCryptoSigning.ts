// A `crypto` a test left non-configurable but writable, so the kernel installs
// its own by assignment, in place. The kernel's signing then reads the host's
// `crypto` captured at load: a mutation signs a deployment JWT, counting the
// draws its world's stream gives, and a snapshot restored with its secrets into
// a backend with no world signs again. Printed as bytes. A non-configurable
// global cannot be undone in a process, so `Randomness.test.ts` runs this in a
// process of its own.
import {
  defineSchema,
  defineTable,
  makeFunctionReference,
  mutationGeneric,
} from "convex/server";
import { v } from "convex/values";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { convexTest, type KernelControls } from "../../src/internal/ConvexTest";
import * as DriverWorld from "../../src/internal/DriverWorld";
import * as Entropy from "../../src/internal/Entropy";
import type * as Invocation from "../../src/internal/Invocation";
import { withSources } from "./inlineSources";

const UnknownJson = Schema.fromJsonString(Schema.Unknown);

Object.defineProperty(globalThis, "crypto", {
  value: globalThis.crypto,
  writable: true,
  configurable: false,
});

const store = makeFunctionReference<"mutation", {}, string>("tokens:store");

const signer = (world?: Invocation.World): KernelControls =>
  convexTest({
    schema: defineSchema({ tokens: defineTable({ token: v.string() }) }),
    ...withSources({
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
        }),
    }),
    ...(world === undefined ? {} : { world }),
  }) as KernelControls;

const seeded = DriverWorld.make("signing", 7);
let draws = 0;
const counted: Invocation.World = {
  ...seeded,
  random: () => {
    draws++;
    return seeded.random();
  },
};

const settle = <A>(call: () => Promise<A>) =>
  Effect.promise(() =>
    call().then(
      (value) => ({ outcome: "ran" as const, value }),
      (error: unknown) => ({
        outcome: "refused" as const,
        tag: (error as { _tag?: unknown })._tag ?? null,
        message: (error as Error).message,
      }),
    ),
  );

const run = Effect.gen(function* () {
  const source = signer(counted);
  const signed = yield* settle(() => source.mutation(store, {}));
  const signingDraws = draws;
  const bytes = source.exportSnapshot();
  const restored = signer();
  yield* Effect.promise(() =>
    restored.restoreSnapshot(bytes, { secrets: source.secrets() }),
  );
  const restoredSigned = yield* settle(() => restored.mutation(store, {}));
  const sourceKeys = yield* Effect.promise(() => source.jwks());
  const restoredKeys = yield* Effect.promise(() => restored.jwks());
  const output = yield* Schema.encodeEffect(UnknownJson)({
    // The global itself now holds the kernel's crypto, assigned in place.
    installedInPlace: Entropy.isBuilt(
      Object.getOwnPropertyDescriptor(globalThis, "crypto")?.value,
    ),
    signed: signed.outcome,
    signingDraws,
    restoredSigned: restoredSigned.outcome,
    restoredRefusal:
      restoredSigned.outcome === "refused" ? restoredSigned.tag : null,
    sameKey:
      sourceKeys.keys[0]?.kid !== undefined &&
      sourceKeys.keys[0]?.kid === restoredKeys.keys[0]?.kid,
  });
  process.stdout.write(output);
});

void Effect.runPromise(run);
