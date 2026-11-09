import { Mount, Ref } from "@confect/core";
import Email from "../components/email/client";
import refs from "./_generated/refs";
import args from "./args";
import { callback } from "./events.spec";

// A ref made from its spec keeps naming events:gone after the group drops it,
// as a deleted callback target does.
const gone = Ref.make("events", callback("gone"));

export const BulkEmail = Mount.make(Email, {
  name: "bulkEmail",
  args: {
    ...args.bulkEmail,
    onEvent: args.bulkTarget === "gone" ? gone : refs.internal.events.record,
  },
});
