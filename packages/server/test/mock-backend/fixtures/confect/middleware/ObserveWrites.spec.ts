import { MiddlewareSpec, FunctionSpec } from "@confect/core";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";

export const Observation = Schema.Struct({
  operation: Schema.String,
  count: Schema.Finite,
  sum: Schema.Finite,
});
export class Changes extends Context.Service<
  Changes,
  Array<typeof Observation.Type>
>()(
  "@confect/server-mock-backend-fixtures/confect/middleware/ObserveWrites.spec/Changes",
) {}

export class ObserveWrites extends MiddlewareSpec.MiddlewareSpec<
  ObserveWrites,
  { provides: Changes }
>()("ObserveWrites", {
  functionTypes: { query: false, mutation: true, action: false },
}) {}

export const Observed = FunctionSpec.extend()({ middleware: [ObserveWrites] });
