import { Callback as CoreCallback, FunctionSpec, Ref } from "@confect/core";
import { Callback, FunctionImpl, GroupImpl } from "@confect/server";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  EventRejected,
  OnEvent,
  Status,
} from "../../components/counter/confect/callbacks";
import databaseSchema from "../_generated/schema";
import refs from "../_generated/refs";
import {
  DatabaseReader,
  DatabaseWriter,
  MutationRunner,
  QueryRunner,
} from "../_generated/services";
import { first } from "../componentBindings";
import callbacks from "./callbacks.spec";

const OnEventHandle = CoreCallback.handle(OnEvent);

// Never deployed: it stands in for a callback the host has since removed.
const retired = Ref.make(
  "groups/callbacks",
  FunctionSpec.internalMutation({
    name: "retired",
    args: () => ({ run: Schema.String, status: Status }),
    returns: () => Schema.Null,
    error: () => EventRejected,
  }),
);

// Record types hide the field names, so only the check in `Callback.create`
// sees that the host's args name `state` where the contract sends `status`.
const reportedFields: Record<string, typeof Schema.String> = {
  status: Schema.String,
};
const misreportedFields: Record<string, typeof Schema.String> = {
  state: Schema.String,
};
const OnReported = CoreCallback.mutation("counter/onReported", {
  args: () => reportedFields,
  returns: () => Schema.Null,
});
// Never deployed: the check refuses it before Convex is asked for a handle.
const misreported = Ref.make(
  "groups/callbacks",
  FunctionSpec.internalMutation({
    name: "misreported",
    args: () => misreportedFields,
    returns: () => Schema.Null,
  }),
);

const observe = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.exit(effect), (exit) =>
    Exit.match(exit, {
      onSuccess: () => ({ outcome: "success" as const, message: "" }),
      onFailure: (cause) => {
        const error = Cause.squash(cause);
        return {
          outcome: Cause.hasDies(cause)
            ? ("defect" as const)
            : ("failure" as const),
          message: Predicate.hasProperty(error, "message")
            ? String(error.message)
            : String(error),
        };
      },
    }),
  );

const onEvent = FunctionImpl.make(
  databaseSchema,
  callbacks,
  "onEvent",
  ({ run, status }) =>
    Effect.gen(function* () {
      const writer = yield* DatabaseWriter;
      yield* writer
        .table("callbackEvents")
        .insert({ run, status })
        .pipe(Effect.orDie);
      if (status === "bounced") {
        return yield* new EventRejected({
          reason: `host refuses bounced for ${run}`,
        });
      }
      return null;
    }),
);

const send = FunctionImpl.make(databaseSchema, callbacks, "send", ({ run }) =>
  Effect.gen(function* () {
    const runner = yield* MutationRunner;
    const handle = yield* Callback.create(
      OnEvent,
      refs.internal.groups.callbacks.onEvent,
    );
    return yield* runner.runMutation(first.deliveries.send, {
      run,
      onEvent: handle,
    });
  }).pipe(Effect.orDie),
);

const setStatus = FunctionImpl.make(
  databaseSchema,
  callbacks,
  "setStatus",
  (args) =>
    Effect.gen(function* () {
      const runner = yield* MutationRunner;
      return yield* runner.runMutation(first.deliveries.setStatus, args);
    }).pipe(Effect.orDie),
);

const breach = FunctionImpl.make(databaseSchema, callbacks, "breach", (args) =>
  Effect.gen(function* () {
    const runner = yield* MutationRunner;
    return yield* runner.runMutation(first.deliveries.breach, args);
  }).pipe(Effect.orDie),
);

const sameHandle = FunctionImpl.make(
  databaseSchema,
  callbacks,
  "sameHandle",
  (args) =>
    Effect.gen(function* () {
      const query = yield* QueryRunner;
      const stored = yield* query.runQuery(first.deliveries.get, args);
      const fresh = yield* Callback.create(
        OnEvent,
        refs.internal.groups.callbacks.onEvent,
      );
      const encode = Schema.encodeEffect(OnEventHandle);
      return (yield* encode(stored.onEvent)) === (yield* encode(fresh));
    }).pipe(Effect.orDie),
);

const createRetired = FunctionImpl.make(
  databaseSchema,
  callbacks,
  "createRetired",
  () => observe(Callback.create(OnEvent, retired)),
);

const createMismatched = FunctionImpl.make(
  databaseSchema,
  callbacks,
  "createMismatched",
  () => observe(Callback.create(OnReported, misreported)),
);

const get = FunctionImpl.make(databaseSchema, callbacks, "get", (args) =>
  Effect.gen(function* () {
    const query = yield* QueryRunner;
    const { run, status } = yield* query.runQuery(first.deliveries.get, args);
    return { run, status };
  }).pipe(Effect.orDie),
);

const events = FunctionImpl.make(
  databaseSchema,
  callbacks,
  "events",
  ({ run }) =>
    Effect.gen(function* () {
      const reader = yield* DatabaseReader;
      const rows = yield* reader
        .table("callbackEvents")
        .index("by_run", (q) => q.eq("run", run))
        .collect();
      return rows.map((row) => row.status);
    }).pipe(Effect.orDie),
);

export default GroupImpl.make(databaseSchema, callbacks).pipe(
  Layer.provide([
    onEvent,
    send,
    setStatus,
    breach,
    sameHandle,
    createRetired,
    createMismatched,
    get,
    events,
  ]),
  GroupImpl.finalize,
);
