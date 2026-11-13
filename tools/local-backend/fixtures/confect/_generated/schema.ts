import { DatabaseSchema as $DatabaseSchema } from "@confect/server";

import callbackEvents from "./tables/callbackEvents.js";
import commitStamps from "./tables/commitStamps.js";
import transactionNotes from "./tables/transactionNotes.js";

const databaseSchema: $DatabaseSchema.DatabaseSchema<{
  readonly callbackEvents: typeof callbackEvents;
  readonly commitStamps: typeof commitStamps;
  readonly transactionNotes: typeof transactionNotes;
}> = $DatabaseSchema.make({
  callbackEvents,
  commitStamps,
  transactionNotes,
});

export default databaseSchema;
