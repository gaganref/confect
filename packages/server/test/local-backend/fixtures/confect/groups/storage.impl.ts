/**
 * Handlers exercise Confect's storage service inside the real Convex isolate.
 * URL operations decode Convex's string return values with
 * `Schema.URLFromString`, so they only succeed if that string→URL decode works
 * in the isolate.
 */

import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import databaseSchema from "../_generated/schema";
import { MutationCtx, QueryCtx, Storage } from "../_generated/services";
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

export default GroupImpl.make(databaseSchema, storage).pipe(
  Layer.provide(generateUploadUrl),
  Layer.provide(getUrl),
  Layer.provide(store),
  Layer.provide(get),
  Layer.provide(deleteBlob),
  Layer.provide(storeWith),
  Layer.provide(describe),
  Layer.provide(deleteRaw),
  GroupImpl.finalize,
);
