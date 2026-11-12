import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Rejected } from "../../components/counter/confect/counter.spec";
import schema from "../_generated/schema";
import { MutationRunner, QueryRunner } from "../_generated/services";
import { first, second, left, right } from "../componentBindings";
import env from "../env";
import spec from "./components.spec";

const exercise = FunctionImpl.make(schema, spec, "exercise", ({ run }) =>
  Effect.gen(function* () {
    const runMutation = yield* MutationRunner;
    const runQuery = yield* QueryRunner;
    yield* runMutation.runMutation(second.counter.create, { run, count: 7 });
    yield* runMutation.runMutation(left.parent.create, { run, count: 11 });
    yield* runMutation.runMutation(right.parent.create, { run, count: 13 });
    const rejectedId = yield* runMutation
      .runMutation(first.counter.reject, { run })
      .pipe(
        Effect.andThen(() =>
          Effect.die("Expected the component mutation to fail"),
        ),
        Effect.catchTag("Rejected", (error) => Effect.succeed(error.id)),
      );
    return {
      first: (yield* runQuery.runQuery(first.counter.list, { run })).map(
        (doc) => doc.count,
      ),
      second: (yield* runQuery.runQuery(second.counter.list, { run })).map(
        (doc) => doc.count,
      ),
      left: (yield* runQuery.runQuery(left.parent.list, { run })).map(
        (doc) => doc.count,
      ),
      right: (yield* runQuery.runQuery(right.parent.list, { run })).map(
        (doc) => doc.count,
      ),
      rejectedId,
    };
  }).pipe(Effect.orDie),
);
const schedule = FunctionImpl.make(schema, spec, "schedule", ({ run }) =>
  Effect.gen(function* () {
    const runMutation = yield* MutationRunner;
    return yield* runMutation.runMutation(first.counter.schedule, {
      run,
      count: 17,
    });
  }).pipe(Effect.orDie),
);
const scheduleAndCancel = FunctionImpl.make(
  schema,
  spec,
  "scheduleAndCancel",
  (args) =>
    Effect.gen(function* () {
      const mutation = yield* MutationRunner;
      return yield* mutation.runMutation(first.counter.scheduleAndCancel, args);
    }).pipe(Effect.orDie),
);
const cancel = FunctionImpl.make(schema, spec, "cancel", (args) =>
  Effect.gen(function* () {
    const mutation = yield* MutationRunner;
    return yield* mutation.runMutation(first.counter.cancel, args);
  }).pipe(Effect.orDie),
);
const list = FunctionImpl.make(schema, spec, "list", (args) =>
  Effect.gen(function* () {
    const runQuery = yield* QueryRunner;
    return {
      first: (yield* runQuery.runQuery(first.counter.list, args)).map(
        (doc) => doc.count,
      ),
      second: (yield* runQuery.runQuery(second.counter.list, args)).map(
        (doc) => doc.count,
      ),
    };
  }).pipe(Effect.orDie),
);
const uploadUrl = FunctionImpl.make(schema, spec, "uploadUrl", () =>
  Effect.gen(function* () {
    const runMutation = yield* MutationRunner;
    return yield* runMutation.runMutation(first.counter.uploadUrl, {});
  }).pipe(Effect.orDie),
);
const storageUrl = FunctionImpl.make(schema, spec, "storageUrl", (args) =>
  Effect.gen(function* () {
    const runQuery = yield* QueryRunner;
    return yield* runQuery.runQuery(first.counter.storageUrl, args);
  }).pipe(Effect.orDie),
);
const hasAuth = FunctionImpl.make(schema, spec, "hasAuth", () =>
  Effect.gen(function* () {
    const runQuery = yield* QueryRunner;
    return yield* runQuery.runQuery(first.counter.hasAuth, {});
  }).pipe(Effect.orDie),
);

const deepCreate = FunctionImpl.make(
  schema,
  spec,
  "deepCreate",
  ({ run, installation, count }) =>
    Effect.gen(function* () {
      const mutation = yield* MutationRunner;
      const binding = installation === "left" ? left : right;
      return yield* mutation.runMutation(binding.parent.deepCreate, {
        run,
        count,
      });
    }).pipe(Effect.orDie),
);
const deepRead = FunctionImpl.make(
  schema,
  spec,
  "deepRead",
  ({ run, installation }) =>
    Effect.gen(function* () {
      const query = yield* QueryRunner;
      const binding = installation === "left" ? left : right;
      return {
        counts: yield* query.runQuery(binding.parent.deepList, { run }),
        path: yield* query.runQuery(binding.parent.deepLocation, {}),
      };
    }).pipe(Effect.orDie),
);
const declaredError = FunctionImpl.make(
  schema,
  spec,
  "declaredError",
  ({ run }) =>
    Effect.gen(function* () {
      const mutation = yield* MutationRunner;
      const query = yield* QueryRunner;
      const error = yield* mutation
        .runMutation(first.counter.reject, { run })
        .pipe(
          Effect.andThen(() =>
            Effect.die("Expected the component mutation to fail"),
          ),
          Effect.catchTag("Rejected", Effect.succeed),
        );
      return {
        tag: error._tag,
        run: error.run,
        // oxlint-disable-next-line effecttsgo/instance-of-schema -- Class identity is the behavior under test.
        instance: error instanceof Rejected,
        remaining: (yield* query.runQuery(first.counter.list, { run })).map(
          (doc) => doc.count,
        ),
      };
    }).pipe(Effect.orDie),
);
const seed = FunctionImpl.make(schema, spec, "seed", ({ run, counts }) =>
  Effect.gen(function* () {
    const mutation = yield* MutationRunner;
    for (const count of counts)
      yield* mutation.runMutation(first.counter.create, { run, count });
    yield* mutation.runMutation(second.counter.create, { run, count: 99 });
    return null;
  }).pipe(Effect.orDie),
);
const page = FunctionImpl.make(schema, spec, "page", (args) =>
  Effect.gen(function* () {
    const query = yield* QueryRunner;
    const result = yield* query.runQuery(first.counter.page, args);
    return { ...result, page: result.page.map((doc) => doc.count) };
  }).pipe(Effect.orDie),
);
const environment = FunctionImpl.make(schema, spec, "environment", () =>
  Effect.gen(function* () {
    const query = yield* QueryRunner;
    return {
      first: yield* query.runQuery(first.counter.environment, {}),
      second: yield* query.runQuery(second.counter.environment, {}),
      host: {
        marker: Option.getOrElse(yield* env.COMPONENT_MARKER, () => "unset"),
        hostOnly: Option.getOrElse(
          yield* env.COMPONENT_HOST_ONLY,
          () => "unset",
        ),
      },
    };
  }).pipe(Effect.orDie),
);
const ticks = FunctionImpl.make(schema, spec, "ticks", () =>
  Effect.gen(function* () {
    const query = yield* QueryRunner;
    return {
      first: yield* query.runQuery(first.counter.ticks, {}),
      second: yield* query.runQuery(second.counter.ticks, {}),
    };
  }).pipe(Effect.orDie),
);

export default GroupImpl.make(schema, spec).pipe(
  Layer.provide([
    exercise,
    schedule,
    scheduleAndCancel,
    cancel,
    list,
    uploadUrl,
    storageUrl,
    hasAuth,
    deepCreate,
    deepRead,
    declaredError,
    seed,
    page,
    environment,
    ticks,
  ]),
  GroupImpl.finalize,
);
