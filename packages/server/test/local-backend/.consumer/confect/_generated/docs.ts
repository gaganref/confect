import type { Document } from "@confect/server";
import type schemaDefinition from "./schema.js";

export type ItemsDoc = Document.Document<typeof schemaDefinition, "items">;

export interface Docs {
  items: ItemsDoc;
}
