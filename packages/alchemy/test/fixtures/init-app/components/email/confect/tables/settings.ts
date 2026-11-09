import { Callback, Table } from "@confect/core";
import * as Schema from "effect/Schema";
import { OnEvent } from "../callbacks";

export default Table.make(() =>
  Schema.Struct({
    fromName: Schema.String,
    maxAttempts: Schema.optionalKey(Schema.Int),
    onEvent: Schema.optionalKey(Callback.handle(OnEvent)),
  }),
);
