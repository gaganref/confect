import { Table } from "@confect/core";
import * as Schema from "effect/Schema";
import { Id } from "../_generated/id.js";

export default Table.make(() =>
  Schema.Struct({ batchId: Id("batches"), to: Schema.String }),
).group("batchId");
