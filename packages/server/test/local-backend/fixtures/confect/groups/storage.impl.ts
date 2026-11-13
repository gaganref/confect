/**
 * Handlers exercise Confect's storage service inside the real Convex isolate.
 * URL operations decode Convex's string return values with
 * `Schema.URLFromString`, so they only succeed if that string→URL decode works
 * in the isolate.
 */

import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import databaseSchema from "../_generated/schema";
import type { GenericId } from "convex/values";
import { MutationCtx, QueryCtx, Storage } from "../_generated/services";
import { getFunctionReference } from "@confect/core/RefInternal";
import refs from "../_generated/refs";
import storage from "./storage.spec";

const generateUploadUrl = FunctionImpl.make(
  databaseSchema,
  storage,
  "generateUploadUrl",
  () =>
    Effect.gen(function* () {
      const storageService = yield* Storage;

      const url = yield* storageService.generateUploadUrl;

      return url.toString();
    }),
);

const getUrl = FunctionImpl.make(
  databaseSchema,
  storage,
  "getUrl",
  ({ storageId }) =>
    Effect.gen(function* () {
      const storageService = yield* Storage;

      const url = yield* storageService.getUrl(storageId);

      return url.toString();
    }).pipe(Effect.orDie),
);

const store = FunctionImpl.make(databaseSchema, storage, "store", ({ text }) =>
  Effect.gen(function* () {
    const storageService = yield* Storage;

    return yield* storageService.store(
      new Blob([text], { type: "text/plain" }),
    );
  }),
);

const get = FunctionImpl.make(databaseSchema, storage, "get", ({ storageId }) =>
  Effect.gen(function* () {
    const storageService = yield* Storage;
    const blob = yield* storageService.get(storageId);

    return yield* Effect.promise(() => blob.text());
  }).pipe(Effect.orDie),
);

const deleteBlob = FunctionImpl.make(
  databaseSchema,
  storage,
  "deleteBlob",
  ({ storageId }) =>
    Effect.gen(function* () {
      const storageService = yield* Storage;
      yield* storageService.delete(storageId);

      return null;
    }).pipe(Effect.orDie),
);

// The binary's storage metadata, for the kernel's parity cases: a file stored
// with an optional content type and declared digest, its `_storage` row, its
// deprecated metadata and its URL, and a delete that keeps Convex's own error.
const storeWith = FunctionImpl.make(
  databaseSchema,
  storage,
  "storeWith",
  ({ text, contentType, sha256 }) =>
    Effect.gen(function* () {
      const storageService = yield* Storage;

      return yield* storageService.store(
        new Blob([text], { type: contentType }),
        sha256 === "" ? undefined : { sha256 },
      );
    }),
);

const describe = FunctionImpl.make(
  databaseSchema,
  storage,
  "describe",
  ({ storageId }) =>
    Effect.gen(function* () {
      const ctx = yield* QueryCtx;
      const [doc, metadata, url] = yield* Effect.promise(() =>
        Promise.all([
          ctx.db.system.get("_storage", storageId),
          ctx.storage.getMetadata(storageId),
          ctx.storage.getUrl(storageId),
        ]),
      );

      // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- The probe hands the binary's raw answers to the test as they are, a null content type included.
      return JSON.stringify({ doc, metadata, url });
    }),
);

const deleteRaw = FunctionImpl.make(
  databaseSchema,
  storage,
  "deleteRaw",
  ({ storageId }) =>
    Effect.gen(function* () {
      const ctx = yield* MutationCtx;
      yield* Effect.promise(() => ctx.storage.delete(storageId));

      return null;
    }),
);

// A mutation's store, for the content type probes: the stored content type,
// or the binary's refusal.
const storeInMutation = FunctionImpl.make(
  databaseSchema,
  storage,
  "storeInMutation",
  ({ text, contentType }) =>
    Effect.gen(function* () {
      const ctx = yield* MutationCtx;
      return yield* Effect.promise(() =>
        ctx.storage
          .store(new Blob([text], { type: contentType }))
          .then((id) => ctx.db.system.get("_storage", id))
          .then(
            (doc) => `stored ${String(doc?.contentType)}`,
            (error: unknown) => `refused ${(error as Error).message}`,
          ),
      );
    }),
);

class ProbeRefused extends Schema.TaggedError<ProbeRefused>()("ProbeRefused", {
  message: Schema.String,
}) {}

const refused = (error: unknown) =>
  new ProbeRefused({ message: (error as Error).message });

// The file limit probes: store `count` files of `size` bytes, then read `ids`,
// one call at a time so each is counted before the next is checked. A refusal
// fails with the backend's message.
const storeThenRead = (
  ctx: MutationCtx,
  count: number,
  size: number,
  ids: ReadonlyArray<GenericId<"_storage">>,
) =>
  Effect.forEach(
    Array.from({ length: count }),
    () =>
      Effect.tryPromise({
        try: () => ctx.storage.store(new Blob([new Uint8Array(size)])),
        catch: refused,
      }),
    { discard: true },
  ).pipe(
    Effect.andThen(
      Effect.forEach(
        ids,
        (id) =>
          Effect.tryPromise({
            try: () => ctx.storage.get(id),
            catch: refused,
          }),
        { discard: true },
      ),
    ),
  );

// The nested half: a refusal is thrown as the backend raised it, so the caller
// sees what crosses the nested call's boundary.
const storeAndRead = FunctionImpl.make(
  databaseSchema,
  storage,
  "storeAndRead",
  ({ count, size, ids }) =>
    Effect.gen(function* () {
      const ctx = yield* MutationCtx;
      yield* Effect.promise(() =>
        Array.from({ length: count })
          .reduce<Promise<unknown>>(
            (previous) =>
              previous.then(() =>
                ctx.storage.store(new Blob([new Uint8Array(size)])),
              ),
            Promise.resolve(),
          )
          .then(() =>
            ids.reduce<Promise<unknown>>(
              (previous, id) => previous.then(() => ctx.storage.get(id)),
              Promise.resolve(),
            ),
          ),
      );
      return null;
    }),
);

// The same work inline, under the deployment's limits, or as a nested call
// under a budget. The answer is "ok" or the refusal's message.
const fileProbe = FunctionImpl.make(
  databaseSchema,
  storage,
  "fileProbe",
  ({ nested, count, size, ids, ...budget }) =>
    Effect.gen(function* () {
      const ctx = yield* MutationCtx;
      const work = nested
        ? Effect.tryPromise({
            try: () =>
              ctx.runMutation(
                getFunctionReference(refs.internal.groups.storage.storeAndRead),
                { count, size, ids },
                { transactionLimits: budget },
              ),
            catch: refused,
          })
        : storeThenRead(ctx, count, size, ids);
      return yield* work.pipe(
        Effect.match({
          onFailure: (error) => error.message,
          onSuccess: () => "ok",
        }),
      );
    }),
);

export default GroupImpl.make(databaseSchema, storage).pipe(
  Layer.provide(generateUploadUrl),
  Layer.provide(getUrl),
  Layer.provide(store),
  Layer.provide(get),
  Layer.provide(deleteBlob),
  Layer.provide(storeWith),
  Layer.provide(describe),
  Layer.provide(deleteRaw),
  Layer.provide(storeInMutation),
  Layer.provide(storeAndRead),
  Layer.provide(fileProbe),
  GroupImpl.finalize,
);
