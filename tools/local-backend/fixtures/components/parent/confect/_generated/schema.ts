import { DatabaseSchema as $DatabaseSchema } from "@confect/server";

import { target as $target } from "./id.js";
const databaseSchema: $DatabaseSchema.DatabaseSchema<{}, typeof $target> = $DatabaseSchema.make({}, $target);

export default databaseSchema;
