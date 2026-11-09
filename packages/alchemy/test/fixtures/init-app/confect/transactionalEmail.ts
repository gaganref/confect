import { Mount } from "@confect/core";
import Email from "../components/email/client";
import refs from "./_generated/refs";
import args from "./args";

export const TransactionalEmail = Mount.make(Email, {
  name: "transactionalEmail",
  args: { ...args.transactionalEmail, onEvent: refs.internal.events.record },
});
