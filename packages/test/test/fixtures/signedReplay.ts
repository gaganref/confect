// One history that stores a signed token on the test kernel, printed as bytes.
// `Identity.test.ts` runs this file in two processes and compares their output.
import {
  defineSchema,
  defineTable,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { convexToJson, v } from "convex/values";
import * as Effect from "effect/Effect";
import { convexTest, type KernelControls } from "../../src/internal/ConvexTest";

const schema = defineSchema({ tokens: defineTable({ token: v.string() }) });

const modules = {
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
      dump: queryGeneric({
        args: {},
        handler: (ctx) => ctx.db.query("tokens").collect(),
      }),
    }),
};

const tokens = {
  store: makeFunctionReference<"mutation", {}, string>("tokens:store"),
  dump: makeFunctionReference<"query">("tokens:dump"),
};

// A seeded stream, so both processes draw the same values.
const stream = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const history = Effect.gen(function* () {
  const t: KernelControls = convexTest({
    schema,
    modules,
    runtime: {
      now: () => 1_767_225_600_000,
      commitTs: (version: number) => 1_000n + BigInt(version),
      random: stream(7),
    },
  });
  const call = <A>(thunk: () => Promise<A>) => Effect.promise(thunk);
  const held = yield* call(() => t.prepare(tokens.store, {}));
  const applied = yield* call(() => t.apply(held.id));
  const stored = yield* call(() => t.mutation(tokens.store, {}));
  const rows = yield* call(() => t.query(tokens.dump, {}));
  const jwks = yield* call(() => t.jwks());
  // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- The bytes compared are Convex's own JSON encoding of the history.
  process.stdout.write(
    JSON.stringify(
      convexToJson({
        held:
          held.outcome._tag === "returned"
            ? held.outcome.value
            : held.outcome._tag,
        applied: applied.kind === "applied" ? applied.result : applied.kind,
        stored,
        rows,
        jwks: jwks as any,
      }),
    ),
  );
});

void Effect.runPromise(history);
