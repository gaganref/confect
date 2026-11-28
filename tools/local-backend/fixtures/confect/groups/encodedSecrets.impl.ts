import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import databaseSchema from "../_generated/schema";
import encodedSecrets from "./encodedSecrets.spec";

const make = FunctionImpl.make;

export default GroupImpl.make(databaseSchema, encodedSecrets).pipe(
  Layer.provide([
    make(databaseSchema, encodedSecrets, "releasedTake", () =>
      Effect.succeed(null),
    ),
    make(databaseSchema, encodedSecrets, "structTake", () =>
      Effect.succeed(null),
    ),
    make(databaseSchema, encodedSecrets, "midChainTake", () =>
      Effect.succeed(null),
    ),
    make(databaseSchema, encodedSecrets, "releasedGive", ({ value }) =>
      // oxlint-disable-next-line effecttsgo/global-date -- A Date is a class instance Convex cannot serialize.
      Effect.succeed({ extra: new Date(0), value }),
    ),
    make(databaseSchema, encodedSecrets, "structGive", ({ value }) =>
      // oxlint-disable-next-line effecttsgo/global-date -- A Date is a class instance Convex cannot serialize.
      Effect.succeed({ extra: new Date(0), value }),
    ),
    make(databaseSchema, encodedSecrets, "midChainGive", ({ value }) =>
      // oxlint-disable-next-line effecttsgo/global-date -- A Date is a class instance Convex cannot serialize.
      Effect.succeed({ extra: new Date(0), value }),
    ),
  ]),
  GroupImpl.finalize,
);
