import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import schema from "./_generated/schema";
import { runs } from "./guard";
import { Guarded } from "./mount";
import spec from "./probe.spec";
import { verdict } from "./verdict";

// Each reads the checks this call's module graph ran: none, since only push
// analysis calls `exportArgs`.
const counted = Effect.sync(() => runs.count);

const version = FunctionImpl.make(schema, spec, "version", () =>
  Effect.succeed(verdict.version),
);
const checkRuns = FunctionImpl.make(schema, spec, "checkRuns", () => counted);
const internalRuns = FunctionImpl.make(
  schema,
  spec,
  "internalRuns",
  () => counted,
);
const touch = FunctionImpl.make(schema, spec, "touch", () => counted);
const internalTouch = FunctionImpl.make(
  schema,
  spec,
  "internalTouch",
  () => counted,
);
const act = FunctionImpl.make(schema, spec, "act", () => counted);
const internalAct = FunctionImpl.make(
  schema,
  spec,
  "internalAct",
  () => counted,
);
const componentVersion = FunctionImpl.make(
  schema,
  spec,
  "componentVersion",
  () => Effect.flatMap(Guarded, (guarded) => guarded.version()),
);
const componentCheckRuns = FunctionImpl.make(
  schema,
  spec,
  "componentCheckRuns",
  () => Effect.flatMap(Guarded, (guarded) => guarded.checkRuns()),
);

export default GroupImpl.make(schema, spec).pipe(
  Layer.provide([
    version,
    checkRuns,
    internalRuns,
    touch,
    internalTouch,
    act,
    internalAct,
    componentVersion,
    componentCheckRuns,
  ]),
  GroupImpl.finalize,
);
