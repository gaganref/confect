import { MiddlewareImpl } from "@confect/server";
import { Policy } from "../policy";
import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import databaseSchema from "../_generated/schema";
import { DatabaseReader } from "../_generated/services";
import notes from "./tasks.spec";
const list = FunctionImpl.make(databaseSchema, notes, "list", () => Effect.gen(function* () {
  const reader = yield* DatabaseReader;
  return yield* reader.table("notes").collect();
}).pipe(Effect.orDie));
export default GroupImpl.make(databaseSchema, notes).pipe(Layer.provide(list), Layer.provide(MiddlewareImpl.make(databaseSchema, Policy, effect => effect)), GroupImpl.finalize);
