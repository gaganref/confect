import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import schema from "./_generated/schema";
import { peers } from "./peerList";
import spec from "./peersNodeTwo.spec";

const read = FunctionImpl.make(schema, spec, "read", () => Effect.sync(peers));

export default GroupImpl.make(schema, spec).pipe(
  Layer.provide(read),
  GroupImpl.finalize,
);
