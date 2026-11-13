// oxlint-disable-next-line effecttsgo/node-builtin-import -- A stored file's digest is a synchronous SHA-256 of bytes the kernel already holds, as the binary hashes the upload it writes.
import { createHash } from "node:crypto";
import { Base64 } from "convex/values";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { DocumentId, StoredDocument } from "./KernelValues.js";
import { tableNameFromId } from "./KernelValues.js";

/**
 * Convex's file storage table as functions read it. Each component has its own.
 */
export const table = "_storage";

/**
 * The origin the kernel's storage URLs carry. The binary uses its deployment's
 * `.convex.cloud` origin. Nothing answers at this one: the kernel serves no
 * file and takes no upload.
 */
export const origin = "https://kernel.convex.cloud";

/**
 * What the kernel keeps beside a file's row: its bytes, the component that
 * stored it, and the storage UUID the binary mints for every file. The row
 * holds only what the binary's `_storage` virtual table shows.
 */
export interface File {
  readonly componentPath: string;
  readonly uuid: string;
  readonly bytes: Uint8Array;
}

/**
 * The storage ID named no file in its component, as the binary's
 * `FileStorage::delete` refuses (`StorageIdNotFound`).
 */
export class StorageIdNotFound extends Schema.TaggedError<StorageIdNotFound>()(
  "StorageIdNotFound",
  { storageId: Schema.String, message: Schema.String },
) {}

/**
 * A storage operation's argument did not parse, as the binary's
 * `with_argument_error` refuses (`InvalidArgument`).
 */
export class InvalidStorageArgument extends Schema.TaggedError<InvalidStorageArgument>()(
  "InvalidStorageArgument",
  {
    operation: Schema.String,
    argument: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * The digest a caller declared is not the stored bytes' digest, as the binary's
 * `FileStorage::upload_file` refuses (`Sha256Mismatch`).
 */
export class Sha256Mismatch extends Schema.TaggedError<Sha256Mismatch>()(
  "Sha256Mismatch",
  { expected: Schema.String, actual: Schema.String, message: Schema.String },
) {}

export type StorageError =
  | StorageIdNotFound
  | InvalidStorageArgument
  | Sha256Mismatch;

const invalid = (operation: string, argument: string, cause: string) =>
  new InvalidStorageArgument({
    operation,
    argument,
    message: `Invalid argument \`${argument}\` for \`${operation}\`: ${cause}`,
  });

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What a storage ID names: a `_storage` document, or a file by the storage UUID
 * files had before Convex 1.6, which the binary still accepts
 * (`FileStorageId::from_str` in `crates/model/src/file_storage/mod.rs`).
 */
export type StorageId =
  | { readonly kind: "document"; readonly id: DocumentId }
  | { readonly kind: "legacy"; readonly uuid: string };

/**
 * Parse a storage ID as the binary does. An ID of any other table is refused,
 * as `query_for_storage_id` refuses it.
 */
export const parseId = (
  operation: string,
  storageId: unknown,
): Result.Result<StorageId, InvalidStorageArgument> => {
  if (typeof storageId !== "string") {
    return Result.fail(
      invalid(
        operation,
        "storageId",
        `expected a string, got ${typeof storageId}`,
      ),
    );
  }
  if (uuidPattern.test(storageId)) {
    return Result.succeed({ kind: "legacy", uuid: storageId.toLowerCase() });
  }
  const tableName = tableNameFromId(storageId);
  if (tableName === null) {
    return Result.fail(
      invalid(
        operation,
        "storageId",
        `Invalid storage ID: "${storageId}". Storage ID should be an Id of '_storage' table, or a UUID string.`,
      ),
    );
  }
  if (tableName !== table) {
    return Result.fail(
      new InvalidStorageArgument({
        operation,
        argument: "storageId",
        message:
          "Invalid storage ID. Storage ID cannot be an ID on any table other than '_storage'.",
      }),
    );
  }
  return Result.succeed({ kind: "document", id: storageId as DocumentId });
};

/**
 * The SHA-256 of `bytes`, base64-encoded with padding, as the binary's
 * `Sha256Digest::as_base64` encodes it for the `_storage` virtual table
 * (`crates/model/src/file_storage/virtual_table.rs`, npm 1.9 and later).
 */
export const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("base64");

const hex = (base64: string): string =>
  Array.from(Base64.toByteArray(base64), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

/**
 * Check a declared digest against the bytes' own. The binary decodes the
 * declared one first and refuses one that is not 32 bytes of base64.
 */
export const checkDigest = (
  operation: string,
  expected: unknown,
  actual: string,
): Result.Result<void, InvalidStorageArgument | Sha256Mismatch> => {
  if (expected === undefined || expected === null) return Result.void;
  if (typeof expected !== "string") {
    return Result.fail(
      invalid(operation, "sha256", `expected a string, got ${typeof expected}`),
    );
  }
  let decoded: Uint8Array;
  try {
    decoded = Base64.toByteArray(expected);
  } catch (error) {
    return Result.fail(
      invalid(
        operation,
        "sha256",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
  if (decoded.length !== 32) {
    return Result.fail(invalid(operation, "sha256", "sha256 not 32 bytes"));
  }
  const canonical = Base64.fromByteArray(decoded);
  return canonical === actual
    ? Result.void
    : Result.fail(
        new Sha256Mismatch({
          expected: canonical,
          actual,
          message: `Sha256 mismatch. Expected: ${canonical} Actual: ${actual}`,
        }),
      );
};

const mediaType =
  /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+(\s*;.*)?$/i;

/**
 * A file's content type: none for an empty one, as the binary filters it, and a
 * refusal for one that is no media type.
 */
export const contentType = (
  operation: string,
  type: unknown,
): Result.Result<string | null, InvalidStorageArgument> => {
  if (type === undefined || type === null || type === "") {
    return Result.succeed(null);
  }
  if (typeof type !== "string") {
    return Result.fail(
      invalid(
        operation,
        "contentType",
        `expected a string, got ${typeof type}`,
      ),
    );
  }
  if (!mediaType.test(type)) {
    return Result.fail(
      invalid(operation, "contentType", `"${type}" is not a media type`),
    );
  }
  return Result.succeed(type);
};

/**
 * A file's row as the binary's `_storage` virtual table shows it:
 * `FileStorageDocMapper` maps the system row to its ID, creation time, base64
 * digest, size as a float and content type, `null` when the file has none
 * (`crates/model/src/file_storage/virtual_table.rs`). The npm package's
 * `_storage` schema declares the field optional, but the binary keeps it.
 */
export const row = (
  id: DocumentId,
  creationTime: number,
  bytes: Uint8Array,
  type: string | null,
): StoredDocument => ({
  _id: id,
  _creationTime: creationTime,
  sha256: digest(bytes),
  size: bytes.length,
  contentType: type,
});

/**
 * The deprecated `storage.getMetadata` answer. The binary still answers it with
 * a hex digest and the file's storage UUID (`storage_get_metadata` in
 * `crates/isolate/src/environment/udf/async_syscall.rs`).
 */
export const metadata = (doc: StoredDocument, file: File) => ({
  storageId: file.uuid,
  sha256: hex(doc["sha256"] as string),
  size: doc["size"] as number,
  contentType: doc["contentType"] as string | null,
});

/**
 * A file's URL as the binary's `FileStorage::get_url_batch` builds it: the
 * origin, `/api/storage/`, the file's storage UUID, and the component's ID as a
 * query for a file outside the root. The kernel's component ID is its path.
 */
export const fileUrl = (file: File): string =>
  `${origin}/api/storage/${file.uuid}${
    file.componentPath === ""
      ? ""
      : `?component=${encodeURIComponent(file.componentPath)}`
  }`;

/**
 * An upload URL in the binary's shape (`generate_upload_url_with_origin` in
 * `crates/file_storage/src/core.rs`). The binary's token is signed; the
 * kernel's is not, and the kernel takes no upload at it.
 */
export const uploadUrl = (token: string): string =>
  `${origin}/api/storage/upload?token=${token}`;

/**
 * A storage UUID for the kernel's `n`th file: a version 4 shape, counted so a
 * replay mints the same ones.
 */
export const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

/**
 * Which binary-only storage endpoint a URL on the kernel's origin names, if
 * any: the upload endpoint, or a file download.
 */
export const endpoint = (
  url: string,
): "storageUpload" | "storageDownload" | undefined => {
  if (!url.startsWith(`${origin}/`)) return undefined;
  const { pathname } = new URL(url);
  if (pathname === "/api/storage/upload") return "storageUpload";
  return pathname.startsWith("/api/storage/") ? "storageDownload" : undefined;
};
