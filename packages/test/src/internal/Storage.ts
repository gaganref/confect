// oxlint-disable-next-line effecttsgo/node-builtin-import -- A stored file's digest is a synchronous SHA-256 of bytes the kernel already holds, as the binary hashes the upload it writes.
import { createHash } from "node:crypto";
import { Base64 } from "convex/values";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { DocumentId, StoredDocument } from "./KernelValues.js";
import { tableNameFromId } from "./KernelValues.js";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";

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
export class StorageIdNotFound extends Schema.TaggedError<
  StorageIdNotFound,
  { readonly brand: unique symbol }
>()("StorageIdNotFound", {
  storageId: Schema.String,
  message: Schema.String,
}) {}

/**
 * A storage operation's argument did not parse, as the binary's
 * `with_argument_error` refuses (`InvalidArgument`).
 */
export class InvalidStorageArgument extends Schema.TaggedError<
  InvalidStorageArgument,
  { readonly brand: unique symbol }
>()("InvalidStorageArgument", {
  operation: Schema.String,
  argument: Schema.String,
  message: Schema.String,
}) {}

/**
 * The digest a caller declared is not the stored bytes' digest, as the binary's
 * `FileStorage::upload_file` refuses (`Sha256Mismatch`).
 */
export class Sha256Mismatch extends Schema.TaggedError<
  Sha256Mismatch,
  { readonly brand: unique symbol }
>()("Sha256Mismatch", {
  expected: Schema.String,
  actual: Schema.String,
  message: Schema.String,
}) {}

export type StorageError =
  | StorageIdNotFound
  | InvalidStorageArgument
  | InvalidContentType
  | Sha256Mismatch;

const invalid = (operation: string, argument: string, cause: string) =>
  InvalidStorageArgument.make({
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
    return Result.succeed({
      kind: "legacy",
      uuid: pipe(storageId, Str.toLowerCase),
    });
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
      InvalidStorageArgument.make({
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
  Arr.join(
    Array.from(Base64.toByteArray(base64), (byte) =>
      pipe(byte.toString(16), Str.padStart(2, "0")),
    ),
    "",
  );

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
        Sha256Mismatch.make({
          expected: canonical,
          actual,
          message: `Sha256 mismatch. Expected: ${canonical} Actual: ${actual}`,
        }),
      );
};

// `mime` 0.3.17's `TOKEN_MAP` (`src/parse.rs:367-384`): RFC 7230's tchar.
const isToken = (c: number): boolean =>
  (c >= 0x30 && c <= 0x39) ||
  (c >= 0x41 && c <= 0x5a) ||
  (c >= 0x61 && c <= 0x7a) ||
  pipe("!#$%&'*+-.^_`|~", Str.includes(String.fromCharCode(c)));

// `is_restricted_quoted_char` (`src/parse.rs:390-392`).
const isQuotedChar = (c: number): boolean => c > 31 && c !== 127;

/**
 * Why `mime` 0.3.17 refuses a media type, in its own words (`ParseError::s` and
 * its `Display`, `src/parse.rs:22-41`, behind `FromStrError`'s "mime parse
 * error: " prefix, `src/lib.rs:83-93`).
 */
export type MediaTypeError =
  | { readonly kind: "missingSlash" }
  | { readonly kind: "missingEqual" }
  | { readonly kind: "missingQuote" }
  | {
      readonly kind: "invalidToken";
      readonly pos: number;
      readonly byte: number;
    };

export const mediaTypeMessage = (error: MediaTypeError): string =>
  `mime parse error: ${
    error.kind === "missingSlash"
      ? "a slash (/) was missing between the type and subtype"
      : error.kind === "missingEqual"
        ? "an equals sign (=) was missing between a parameter and its value"
        : error.kind === "missingQuote"
          ? 'a quote (") was missing from a parameter value'
          : `an invalid token was encountered, ${pipe(error.byte.toString(16), Str.toUpperCase)} at position ${error.pos}`
  }`;

/**
 * A media type as `mime` 0.3.17 parses and prints it, the binary's
 * `mime::Mime::from_str` and `Display` (`src/parse.rs:111-305`,
 * `src/lib.rs:447-451`): the type, subtype and parameter names and a charset
 * value lowercased, other values kept, and a bare trailing `;` dropped. The
 * port keeps the crate's own rules, an empty subtype and an empty unquoted
 * value at the end included. `text` is ASCII, as a `Blob`'s type always is.
 */
export const parseMediaType = (
  text: string,
): Result.Result<string, MediaTypeError> => {
  if (text === "*/*") return Result.succeed(text);
  const at = (i: number) =>
    pipe(
      text,
      Str.charCodeAt(i),
      Option.getOrElse(() => Number.NaN),
    );
  const invalidToken = (pos: number) =>
    Result.fail<MediaTypeError>({ kind: "invalidToken", pos, byte: at(pos) });
  const n = text.length;
  let i = 0;
  // The type, up to its slash.
  for (; ; i++) {
    if (i === n) return Result.fail({ kind: "missingSlash" });
    const c = at(i);
    if (c === 0x2f && i > 0) break;
    if (!isToken(c)) return invalidToken(i);
  }
  let start = i + 1;
  // The subtype, up to a semicolon.
  for (i = start; ; i++) {
    if (i === n) return Result.succeed(pipe(text, Str.toLowerCase));
    const c = at(i);
    if ((c === 0x2b || c === 0x3b) && i > start) {
      if (c === 0x3b) break;
      continue;
    }
    if (!isToken(c)) return invalidToken(i);
  }
  const semicolon = i;
  start = i + 1;
  i = start;
  const params: Array<{ name: [number, number]; value: [number, number] }> = [];
  params: while (start < n) {
    let name: [number, number];
    for (; ; i++) {
      if (i === n) return Result.fail({ kind: "missingEqual" });
      const c = at(i);
      if (c === 0x20 && i === start) {
        start = i + 1;
        i = start;
        continue params;
      }
      if (isToken(c)) continue;
      if (c === 0x3d && i > start) {
        name = [start, i];
        start = i + 1;
        i++;
        break;
      }
      return invalidToken(i);
    }
    let value: [number, number];
    let quoted = false;
    for (; ; i++) {
      if (quoted) {
        if (i === n) return Result.fail({ kind: "missingQuote" });
        const c = at(i);
        if (c === 0x22 && i > start) {
          value = [start, i];
          i++;
          break;
        }
        if (!isQuotedChar(c)) return invalidToken(i);
      } else {
        if (i === n) {
          value = [start, n];
          start = n;
          break;
        }
        const c = at(i);
        if (c === 0x22 && i === start) {
          quoted = true;
          start = i + 1;
          continue;
        }
        if (isToken(c)) continue;
        if (c === 0x3b && i > start) {
          value = [start, i];
          start = i + 1;
          i++;
          break;
        }
        return invalidToken(i);
      }
    }
    if (quoted) {
      for (; ; i++) {
        if (i === n) {
          start = n;
          break;
        }
        const c = at(i);
        if (c === 0x3b) {
          start = i + 1;
          i++;
          break;
        }
        if (c !== 0x20) return invalidToken(i);
      }
    }
    params.push({ name, value });
  }
  if (params.length === 0)
    return Result.succeed(pipe(text, Str.slice(0, semicolon), Str.toLowerCase));
  // `lower_ascii_with_params` (`src/parse.rs:307-321`).
  const chars = Array.from(text);
  const lower = (from: number, to: number) => {
    for (let k = from; k < to; k++) chars[k] = pipe(chars[k]!, Str.toLowerCase);
  };
  lower(0, semicolon);
  for (const { name, value } of params) {
    lower(name[0], name[1]);
    if (
      pipe(text, Str.slice(name[0], name[1]), Str.toLowerCase) === "charset"
    ) {
      lower(value[0], value[1]);
    }
  }
  return Result.succeed(Arr.join(chars, ""));
};

/**
 * A content type that names no media type, refused on an action's store path
 * (`InvalidContentTypeHeader`, `run_storage_store`,
 * `crates/isolate/src/environment/action/storage.rs:55-60`).
 */
export class InvalidContentType extends Schema.TaggedError<
  InvalidContentType,
  { readonly brand: unique symbol }
>()("InvalidContentType", {
  code: Schema.Literal("InvalidContentTypeHeader"),
  message: Schema.String,
}) {}

/**
 * A file's content type: none for an empty one, as the binary filters it, and
 * otherwise the media type as `mime` parses and prints it, refused when it
 * parses as none. A mutation's store refuses it as an argument
 * (`storage_store`,
 * `crates/isolate/src/environment/udf/async_syscall.rs:1272-1276`), an action's
 * as its content type header.
 */
export const contentType = (
  path: "mutation" | "action",
  type: unknown,
): Result.Result<
  string | null,
  InvalidStorageArgument | InvalidContentType
> => {
  if (type === undefined || type === null || type === "") {
    return Result.succeed(null);
  }
  if (typeof type !== "string") {
    return Result.fail(
      invalid(
        "storage.store",
        "contentType",
        `expected a string, got ${typeof type}`,
      ),
    );
  }
  const parsed = parseMediaType(type);
  if (Result.isSuccess(parsed)) return Result.succeed(parsed.success);
  const message = mediaTypeMessage(parsed.failure);
  return Result.fail(
    path === "mutation"
      ? invalid("storage.store", "contentType", message)
      : InvalidContentType.make({ code: "InvalidContentTypeHeader", message }),
  );
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
  `00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`;

/**
 * The count `uuid` minted `value` from, or `undefined` for a UUID it never
 * mints.
 */
export const uuidCounter = (value: string): number | undefined => {
  const match = /^00000000-0000-4000-8000-([0-9a-f]{12})$/.exec(value);
  const n = match === null ? Number.NaN : Number.parseInt(match[1]!, 16);
  return Number.isSafeInteger(n) && n >= 1 && uuid(n) === value ? n : undefined;
};

/**
 * Which binary-only storage endpoint a URL on the kernel's origin names, if
 * any: the upload endpoint, or a file download.
 */
export const endpoint = (
  url: string,
): "storageUpload" | "storageDownload" | undefined => {
  if (!pipe(url, Str.startsWith(`${origin}/`))) return undefined;
  const { pathname } = new URL(url);
  if (pathname === "/api/storage/upload") return "storageUpload";
  return pipe(pathname, Str.startsWith("/api/storage/"))
    ? "storageDownload"
    : undefined;
};
