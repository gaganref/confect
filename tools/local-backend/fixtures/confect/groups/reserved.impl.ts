import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { snapshot } from "../reservedContext";
import * as Option from "effect/Option";
import schema from "../_generated/schema";
import refs from "../_generated/refs";
import {
  ActionRunner,
  DatabaseReader,
  DatabaseWriter,
  MutationRunner,
  MutationTransactionContext,
  Scheduler,
} from "../_generated/services";
import { first } from "../componentBindings";
import { capture } from "../reservedCapture";
import { hops } from "../runtime";
import spec from "./reserved.spec";

const echo = FunctionImpl.make(schema, spec, "echo", capture);
const echoAction = FunctionImpl.make(schema, spec, "echoAction", capture);
const inline = FunctionImpl.make(schema, spec, "inline", (args) =>
  Effect.gen(function* () {
    const transaction = yield* MutationTransactionContext;
    const mutation = yield* MutationRunner;
    const child = yield* transaction.runMutation(first.reserved.echo, args, {
      transactionLimits: {},
    });
    const plain = yield* mutation.runMutation(first.counter.create, {
      run: args.run,
      count: 1,
    });
    return {
      parent: yield* capture(args),
      child,
      plain,
      hops: Object.fromEntries(hops),
    };
  }).pipe(Effect.orDie),
);
const write = FunctionImpl.make(schema, spec, "write", (args) =>
  Effect.gen(function* () {
    const writer = yield* DatabaseWriter;
    yield* writer.table("transactionNotes").insert({
      caseId: `reserved:${args.run}`,
      value: yield* Schema.encodeEffect(Schema.fromJsonString(snapshot()))(
        yield* capture(args),
      ),
    });
    return null;
  }).pipe(Effect.orDie),
);
const read = FunctionImpl.make(schema, spec, "read", ({ run }) =>
  Effect.gen(function* () {
    const reader = yield* DatabaseReader;
    const row = yield* reader
      .table("transactionNotes")
      .index("by_caseId", (range) => range.eq("caseId", `reserved:${run}`))
      .first();
    return Option.isSome(row)
      ? yield* Schema.decodeEffect(Schema.fromJsonString(snapshot()))(
          row.value.value,
        )
      : null;
  }).pipe(Effect.orDie),
);
const chain = FunctionImpl.make(schema, spec, "chain", (args) =>
  Effect.gen(function* () {
    const mutations = yield* MutationRunner;
    const actions = yield* ActionRunner;
    const scheduler = yield* Scheduler;
    const mutation = yield* mutations.runMutation(
      refs.public.groups.reserved.echo,
      args,
    );
    const action = yield* actions.runAction(
      refs.public.groups.reserved.echoAction,
      args,
    );
    const component = yield* mutations.runMutation(
      refs.public.groups.reserved.inline,
      args,
    );
    const jobId = yield* scheduler.runAfter(
      Duration.zero,
      refs.public.groups.reserved.write,
      args,
    );
    return {
      mutation,
      action,
      inline: component,
      jobId,
      hops: Object.fromEntries(hops),
    };
  }).pipe(Effect.orDie),
);

export default GroupImpl.make(schema, spec).pipe(
  Layer.provide([echo, echoAction, inline, write, read, chain]),
  GroupImpl.finalize,
);
