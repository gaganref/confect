import type { Document } from "@confect/server";
import type schemaDefinition from "./schema.js";

export type CountersDoc = Document.Document<typeof schemaDefinition, "counters">;

export interface Docs {
  counters: CountersDoc;
}
