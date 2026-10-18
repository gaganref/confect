import type { Document } from "@confect/server";
import type schemaDefinition from "./schema";

export type CallbackEventsDoc = Document.Document<typeof schemaDefinition, "callbackEvents">;
export type TransactionNotesDoc = Document.Document<typeof schemaDefinition, "transactionNotes">;

export interface Docs {
  callbackEvents: CallbackEventsDoc;
  transactionNotes: TransactionNotesDoc;
}
