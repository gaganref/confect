import { Callback } from "@confect/core";
import * as Schema from "effect/Schema";

export const OnEvent = Callback.mutation("email/onEvent", {
  args: () => ({ fromName: Schema.String, message: Schema.String }),
  returns: () => Schema.Null,
});
