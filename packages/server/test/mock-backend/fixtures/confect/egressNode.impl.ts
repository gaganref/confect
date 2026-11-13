// oxlint-disable effecttsgo/global-fetch-in-effect -- The Node action makes the raw fetch the test kernel refuses.
import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import databaseSchema from "./_generated/schema";
import egressNode from "./egressNode.spec";

const rawFetchNode = FunctionImpl.make(
  databaseSchema,
  egressNode,
  "rawFetchNode",
  ({ url }) =>
    Effect.promise(() => fetch(url).then((response) => response.text())),
);

export default GroupImpl.make(databaseSchema, egressNode).pipe(
  Layer.provide(rawFetchNode),
  GroupImpl.finalize,
);
