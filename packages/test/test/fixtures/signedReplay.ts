// One history that stores signed tokens through `TestConfect.layer` on the
// kernel target, printed as bytes. `Identity.test.ts` runs this file in several
// processes and compares their output. `process.argv[2]`, when given, is the
// layer's seed.
import { DatabaseSchema, MutationCtx } from "@confect/server";
import {
  defineSchema,
  defineTable,
  type GenericDataModel,
} from "convex/server";
import { v } from "convex/values";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestConfect from "../../src/TestConfect";

// `Date` is pinned, and the kernel target's clock follows it, so a signed
// token's times replay.
const now = Date.UTC(2026, 0, 14, 22, 15, 0);
const RealDate = globalThis.Date;
class PinnedDate extends RealDate {
  constructor(...args: Array<unknown>) {
    if (args.length === 0) super(now);
    else super(...(args as [number]));
  }
  static override now() {
    return now;
  }
}
globalThis.Date = PinnedDate as DateConstructor;

const schema = DatabaseSchema.make({});
const seed = process.argv[2];

const mutation = <A>(
  use: (ctx: MutationCtx.MutationCtx<GenericDataModel>) => Promise<A>,
) =>
  Effect.gen(function* () {
    const ctx = yield* MutationCtx.MutationCtx<GenericDataModel>();
    return yield* Effect.promise(() => use(ctx));
  });

// Signs a token for `sub` and stores it, answering the token.
const store = (sub: string) =>
  mutation((ctx) =>
    (
      ctx.auth as unknown as {
        signJwt: (options: object) => Promise<string>;
      }
    )
      .signJwt({ claims: { sub }, expiresInSeconds: 60 })
      .then((token) => ctx.db.insert("tokens", { token }).then(() => token)),
  );

const history = Effect.gen(function* () {
  const test = yield* TestConfect.TestConfect<typeof schema>();
  const first = yield* test.run(store("outbox"), Schema.String);
  const second = yield* test.run(store("inbox"), Schema.String);
  const rows = yield* test.run(
    mutation((ctx) =>
      ctx.db
        .query("tokens")
        .collect()
        .then((stored) => stored.map(({ token }) => token as string)),
    ),
    Schema.mutable(Schema.Array(Schema.String)),
  );
  // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- The bytes compared are the returned and committed tokens as plain JSON.
  process.stdout.write(JSON.stringify({ returned: [first, second], rows }));
}).pipe(
  Effect.provide(
    TestConfect.layer(
      schema,
      defineSchema({ tokens: defineTable({ token: v.string() }) }),
      { "_generated/server.ts": () => Promise.resolve({}) },
      {
        target: "kernel",
        ...(seed === undefined ? {} : { seed: Number(seed) }),
      },
    ),
  ),
);

void Effect.runPromise(history);
