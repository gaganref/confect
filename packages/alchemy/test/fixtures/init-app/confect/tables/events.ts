import { Table } from "@confect/core";
import * as Schema from "effect/Schema";

export default Table.make(() =>
  Schema.Struct({ fromName: Schema.String, message: Schema.String }),
);
