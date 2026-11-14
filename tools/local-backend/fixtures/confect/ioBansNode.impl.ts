import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import databaseSchema from "./_generated/schema";
import ioBansNode from "./ioBansNode.spec";

const surfaceNode = FunctionImpl.make(
  databaseSchema,
  ioBansNode,
  "surfaceNode",
  () =>
    Effect.sync(() => ({
      setImmediate: typeof globalThis.setImmediate,
      queueMicrotask: typeof globalThis.queueMicrotask,
    })),
);

export default GroupImpl.make(databaseSchema, ioBansNode).pipe(
  Layer.provide(surfaceNode),
  GroupImpl.finalize,
);
