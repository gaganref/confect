import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
import counters from "./_generated/tables/counters";

const PageArgs = () => ({
  run: Schema.String,
  cursor: Schema.NullOr(Schema.String),
  numItems: Schema.Int,
});
const Page = () =>
  Schema.Struct({
    page: Schema.Array(counters.Doc),
    continueCursor: Schema.String,
    isDone: Schema.Boolean,
  });

export default GroupSpec.make().addFunction(
  FunctionSpec.publicQuery({
    name: "page",
    args: PageArgs,
    returns: Page,
  }),
);
