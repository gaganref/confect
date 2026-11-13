import { DatabaseSchema as $DatabaseSchema } from "@confect/server";

import items from "./tables/items.js";

const databaseSchema: $DatabaseSchema.DatabaseSchema<{
  readonly items: typeof items;
}> = $DatabaseSchema.make({
  items,
});

export default databaseSchema;
