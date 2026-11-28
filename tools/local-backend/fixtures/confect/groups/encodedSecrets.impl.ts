import { getFunctionReference } from "@confect/core/RefInternal";
import { FunctionImpl, GroupImpl } from "@confect/server";
import type { GenericId } from "convex/values";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import refs from "../_generated/refs";
import databaseSchema from "../_generated/schema";
import { MutationCtx, QueryCtx } from "../_generated/services";
import encodedSecrets from "./encodedSecrets.spec";

const make = FunctionImpl.make;

export default GroupImpl.make(databaseSchema, encodedSecrets).pipe(
  Layer.provide([
    make(databaseSchema, encodedSecrets, "releasedTake", () =>
      Effect.succeed(null),
    ),
    make(databaseSchema, encodedSecrets, "structTake", () =>
      Effect.succeed(null),
    ),
    make(databaseSchema, encodedSecrets, "midChainTake", () =>
      Effect.succeed(null),
    ),
    make(databaseSchema, encodedSecrets, "releasedGive", ({ value }) =>
      // oxlint-disable-next-line effecttsgo/global-date -- A Date is a class instance Convex cannot serialize.
      Effect.succeed({ extra: new Date(0), value }),
    ),
    make(databaseSchema, encodedSecrets, "structGive", ({ value }) =>
      // oxlint-disable-next-line effecttsgo/global-date -- A Date is a class instance Convex cannot serialize.
      Effect.succeed({ extra: new Date(0), value }),
    ),
    make(databaseSchema, encodedSecrets, "midChainGive", ({ value }) =>
      // oxlint-disable-next-line effecttsgo/global-date -- A Date is a class instance Convex cannot serialize.
      Effect.succeed({ extra: new Date(0), value }),
    ),
    make(databaseSchema, encodedSecrets, "wireEndTake", () =>
      Effect.succeed(null),
    ),
    make(databaseSchema, encodedSecrets, "wireEndGive", ({ value }) =>
      // oxlint-disable-next-line effecttsgo/global-date -- A Date is a class instance Convex cannot serialize.
      Effect.succeed({ extra: new Date(0), value }),
    ),
    make(databaseSchema, encodedSecrets, "recordTake", () =>
      Effect.succeed(null),
    ),
    make(databaseSchema, encodedSecrets, "recordGive", ({ value }) =>
      // oxlint-disable-next-line effecttsgo/global-date -- A Date is a class instance Convex cannot serialize.
      Effect.succeed({ extra: new Date(0), value }),
    ),
    make(databaseSchema, encodedSecrets, "scheduleRecordTake", ({ marker }) =>
      Effect.gen(function* () {
        const ctx = yield* MutationCtx;
        // The raw scheduler sends arguments the typed one would encode away:
        // an extra field, so the job's own check refuses them.
        return yield* Effect.promise(() =>
          ctx.scheduler.runAfter(
            0,
            getFunctionReference(refs.public.groups.encodedSecrets.recordTake),
            { value: { [marker]: "v" }, note: "unexpected" } as never,
          ),
        );
      }),
    ),
    make(databaseSchema, encodedSecrets, "jobState", ({ id }) =>
      Effect.gen(function* () {
        const ctx = yield* QueryCtx;
        const job = yield* Effect.promise(() =>
          ctx.db.system.get(id as GenericId<"_scheduled_functions">),
        );
        if (job === null) return { kind: "missing" };
        return job.state.kind === "failed"
          ? { kind: "failed", error: job.state.error }
          : { kind: job.state.kind };
      }),
    ),
  ]),
  GroupImpl.finalize,
);
