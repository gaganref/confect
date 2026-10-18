import { Callback } from "@confect/core";
import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import refs from "./_generated/refs";
import schema from "./_generated/schema";
import {
  DatabaseReader,
  DatabaseWriter,
  MutationRunner,
  Scheduler,
} from "./_generated/services";
import { OnEvent } from "./callbacks";
import deliveries from "./deliveries.spec";

// A contract the host does not satisfy: reading the stored handle through it
// sends args the host's validator rejects.
const Breach = Callback.mutation("counter/breach", {
  args: () => ({ run: Schema.Finite }),
  returns: () => Schema.Null,
});

const send = FunctionImpl.make(schema, deliveries, "send", ({ run, onEvent }) =>
  Effect.gen(function* () {
    const writer = yield* DatabaseWriter;
    const scheduler = yield* Scheduler;
    const id = yield* writer
      .table("deliveries")
      .insert({ run, status: "queued", onEvent });
    yield* scheduler.runAfter(Duration.zero, refs.internal.deliveries.deliver, {
      id,
    });
    return id;
  }).pipe(Effect.orDie),
);

const deliver = FunctionImpl.make(schema, deliveries, "deliver", ({ id }) =>
  Effect.gen(function* () {
    const reader = yield* DatabaseReader;
    const writer = yield* DatabaseWriter;
    const scheduler = yield* Scheduler;
    const delivery = yield* reader.table("deliveries").get(id);
    yield* writer.table("deliveries").patch(id, { status: "sent" });
    yield* scheduler.runAfter(Duration.zero, delivery.onEvent, {
      run: delivery.run,
      status: "sent",
    });
    return null;
  }).pipe(Effect.orDie),
);

const setStatus = FunctionImpl.make(
  schema,
  deliveries,
  "setStatus",
  ({ id, status }) =>
    Effect.gen(function* () {
      const reader = yield* DatabaseReader;
      const writer = yield* DatabaseWriter;
      const runner = yield* MutationRunner;
      const delivery = yield* reader.table("deliveries").get(id);
      yield* writer.table("deliveries").patch(id, { status });
      return yield* runner
        .runMutation(delivery.onEvent, { run: delivery.run, status })
        .pipe(
          Effect.catchTag("EventRejected", (rejected) =>
            Effect.succeed(rejected.reason),
          ),
        );
    }).pipe(Effect.orDie),
);

const breach = FunctionImpl.make(schema, deliveries, "breach", ({ id }) =>
  Effect.gen(function* () {
    const reader = yield* DatabaseReader;
    const runner = yield* MutationRunner;
    const delivery = yield* reader.table("deliveries").get(id);
    const text = yield* Schema.encodeEffect(Callback.handle(OnEvent))(
      delivery.onEvent,
    );
    const breached = yield* Schema.decodeEffect(Callback.handle(Breach))(text);
    const exit = yield* Effect.exit(runner.runMutation(breached, { run: 42 }));
    return Exit.match(exit, {
      onSuccess: () => "success" as const,
      onFailure: (cause) =>
        Cause.hasDies(cause) ? ("defect" as const) : ("failure" as const),
    });
  }).pipe(Effect.orDie),
);

const get = FunctionImpl.make(schema, deliveries, "get", ({ id }) =>
  Effect.gen(function* () {
    const reader = yield* DatabaseReader;
    const { run, status, onEvent } = yield* reader.table("deliveries").get(id);
    return { run, status, onEvent };
  }).pipe(Effect.orDie),
);

export default GroupImpl.make(schema, deliveries).pipe(
  Layer.provide([send, deliver, setStatus, breach, get]),
  GroupImpl.finalize,
);
