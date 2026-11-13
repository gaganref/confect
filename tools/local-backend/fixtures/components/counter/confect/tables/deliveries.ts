import { Callback, Table } from "@confect/core";
import * as Schema from "effect/Schema";
import { OnEvent, Status } from "../callbacks";

export default Table.make(() =>
  Schema.Struct({
    run: Schema.String,
    status: Status,
    onEvent: Callback.handle(OnEvent),
  }),
);
