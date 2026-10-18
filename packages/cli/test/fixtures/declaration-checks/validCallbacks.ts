import { Callback } from "@confect/core";
import * as Schema from "effect/Schema";
const returns = (): typeof Schema.String => {
  throw new Error("Callback schemas must stay lazy during codegen");
};
export const OnQuery = Callback.query("counter/onQuery", { returns });
export const OnMutation = Callback.mutation("counter/onMutation", { returns });
export const OnAction = Callback.action("counter/onAction", { returns });
export const NotAContract = Schema.String;
