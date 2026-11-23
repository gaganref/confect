import { Table } from "@confect/core";
import * as Schema from "effect/Schema";
// The host's verdict, so one edit changes the version the host serves and
// this component's schema in a single push.
import { verdict } from "../../../../confect/verdict";

export default Table.make(() =>
  Schema.Struct({ day: Schema.String }),
).deployCheck((table) =>
  verdict.refuse === "schema"
    ? [
        `component table "${table.tableName}" is refused by the verdict in confect/verdict.ts`,
      ]
    : [],
);
