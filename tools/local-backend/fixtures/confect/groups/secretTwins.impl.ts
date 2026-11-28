import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import databaseSchema from "../_generated/schema";
import secretTwins from "./secretTwins.spec";

const secretValue = Redacted.make("x");
const make = FunctionImpl.make;

export default GroupImpl.make(databaseSchema, secretTwins).pipe(
  Layer.provide([
    make(databaseSchema, secretTwins, "countPlain", () => Effect.succeed(null)),
    make(databaseSchema, secretTwins, "countSecret", () =>
      Effect.succeed(null),
    ),
    make(databaseSchema, secretTwins, "idPlain", () => Effect.succeed(null)),
    make(databaseSchema, secretTwins, "idSecret", () => Effect.succeed(null)),
    // An object literal omits an own `toString`, though its type sees the one
    // it inherits.
    make(databaseSchema, secretTwins, "toStringPlain", () =>
      Effect.succeed({ value: "x" } as never),
    ),
    make(databaseSchema, secretTwins, "toStringSecret", () =>
      Effect.succeed({ value: secretValue } as never),
    ),
    make(databaseSchema, secretTwins, "datePlain", ({ value }) =>
      // oxlint-disable-next-line effecttsgo/global-date -- A Date is a class instance Convex cannot serialize.
      Effect.succeed({ extra: new Date(0), value }),
    ),
    make(databaseSchema, secretTwins, "dateSecret", ({ value }) =>
      // oxlint-disable-next-line effecttsgo/global-date -- A Date is a class instance Convex cannot serialize.
      Effect.succeed({ extra: new Date(0), value }),
    ),
    make(databaseSchema, secretTwins, "tokenPlain", () => Effect.succeed(null)),
    make(databaseSchema, secretTwins, "tokenSecret", () =>
      Effect.succeed(null),
    ),
  ]),
  GroupImpl.finalize,
);
