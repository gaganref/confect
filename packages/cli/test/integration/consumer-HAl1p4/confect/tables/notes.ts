import { Table } from "@confect/core";
import * as Schema from "effect/Schema";
import { Id } from "../_generated/id";
export default Table.make(() => Schema.Struct({ text: Schema.String, parent: Schema.optionalKey(Id("notes")) }));
