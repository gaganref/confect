import { Table } from "@confect/core";
import * as Schema from "effect/Schema";

/**
 * The deploy checks this module graph ran for the table. Every host function's
 * graph binds the table, through `_generated/schema`, and builds no Convex
 * schema, so a call reads none.
 */
export const runs = { count: 0 };

export default Table.make(() =>
  Schema.Struct({ label: Schema.String }),
).deployCheck(() => {
  runs.count++;
  return [];
});
