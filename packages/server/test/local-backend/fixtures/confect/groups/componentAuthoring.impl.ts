import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { classProbeHandler } from "../../components/counter/confect/authoringHandler";
import type { ClassProbe } from "../../components/counter/confect/authoring.spec";
import schema from "../_generated/schema";
import { MutationRunner, QueryRunner } from "../_generated/services";
import { first } from "../componentBindings";
import spec from "./componentAuthoring.spec";

const save = FunctionImpl.make(schema, spec, "save", (ids) =>
  Effect.gen(function* () {
    const runner = yield* MutationRunner;
    return yield* runner.runMutation(first.authoring.save, ids);
  }).pipe(Effect.orDie),
);

const read = FunctionImpl.make(schema, spec, "read", (args) =>
  Effect.gen(function* () {
    const runner = yield* QueryRunner;
    return yield* runner.runQuery(first.authoring.read, args);
  }).pipe(Effect.orDie),
);

const probe = FunctionImpl.make(schema, spec, "probe", (args) =>
  Effect.gen(function* () {
    const runner = yield* QueryRunner;
    const value: ClassProbe = yield* runner.runQuery(
      first.authoring.probe,
      args,
    );
    return value;
  }).pipe(Effect.orDie),
);

const render = FunctionImpl.make(schema, spec, "render", ({ value }) =>
  classProbeHandler(first.authoring.probe, value),
);

export default GroupImpl.make(schema, spec).pipe(
  Layer.provide([save, read, probe, render]),
  GroupImpl.finalize,
);
