import { Callback } from "@confect/core";
import * as Schema from "effect/Schema";

export class EventRejected extends Schema.TaggedError<EventRejected>()(
  "EventRejected",
  { reason: Schema.String },
) {}

export const Status = Schema.Literals([
  "queued",
  "sent",
  "delivered",
  "bounced",
]);

export const OnEvent = Callback.mutation("counter/onEvent", {
  args: () => ({ run: Schema.String, status: Status }),
  returns: () => Schema.Null,
  error: () => EventRejected,
});
