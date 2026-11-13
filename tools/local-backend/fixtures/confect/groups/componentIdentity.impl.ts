import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Layer from "effect/Layer";
import schema from "../_generated/schema";
import { fromAction, fromMutation, fromQuery } from "./componentIdentity";
import spec from "./componentIdentity.spec";

export default GroupImpl.make(schema, spec).pipe(
  Layer.provide([
    FunctionImpl.make(schema, spec, "fromQuery", fromQuery),
    FunctionImpl.make(schema, spec, "fromMutation", fromMutation),
    FunctionImpl.make(schema, spec, "fromAction", fromAction),
  ]),
  GroupImpl.finalize,
);
