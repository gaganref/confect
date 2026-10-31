import { FunctionSpec } from "@confect/core";
import * as Schema from "effect/Schema";
import type * as Tracer from "effect/Tracer";

export const profile = FunctionSpec.extend()({
  middleware: [],
  reservedArgument: "context",
});
export const options = {
  name: "echo",
  args: () => ({ count: Schema.FiniteFromString }),
  returns: () => Schema.Unknown,
};
export const cases = [
  {
    label: "a boundary value",
    forward: (span: Tracer.Span) => ({ boundary: span.name }),
    enabled: true,
  },
  { label: "an omitted value", forward: () => undefined, enabled: false },
  { label: "no provider", forward: undefined, enabled: false },
  {
    label: "a throwing provider",
    forward: () => {
      throw new Error("fixture provider failure");
    },
    enabled: false,
  },
];
