import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
import { Id } from "../_generated/id";
import notes from "../_generated/tables/notes";

import {
  Observed,
  ObserveWrites,
  Observation,
} from "../middleware/ObserveWrites.spec";

export default GroupSpec.make()
  .addFunction(
    FunctionSpec.internalMutation({
      name: "internalObserveWrites",
      args: () => ({ fail: Schema.Boolean }),
      returns: () => Schema.Array(Observation),
    }).middleware(ObserveWrites),
  )
  .addFunction(
    Observed.publicMutation({
      name: "observeWrites",
      args: () => ({ fail: Schema.Boolean }),
      returns: () => Schema.Array(Observation),
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "insert",
      args: () => ({ text: Schema.String }),
      returns: () => Id("notes"),
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "list",
      returns: () => Schema.Array(notes.Doc),
    }),
  )
  .addFunction(
    FunctionSpec.publicMutation({
      name: "delete_",
      args: () => ({ noteId: Id("notes") }),
      returns: () => Schema.Null,
    }),
  )
  .addFunction(
    FunctionSpec.publicQuery({
      name: "getFirst",
      returns: () => Schema.OptionFromNullOr(notes.Doc),
    }),
  )
  .addFunction(
    FunctionSpec.internalQuery({
      name: "internalGetFirst",
      returns: () => Schema.OptionFromNullOr(notes.Doc),
    }),
  );
