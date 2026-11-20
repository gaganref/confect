import * as PushCheck from "@confect/server/PushCheck";
import { make } from "../checks";
import schema from "./_generated/schema";
import { verdict } from "./verdict";

export const { runs, refusals } = make("host", verdict);

// Every implementation of this backend imports this module, so every
// function's module graph registers the check.
PushCheck.register(
  schema,
  PushCheck.make("guard", () => refusals("functions")),
);
