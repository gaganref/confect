import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import schema from "./_generated/schema";
import { runs } from "./guard";
import spec from "./probe.spec";
import { verdict } from "./verdict";

const version = FunctionImpl.make(schema, spec, "version", () =>
  Effect.succeed(verdict.version),
);

const checkRuns = FunctionImpl.make(schema, spec, "checkRuns", () =>
  Effect.sync(() => runs.count),
);

export default GroupImpl.make(schema, spec).pipe(
  Layer.provide([version, checkRuns]),
  GroupImpl.finalize,
);
