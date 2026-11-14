import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import databaseSchema from "./_generated/schema";
import egressNode from "./egressNode.spec";

/**
 * A URL `egressModuleLoad.test.ts` leaves on `globalThis` before the backend
 * loads this module, which its top level then fetches, as a client that warms
 * up when it is imported does. Unset, as in every other case, the module
 * fetches nothing while it loads.
 */
const warmUp: unknown = Reflect.get(
  globalThis,
  Symbol.for("@confect/server/test/egressWarmUp"),
);
if (typeof warmUp === "string") {
  // oxlint-disable-next-line effecttsgo/global-fetch -- The module's top level makes the raw fetch the test kernel refuses and the binary's Node executor performs.
  fetch(warmUp).catch(() => undefined);
}

const rawFetchNode = FunctionImpl.make(
  databaseSchema,
  egressNode,
  "rawFetchNode",
  ({ url }) =>
    // oxlint-disable-next-line effecttsgo/global-fetch-in-effect -- The action makes the raw fetch the test kernel refuses and the binary performs.
    Effect.promise(() => fetch(url).then((response) => response.text())),
);

export default GroupImpl.make(databaseSchema, egressNode).pipe(
  Layer.provide(rawFetchNode),
  GroupImpl.finalize,
);
