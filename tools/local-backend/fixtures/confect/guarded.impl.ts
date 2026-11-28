import { Ref } from "@confect/core";
import { FunctionImpl, GroupImpl } from "@confect/server";
import { makeFunctionReference } from "convex/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import databaseSchema from "./_generated/schema";
import refs from "./_generated/refs";
import { MutationRunner, QueryRunner } from "./_generated/services";
import guarded from "./guarded.spec";

// Records the request, so a test sees whether the handler ran, then makes the
// nested call `storageId` names, which the binary refuses for a malformed id,
// or passes `secret` beside an extra field to a mutation whose arguments hold a
// secret, which Confect refuses in the binary's place.
const write = FunctionImpl.make(
  databaseSchema,
  guarded,
  "write",
  ({ caseId, storageId, secret }) =>
    Effect.gen(function* () {
      const { runMutation } = yield* MutationRunner;
      yield* runMutation(refs.internal.groups.transactions.write, {
        caseId,
        value: "handled",
        fail: false,
      });
      if (storageId !== undefined) {
        const { runQuery } = yield* QueryRunner;
        yield* runQuery(refs.public.groups.storage.getUrl, {
          storageId: storageId as never,
        });
      }
      if (secret !== undefined) {
        yield* runMutation(
          Ref.fromFunctionReference(
            makeFunctionReference<"mutation", any, null>(
              "groups/secrets:store",
            ),
          ),
          { value: secret, extra: 1 },
        );
      }
      return null;
    }).pipe(Effect.orDie),
);

export default GroupImpl.make(databaseSchema, guarded).pipe(
  Layer.provide(write),
  GroupImpl.finalize,
);
