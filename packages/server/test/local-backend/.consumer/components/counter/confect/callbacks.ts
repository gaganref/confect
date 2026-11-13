import { Callback } from "@confect/core";
import * as Schema from "effect/Schema";
export const OnResult = Callback.mutation("counter/onResult", {
  args: () => ({ value: Schema.FiniteFromString }),
  returns: () => Schema.FiniteFromString,
});

// Widen the fields so the install check reaches the runtime validator check.
const checkedArgs: Record<string, typeof Schema.FiniteFromString> = {
  value: Schema.FiniteFromString,
};
export const OnCheckedArgs = Callback.mutation("counter/checkArgs", {
  args: () => checkedArgs,
  returns: () => Schema.FiniteFromString,
});
