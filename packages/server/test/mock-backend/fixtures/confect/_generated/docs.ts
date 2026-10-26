import type { Document } from "@confect/server";
import type schemaDefinition from "./schema.js";

export type DemandsDoc = Document.Document<typeof schemaDefinition, "demands">;
export type EventsDoc = Document.Document<typeof schemaDefinition, "events">;
export type NotesDoc = Document.Document<typeof schemaDefinition, "notes">;
export type TagsDoc = Document.Document<typeof schemaDefinition, "tags">;
export type TotalsDoc = Document.Document<typeof schemaDefinition, "totals">;
export type UsersDoc = Document.Document<typeof schemaDefinition, "users">;

export interface Docs {
  demands: DemandsDoc;
  events: EventsDoc;
  notes: NotesDoc;
  tags: TagsDoc;
  totals: TotalsDoc;
  users: UsersDoc;
}
