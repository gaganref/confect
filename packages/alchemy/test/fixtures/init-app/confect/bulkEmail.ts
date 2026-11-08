import { Mount, Ref } from "@confect/core";
import { makeFunctionReference } from "convex/server";
import Email from "../components/email/client";
import refs from "./_generated/refs";
import args from "./args";

// A plain ref keeps naming events:gone after its spec drops it, as a deleted
// callback target does.
const gone = Ref.fromFunctionReference(
  makeFunctionReference<"mutation">("events:gone"),
);

export const BulkEmail = Mount.make(Email, {
  name: "bulkEmail",
  args: {
    ...args.bulkEmail,
    onEvent: args.bulkTarget === "gone" ? gone : refs.internal.events.record,
  },
});
