import type { Document } from "@confect/server";
import type schemaDefinition from "./schema.js";

export type MarksDoc = Document.Document<typeof schemaDefinition, "marks">;

export interface Docs {
  marks: MarksDoc;
}
