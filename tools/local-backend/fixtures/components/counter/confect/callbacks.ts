import { Callback } from "@confect/core";
import * as Schema from "effect/Schema";
import { Id } from "./_generated/id";

export class EventRejected extends Schema.TaggedError<
  EventRejected,
  { readonly brand: unique symbol }
>()("EventRejected", { reason: Schema.String }) {}

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

// Args and returns with arrays, a nested object and an ID, so the parity test
// compares a handle's inner types with Convex's.
export const OnBatch = Callback.mutation("counter/onBatch", {
  args: () => ({
    id: Id("deliveries"),
    runs: Schema.Array(Schema.String),
    meta: Schema.Struct({
      run: Schema.String,
      tags: Schema.Array(Schema.String),
    }),
  }),
  returns: () =>
    Schema.Array(Schema.Struct({ id: Id("deliveries"), status: Status })),
});
