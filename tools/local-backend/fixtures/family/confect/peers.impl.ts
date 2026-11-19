import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Auth from "@confect/server/Auth";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import schema from "./_generated/schema";
import { match, peers } from "./peerList";
import spec from "./peers.spec";

const read = FunctionImpl.make(schema, spec, "read", () =>
  Effect.map(Auth.getUserIdentity, (identity) => ({
    peers: peers(),
    caller: identity._tag === "Valid" ? match(identity.identity.issuer) : null,
  })),
);

export default GroupImpl.make(schema, spec).pipe(
  Layer.provide(read),
  GroupImpl.finalize,
);
