import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";

const PageArgs = () => ({
  run: Schema.String,
  cursor: Schema.NullOr(Schema.String),
  numItems: Schema.Int,
});
const Page = () =>
  Schema.Struct({
    page: Schema.Array(Schema.Finite),
    continueCursor: Schema.String,
    isDone: Schema.Boolean,
  });
export default GroupSpec.make()
  .addFunction(
    FunctionSpec.publicQuery({
      name: "page",
      args: PageArgs,
      returns: Page,
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "searchPage",
      args: PageArgs,
      returns: Page,
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "twice",
      args: PageArgs,
      returns: () => Schema.Null,
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "streams",
      args: () => ({ run: Schema.String }),
      returns: () =>
        Schema.Struct({
          deferred: Schema.Array(Schema.Finite),
          merged: Schema.Array(Schema.Finite),
          budget: Schema.Int,
        }),
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "hook",
      args: () => ({ run: Schema.String }),
      returns: () =>
        Schema.Array(
          Schema.Struct({ operation: Schema.String, count: Schema.Finite }),
        ),
    }),
  );
