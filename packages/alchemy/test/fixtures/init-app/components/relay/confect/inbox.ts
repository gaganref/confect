import { Mount } from "@confect/core";
import Email from "../../email/client";

export const Inbox = Mount.make(Email, {
  name: "inbox",
  args: { fromName: "Relay inbox" },
});
