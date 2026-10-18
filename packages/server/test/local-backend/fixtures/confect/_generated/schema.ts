import { DatabaseSchema as $DatabaseSchema } from "@confect/server";

import callbackEvents from "./tables/callbackEvents";
import transactionNotes from "./tables/transactionNotes";

const databaseSchema: $DatabaseSchema.DatabaseSchema<{
  readonly callbackEvents: typeof callbackEvents;
  readonly transactionNotes: typeof transactionNotes;
}> = $DatabaseSchema.make({
  callbackEvents,
  transactionNotes,
});

export default databaseSchema;
