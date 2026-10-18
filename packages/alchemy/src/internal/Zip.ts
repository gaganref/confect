import { inflateRaw } from "node:zlib";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export class ZipError extends Schema.TaggedError<ZipError>()("ZipError", {
  reason: Schema.Literals(["format", "entry", "io"]),
}) {}

interface Entry {
  readonly method: number;
  readonly start: number;
  readonly end: number;
}

const format = () => Result.fail(new ZipError({ reason: "format" }));

/**
 * Locate one entry's compressed bytes through the archive's central directory.
 * No Zip64: a single-file release far under 4 GiB never needs it.
 */
const locate = (
  archive: Uint8Array,
  name: string,
): Result.Result<Entry, ZipError> => {
  const bytes = Buffer.from(archive.buffer, archive.byteOffset, archive.length);
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > bytes.length) return format();
  const directoryEnd =
    bytes.readUInt32LE(end + 16) + bytes.readUInt32LE(end + 12);
  if (directoryEnd > bytes.length) return format();
  for (
    let offset = bytes.readUInt32LE(end + 16);
    offset + 46 <= directoryEnd;
  ) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) return format();
    const nameLength = bytes.readUInt16LE(offset + 28);
    const entryName = bytes.toString(
      "utf8",
      offset + 46,
      offset + 46 + nameLength,
    );
    if (entryName === name) {
      const size = bytes.readUInt32LE(offset + 20);
      const header = bytes.readUInt32LE(offset + 42);
      if (
        header + 30 > bytes.length ||
        bytes.readUInt32LE(header) !== 0x04034b50
      )
        return format();
      const start =
        header +
        30 +
        bytes.readUInt16LE(header + 26) +
        bytes.readUInt16LE(header + 28);
      if (start + size > bytes.length) return format();
      return Result.succeed({
        method: bytes.readUInt16LE(offset + 10),
        start,
        end: start + size,
      });
    }
    offset +=
      46 +
      nameLength +
      bytes.readUInt16LE(offset + 30) +
      bytes.readUInt16LE(offset + 32);
  }
  return Result.fail(new ZipError({ reason: "entry" }));
};

const inflate = (data: Uint8Array) =>
  Effect.callback<Uint8Array, ZipError>((resume) => {
    inflateRaw(data, (error, output) =>
      resume(
        error
          ? Effect.fail(new ZipError({ reason: "format" }))
          : Effect.succeed(output),
      ),
    );
  });

/**
 * Extract one entry of a zip archive. Convex publishes the local backend as a
 * single-file zip, stored or deflated.
 */
export const extract = Effect.fn("Zip.extract")(function* (
  archive: string,
  name: string,
  destination: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const bytes = yield* fs
    .readFile(archive)
    .pipe(Effect.mapError(() => new ZipError({ reason: "io" })));
  const entry = yield* Effect.fromResult(locate(bytes, name));
  const data = bytes.subarray(entry.start, entry.end);
  const content =
    entry.method === 8
      ? yield* inflate(data)
      : entry.method === 0
        ? data
        : yield* new ZipError({ reason: "format" });
  yield* fs
    .writeFile(destination, content, { mode: 0o755 })
    .pipe(Effect.mapError(() => new ZipError({ reason: "io" })));
});
