import { Callback } from "@confect/core";
import * as Schema from "effect/Schema";
export const OnGood = Callback.query("counter/onGood", {
  returns: () => Schema.String,
});
export const OnWrong = Callback.mutation("counterfeit/onWrong", {
  returns: () => Schema.String,
});
