import { Callback, FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import env from "./env.js";
import {
  OnCheckedArgs,
  OnResult,
} from "../components/counter/confect/callbacks.js";
import schema from "./_generated/schema.js";
import refs from "./_generated/refs.js";
import { MutationRunner, QueryRunner } from "./_generated/services.js";
import { counter } from "./component.js";
import hello from "./hello.spec.js";
const readMarker = FunctionImpl.make(schema, hello, "readMarker", () =>
  Effect.gen(function* () { return Option.getOrElse(yield* env.INSTALL_MARKER, () => "unset"); }).pipe(Effect.orDie),
);
const greet = FunctionImpl.make(schema, hello, "greet", () =>
  Effect.succeed("hello from fork"),
);
const increment = FunctionImpl.make(schema, hello, "increment", (args) =>
  Effect.gen(function* () {
    const runner = yield* QueryRunner;
    return yield* runner.runQuery(counter.counter.increment, args);
  }).pipe(Effect.orDie),
);
const onResult = FunctionImpl.make(schema, hello, "onResult", ({ value }) =>
  Effect.succeed(value + 21),
);
const wrongArgs = FunctionImpl.make(schema, hello, "wrongArgs", () =>
  Effect.succeed(0),
);
const notify = FunctionImpl.make(schema, hello, "notify", ({ value }) =>
  Effect.gen(function* () {
    const runner = yield* MutationRunner;
    const handle = yield* Callback.create(
      OnResult,
      refs.internal.hello.onResult,
    );
    return yield* runner.runMutation(counter.counter.notify, {
      value,
      onResult: handle,
    });
  }).pipe(Effect.orDie),
);
const checkArgs = FunctionImpl.make(schema, hello, "checkArgs", () =>
  Callback.create(OnCheckedArgs, refs.internal.hello.wrongArgs).pipe(
    Effect.as("accepted"),
    Effect.catchTag("CallbackContractMismatch", (error) =>
      Effect.succeed(error.side),
    ),
  ),
);
export default GroupImpl.make(schema, hello).pipe(
  Layer.provide([readMarker, greet, increment, onResult, wrongArgs, notify, checkArgs]),
  GroupImpl.finalize,
);
