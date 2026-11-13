import type { Document } from "@confect/server";
import type schemaDefinition from "./schema.js";

export type CallbackEventsDoc = Document.Document<typeof schemaDefinition, "callbackEvents">;
export type CommitStampsDoc = Document.Document<typeof schemaDefinition, "commitStamps">;
export type TransactionNotesDoc = Document.Document<typeof schemaDefinition, "transactionNotes">;

export interface Docs {
  callbackEvents: CallbackEventsDoc;
  commitStamps: CommitStampsDoc;
  transactionNotes: TransactionNotesDoc;
}
