import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import schema from "./_generated/schema";
import { runs } from "./guard";
import spec from "./probeNode.spec";
import { verdict } from "./verdict";

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

export default GroupImpl.make(schema, spec).pipe(
  Layer.provide([version, checkRuns, internalRuns]),
  GroupImpl.finalize,
);
