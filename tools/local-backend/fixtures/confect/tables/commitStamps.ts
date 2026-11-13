import { CommitTs, Table } from "@confect/core";
import * as Schema from "effect/Schema";

export default Table.make(() =>
  Schema.Struct({
    caseId: Schema.String,
    label: Schema.String,
    at: CommitTs.CommitTs,
  }),
).index("by_caseId_at", ["caseId", "at"]);
