import { ActionCall, FunctionSpec, Ref } from "@confect/core";
import {
  ActionCall as ActionCallImpl,
  ActionCtx,
  ActionRunner,
  FunctionImpl,
  GroupImpl,
  MiddlewareImpl,
  MutationRunner,
  QueryRunner,
  Scheduler,
} from "@confect/server";
import * as Duration from "effect/Duration";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import schema from "../_generated/schema";
import refs from "../_generated/refs";
import spec, { Preflight } from "./actionCall.spec";

const notes = refs.public.groups.notes;

const execute = FunctionImpl.make(schema, spec, "execute", ({ mode }) =>
  Effect.gen(function* () {
    const call = yield* ActionCall.ActionCall;
    const insert = (text: string) => call(notes.insert, { text });
    switch (mode) {
      case "scheduleAfter":
      case "scheduleAt":
      case "preflight":
      case "write":
        return yield* insert("one call");
      case "read":
        return (yield* call(notes.list)).length;
      case "twice": {
        const operation = insert("first only");
        yield* operation;
        yield* operation;
        return 0;
      }
      case "parallel":
        yield* Effect.all(
          [insert("parallel first"), insert("parallel second")],
          { concurrency: "unbounded" },
        );
        return 0;
      case "unused":
        return 0;
      case "inspect": {
        const raw = yield* Effect.all([
          Effect.serviceOption(QueryRunner.QueryRunner),
          Effect.serviceOption(MutationRunner.MutationRunner),
          Effect.serviceOption(ActionRunner.ActionRunner),
          Effect.serviceOption(ActionCtx.ActionCtx()),
          Effect.serviceOption(Scheduler.Scheduler),
        ]);
        yield* call(notes.list);
        return raw.every((option) => option._tag === "None");
      }
      case "failedEncoding": {
        const target = Ref.make(
          "groups/notes",
          FunctionSpec.publicMutation({
            name: "insert",
            args: () => ({ text: Schema.String.check(Schema.isMinLength(1)) }),
            returns: () => Schema.String,
          }),
        );
        yield* call(target, { text: "" }).pipe(
          Effect.catchTag("SchemaError", () => Effect.succeed("recovered")),
        );
        return 0;
      }
    }
  }).pipe(Effect.orDie),
);

export default GroupImpl.make(schema, spec).pipe(
  Layer.provide(execute),
  Layer.provide(
    MiddlewareImpl.make(schema, Preflight, (effect, { invocation }) =>
      Effect.gen(function* () {
        const mode = (invocation.args as { mode?: string }).mode;
        if (mode === "scheduleAfter" || mode === "scheduleAt") {
          const scheduler = yield* Scheduler.Scheduler;
          if (mode === "scheduleAfter")
            yield* scheduler.runAfter(Duration.zero, notes.insert, {
              text: "escaped",
            });
          else
            yield* scheduler.runAt(DateTime.makeUnsafe(0), notes.insert, {
              text: "escaped",
            });
        }
        if (mode === "preflight") {
          const runner = yield* QueryRunner.QueryRunner;
          yield* runner.runQuery(notes.list).pipe(Effect.orDie);
        }
        return yield* effect;
      }),
    ),
  ),
  Layer.provide(ActionCallImpl.layer(schema)),
  GroupImpl.finalize,
);
