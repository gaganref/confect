import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Layer from "effect/Layer";
import { capture } from "../../../confect/reservedCapture";
import schema from "./_generated/schema";
import spec from "./reserved.spec";

export default GroupImpl.make(schema, spec).pipe(
  Layer.provide(FunctionImpl.make(schema, spec, "echo", capture)),
  GroupImpl.finalize,
);
