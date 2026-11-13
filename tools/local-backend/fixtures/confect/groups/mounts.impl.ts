import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import schema from "../_generated/schema";
import { First } from "../first";
import { Second } from "../second";
import spec from "./mounts.spec";

const mountOf = (mount: "first" | "second") =>
  mount === "first" ? First : Second;

const create = FunctionImpl.make(
  schema,
  spec,
  "create",
  ({ mount, run, count }) =>
    Effect.gen(function* () {
      yield* (yield* mountOf(mount)).create(run, count);
      return null;
    }),
);

const counts = FunctionImpl.make(schema, spec, "counts", ({ mount, run }) =>
  Effect.gen(function* () {
    return yield* (yield* mountOf(mount)).counts(run);
  }),
);

const replaced = FunctionImpl.make(schema, spec, "replaced", ({ run }) =>
  Effect.gen(function* () {
    const fake = {
      create: () => Effect.die("unused"),
      counts: () => Effect.succeed([-1]),
    };
    const inside = yield* Effect.gen(function* () {
      return yield* (yield* First).counts(run);
    }).pipe(Effect.provideService(First, fake));
    const outside = yield* (yield* First).counts(run);
    return { inside, outside };
  }),
);

export default GroupImpl.make(schema, spec).pipe(
  Layer.provide([create, counts, replaced]),
  GroupImpl.finalize,
);
