import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Auth from "@confect/server/Auth";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import refs from "../_generated/refs";
import schema from "../_generated/schema";
import {
  ActionRunner,
  DatabaseReader,
  DatabaseWriter,
  MutationRunner,
  RequestMetadata,
  Scheduler,
} from "../_generated/services";
import spec, { Recorded } from "./requests.spec";

const read = Effect.gen(function* () {
  const request = yield* (yield* RequestMetadata).get();
  const identity = yield* Auth.getUserIdentity;
  return {
    requestId: request.requestId,
    ip: request.ip,
    userAgent: request.userAgent,
    scheduledFunctionId: request.scheduledFunctionId ?? null,
    authToken: request.authToken ?? null,
    subject: identity._tag === "Valid" ? identity.identity.subject : null,
  };
});

const encodeRecorded = Schema.encodeEffect(Schema.fromJsonString(Recorded));

const mutation = FunctionImpl.make(schema, spec, "mutation", () =>
  Effect.gen(function* () {
    const own = yield* read;
    const mutations = yield* MutationRunner;
    const nested = yield* mutations.runMutation(
      refs.internal.groups.requests.read,
      {},
    );
    return { own, nested };
  }).pipe(Effect.orDie),
);

const action = FunctionImpl.make(schema, spec, "action", () =>
  Effect.gen(function* () {
    const own = yield* read;
    const mutations = yield* MutationRunner;
    const actions = yield* ActionRunner;
    return {
      own,
      mutation: yield* mutations.runMutation(
        refs.internal.groups.requests.read,
        {},
      ),
      action: yield* actions.runAction(
        refs.internal.groups.requests.readAction,
        {},
      ),
    };
  }).pipe(Effect.orDie),
);

const schedule = FunctionImpl.make(schema, spec, "schedule", ({ caseId }) =>
  Effect.gen(function* () {
    const own = yield* read;
    const scheduler = yield* Scheduler;
    const mutationJob = yield* scheduler.runAfter(
      Duration.zero,
      refs.internal.groups.requests.scheduledMutation,
      { caseId },
    );
    const actionJob = yield* scheduler.runAfter(
      Duration.zero,
      refs.internal.groups.requests.scheduledAction,
      { caseId },
    );
    return { own, mutationJob, actionJob };
  }).pipe(Effect.orDie),
);

const recorded = FunctionImpl.make(schema, spec, "recorded", ({ caseId }) =>
  Effect.gen(function* () {
    const reader = yield* DatabaseReader;
    const notes = yield* reader
      .table("transactionNotes")
      .index("by_caseId", (q) => q.eq("caseId", caseId))
      .collect();
    return notes.map((note) => note.value);
  }).pipe(Effect.orDie),
);

const readMutation = FunctionImpl.make(schema, spec, "read", () => read);

const readAction = FunctionImpl.make(schema, spec, "readAction", () => read);

const scheduledMutation = FunctionImpl.make(
  schema,
  spec,
  "scheduledMutation",
  ({ caseId }) =>
    Effect.gen(function* () {
      const value = yield* encodeRecorded({
        label: "mutation",
        own: yield* read,
        nested: null,
      });
      const writer = yield* DatabaseWriter;
      yield* writer.table("transactionNotes").insert({ caseId, value });
      return null;
    }).pipe(Effect.orDie),
);

const scheduledAction = FunctionImpl.make(
  schema,
  spec,
  "scheduledAction",
  ({ caseId }) =>
    Effect.gen(function* () {
      const own = yield* read;
      const mutations = yield* MutationRunner;
      const nested = yield* mutations.runMutation(
        refs.internal.groups.requests.read,
        {},
      );
      const value = yield* encodeRecorded({ label: "action", own, nested });
      yield* mutations.runMutation(refs.internal.groups.requests.record, {
        caseId,
        value,
      });
      return null;
    }).pipe(Effect.orDie),
);

const record = FunctionImpl.make(schema, spec, "record", ({ caseId, value }) =>
  Effect.gen(function* () {
    const writer = yield* DatabaseWriter;
    yield* writer.table("transactionNotes").insert({ caseId, value });
    return null;
  }).pipe(Effect.orDie),
);

export default GroupImpl.make(schema, spec).pipe(
  Layer.provide([
    mutation,
    action,
    schedule,
    recorded,
    readMutation,
    readAction,
    scheduledMutation,
    scheduledAction,
    record,
  ]),
  GroupImpl.finalize,
);
