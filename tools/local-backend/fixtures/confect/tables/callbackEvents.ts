import { Table } from "@confect/core";
import * as Schema from "effect/Schema";
import { Status } from "../../components/counter/confect/callbacks";

export default Table.make(() =>
  Schema.Struct({
    run: Schema.String,
    status: Status,
  }),
).index("by_run", ["run"]);
