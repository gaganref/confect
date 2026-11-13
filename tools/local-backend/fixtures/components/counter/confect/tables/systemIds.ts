import { Table } from "@confect/core";
import * as Schema from "effect/Schema";
import { Id } from "../_generated/id";

export default Table.make(() =>
  Schema.Struct({
    storage: Id("_storage"),
    scheduled: Id("_scheduled_functions"),
  }),
);
