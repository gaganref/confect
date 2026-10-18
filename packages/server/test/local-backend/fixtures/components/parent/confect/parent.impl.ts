import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import schema from "./_generated/schema";
import { MutationRunner, QueryRunner } from "./_generated/services";
import { child, deep } from "./child";
import parent from "./parent.spec";

const create = FunctionImpl.make(schema, parent, "create", (args) =>
  Effect.gen(function* () {
    const runMutation = yield* MutationRunner;
    return yield* runMutation.runMutation(child.counter.create, args);
  }).pipe(Effect.orDie),
);
const list = FunctionImpl.make(schema, parent, "list", (args) =>
  Effect.gen(function* () {
    const runQuery = yield* QueryRunner;
    return yield* runQuery.runQuery(child.counter.list, args);
  }).pipe(Effect.orDie),
);

const deepCreate = FunctionImpl.make(schema, parent, "deepCreate", (args) =>
  Effect.gen(function* () {
    const runner = yield* MutationRunner;
    yield* runner.runMutation(deep.parent.create, args);
    return null;
  }).pipe(Effect.orDie),
);
const deepList = FunctionImpl.make(schema, parent, "deepList", (args) =>
  Effect.gen(function* () {
    const runner = yield* QueryRunner;
    return (yield* runner.runQuery(deep.parent.list, args)).map(
      (doc) => doc.count,
    );
  }).pipe(Effect.orDie),
);
const deepLocation = FunctionImpl.make(schema, parent, "deepLocation", () =>
  Effect.gen(function* () {
    const runner = yield* QueryRunner;
    return yield* runner.runQuery(deep.parent.location, {});
  }).pipe(Effect.orDie),
);
export default GroupImpl.make(schema, parent).pipe(
  Layer.provide([create, list, deepCreate, deepList, deepLocation]),
  GroupImpl.finalize,
);
