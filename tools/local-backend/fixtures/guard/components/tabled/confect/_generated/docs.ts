import type { Document } from "@confect/server";
import type schemaDefinition from "./schema.js";

export type EntriesDoc = Document.Document<typeof schemaDefinition, "entries">;

export interface Docs {
  entries: EntriesDoc;
}
