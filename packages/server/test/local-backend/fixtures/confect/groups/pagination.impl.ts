import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import schema from "../_generated/schema";
import {
  DatabaseReader,
  MutationRunner,
  QueryRunner,
} from "../_generated/services";
import { first } from "../componentBindings";
import spec from "./pagination.spec";

const page = FunctionImpl.make(schema, spec, "page", (args) =>
  Effect.gen(function* () {
    const runner = yield* QueryRunner;
    const result = yield* runner.runQuery(first.pagination.page, args);
    return { ...result, page: result.page.map((d) => d.count) };
  }).pipe(Effect.orDie),
);
const searchPage = FunctionImpl.make(schema, spec, "searchPage", (args) =>
  Effect.gen(function* () {
    const runner = yield* QueryRunner;
    const result = yield* runner.runQuery(first.pagination.searchPage, args);
    return { ...result, page: result.page.map((d) => d.count) };
  }).pipe(Effect.orDie),
);
const twice = FunctionImpl.make(schema, spec, "twice", (args) =>
  Effect.gen(function* () {
    const reader = yield* DatabaseReader;
    yield* reader
      .table("transactionNotes")
      .index("by_caseId")
      .paginate({ cursor: null, numItems: 1 });
    const runner = yield* QueryRunner;
    yield* runner.runQuery(first.pagination.page, args);
    return null;
  }).pipe(Effect.orDie),
);
const streams = FunctionImpl.make(schema, spec, "streams", (args) =>
  Effect.gen(function* () {
    const runner = yield* QueryRunner;
    return yield* runner.runQuery(first.pagination.streams, args);
  }).pipe(Effect.orDie),
);
const hook = FunctionImpl.make(schema, spec, "hook", (args) =>
  Effect.gen(function* () {
    const runner = yield* MutationRunner;
    return yield* runner.runMutation(first.pagination.hook, args);
  }).pipe(Effect.orDie),
);
export default GroupImpl.make(schema, spec).pipe(
  Layer.provide([page, searchPage, twice, streams, hook]),
  GroupImpl.finalize,
);
