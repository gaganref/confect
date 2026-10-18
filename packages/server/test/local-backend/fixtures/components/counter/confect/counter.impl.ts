import { FunctionImpl, GroupImpl, QueryStream } from "@confect/server";
import * as DateTime from "effect/DateTime";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import schema from "./_generated/schema";
import refs from "./_generated/refs";
import {
  DatabaseReader,
  ExecutionMetadata,
  DatabaseWriter,
  QueryCtx,
  Scheduler,
  StorageReader,
  StorageWriter,
} from "./_generated/services";
import counter, { Rejected, ScheduledId } from "./counter.spec";
import env from "./env";

const create = FunctionImpl.make(schema, counter, "create", (args) =>
  Effect.gen(function* () {
    const writer = yield* DatabaseWriter;
    return yield* writer.table("counters").insert(args);
  }).pipe(Effect.orDie),
);
const createInternal = FunctionImpl.make(
  schema,
  counter,
  "createInternal",
  (args) =>
    Effect.gen(function* () {
      const writer = yield* DatabaseWriter;
      return yield* writer.table("counters").insert(args);
    }).pipe(Effect.orDie),
);
const list = FunctionImpl.make(schema, counter, "list", ({ run }) =>
  Effect.gen(function* () {
    const reader = yield* DatabaseReader;
    return yield* reader
      .table("counters")
      .index("by_run", (range) => range.eq("run", run))
      .collect();
  }).pipe(Effect.orDie),
);
const reject = FunctionImpl.make(schema, counter, "reject", ({ run }) =>
  Effect.gen(function* () {
    const writer = yield* DatabaseWriter;
    const id = yield* writer
      .table("counters")
      .insert({ run, count: 999 })
      .pipe(Effect.orDie);
    return yield* new Rejected({ id, run });
  }),
);
const schedule = FunctionImpl.make(schema, counter, "schedule", (args) =>
  Effect.gen(function* () {
    const scheduler = yield* Scheduler;
    return yield* scheduler.runAfter(
      Duration.zero,
      refs.internal.counter.createInternal,
      args,
    );
  }),
);
const scheduleAndCancel = FunctionImpl.make(
  schema,
  counter,
  "scheduleAndCancel",
  ({ run }) =>
    Effect.gen(function* () {
      const scheduler = yield* Scheduler;
      const after = yield* scheduler.runAfter(
        Duration.millis(100),
        refs.internal.counter.createInternal,
        { run, count: 999 },
      );
      const at = yield* scheduler.runAt(
        DateTime.addDuration(yield* DateTime.now, Duration.millis(100)),
        refs.internal.counter.createInternal,
        { run, count: 998 },
      );
      yield* scheduler.cancel(after);
      yield* scheduler.cancel(at);
      const control = yield* scheduler.runAfter(
        Duration.millis(200),
        refs.internal.counter.createInternal,
        { run, count: 17 },
      );
      return { after, at, control };
    }),
);
const cancel = FunctionImpl.make(schema, counter, "cancel", ({ id }) =>
  Effect.gen(function* () {
    const scheduler = yield* Scheduler;
    yield* scheduler.cancel(
      yield* Schema.decodeUnknownEffect(ScheduledId)(id).pipe(Effect.orDie),
    );
    return null;
  }),
);
const uploadUrl = FunctionImpl.make(schema, counter, "uploadUrl", () =>
  Effect.gen(function* () {
    const storage = yield* StorageWriter;
    return (yield* storage.generateUploadUrl).toString();
  }),
);
const storageUrl = FunctionImpl.make(schema, counter, "storageUrl", ({ id }) =>
  Effect.gen(function* () {
    const storage = yield* StorageReader;
    return (yield* storage.getUrl(id)).toString();
  }).pipe(Effect.orDie),
);
const hasAuth = FunctionImpl.make(schema, counter, "hasAuth", () =>
  Effect.map(QueryCtx, (ctx) => Predicate.hasProperty(ctx, "auth")),
);

const location = FunctionImpl.make(schema, counter, "location", () =>
  Effect.gen(function* () {
    const execution = yield* ExecutionMetadata;
    return (yield* execution.getFunction()).componentPath;
  }),
);
const page = FunctionImpl.make(
  schema,
  counter,
  "page",
  ({ run, cursor, numItems }) =>
    Effect.gen(function* () {
      const reader = yield* DatabaseReader;
      return yield* QueryStream.paginate(
        reader
          .table("counters")
          .stream("by_run_count", (range) => range.eq("run", run)),
        { cursor, numItems },
      );
    }).pipe(Effect.orDie),
);
const environment = FunctionImpl.make(schema, counter, "environment", () =>
  Effect.gen(function* () {
    const unset = Option.getOrElse(() => "unset");
    const required = yield* env.COMPONENT_REQUIRED;
    const optional = unset(yield* env.COMPONENT_OPTIONAL);
    const marker = unset(yield* env.COMPONENT_MARKER);
    const unbound = unset(yield* env.COMPONENT_UNBOUND);
    // The host declares this name; the component does not, so it must read as unset.
    const hostOnly = yield* Config.String("COMPONENT_HOST_ONLY").pipe(
      Config.withDefault("unset"),
    );
    return {
      required,
      optional,
      marker,
      unbound,
      hostOnly,
      // oxlint-disable-next-line effecttsgo/process-env-in-effect -- Compare direct native reads with Config for this installation.
      directRequired: process.env.COMPONENT_REQUIRED ?? "unset",
    };
  }).pipe(Effect.orDie),
);
const tick = FunctionImpl.make(schema, counter, "tick", () =>
  Effect.gen(function* () {
    const writer = yield* DatabaseWriter;
    const reader = yield* DatabaseReader;
    const table = writer.table("counters");
    const current = yield* reader
      .table("counters")
      .index("by_run", (range) => range.eq("run", "cron"))
      .first();
    if (Option.isNone(current)) {
      yield* table.insert({ run: "cron", count: 1 });
    } else {
      yield* table.patch(current.value._id, { count: current.value.count + 1 });
    }
    return null;
  }).pipe(Effect.orDie),
);
const ticks = FunctionImpl.make(schema, counter, "ticks", () =>
  Effect.gen(function* () {
    const reader = yield* DatabaseReader;
    const current = yield* reader
      .table("counters")
      .index("by_run", (range) => range.eq("run", "cron"))
      .first();
    return Option.match(current, {
      onNone: () => 0,
      onSome: (row) => row.count,
    });
  }).pipe(Effect.orDie),
);

export default GroupImpl.make(schema, counter).pipe(
  Layer.provide([
    create,
    createInternal,
    list,
    reject,
    schedule,
    scheduleAndCancel,
    cancel,
    uploadUrl,
    storageUrl,
    hasAuth,
    location,
    page,
    environment,
    tick,
    ticks,
  ]),
  GroupImpl.finalize,
);
