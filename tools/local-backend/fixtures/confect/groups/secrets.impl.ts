import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import databaseSchema from "../_generated/schema";
import secrets from "./secrets.spec";

const store = FunctionImpl.make(databaseSchema, secrets, "store", () =>
  Effect.succeed(null),
);

export default GroupImpl.make(databaseSchema, secrets).pipe(
  Layer.provide(store),
  GroupImpl.finalize,
);
