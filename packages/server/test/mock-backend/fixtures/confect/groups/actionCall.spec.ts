import { ActionCall, GroupSpec, MiddlewareSpec } from "@confect/core";
import * as Schema from "effect/Schema";

export class Preflight extends MiddlewareSpec.MiddlewareSpec<Preflight>()(
  "Preflight",
  {
    functionTypes: { query: false, mutation: false, action: true },
  },
) {}

export default GroupSpec.make()
  .middleware(Preflight)
  .addFunction(
    ActionCall.profile.publicAction({
      name: "execute",
      args: () => ({
        mode: Schema.Literals([
          "write",
          "read",
          "twice",
          "parallel",
          "unused",
          "inspect",
          "failedEncoding",
          "preflight",
          "scheduleAfter",
          "scheduleAt",
        ]),
      }),
      returns: () =>
        Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]),
    }),
  );
