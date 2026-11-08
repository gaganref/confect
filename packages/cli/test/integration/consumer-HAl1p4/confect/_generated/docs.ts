import type { Document } from "@confect/server";
import type schemaDefinition from "./schema.js";

export type NotesDoc = Document.Document<typeof schemaDefinition, "notes">;

export interface Docs {
  notes: NotesDoc;
}
