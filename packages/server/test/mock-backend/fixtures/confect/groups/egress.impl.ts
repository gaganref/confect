import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import databaseSchema from "../_generated/schema";
import egress from "./egress.spec";

const rawFetch = FunctionImpl.make(
  databaseSchema,
  egress,
  "rawFetch",
  ({ url }) =>
    // oxlint-disable-next-line effecttsgo/global-fetch-in-effect -- The action makes the raw fetch the test kernel refuses and the binary performs.
    Effect.promise(() => fetch(url).then((response) => response.text())),
);

export default GroupImpl.make(databaseSchema, egress).pipe(
  Layer.provide(rawFetch),
  GroupImpl.finalize,
);
