import type { Document } from "@confect/server";
import type schemaDefinition from "./schema.js";

export type BatchesDoc = Document.Document<typeof schemaDefinition, "batches">;
export type EmailsDoc = Document.Document<typeof schemaDefinition, "emails">;

export interface Docs {
  batches: BatchesDoc;
  emails: EmailsDoc;
}
