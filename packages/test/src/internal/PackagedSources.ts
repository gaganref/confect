// oxlint-disable-next-line effecttsgo/node-builtin-import -- A synchronous hash of bytes already read, matching the digest codegen records; Effect's Crypto is a service.
import { createHash } from "node:crypto";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import type { ComponentRuntimes } from "./Execution.js";

/**
 * A packaged component's installed files changed since codegen read them: the
 * package is gone, its version differs, or a file's bytes differ or cannot be
 * read. The session does not open, as the kernel would read other `"use node"`
 * directives than the ones codegen checked.
 */
export class PackagedComponentChanged extends Schema.TaggedError<
  PackagedComponentChanged,
  { readonly brand: unique symbol }
>()("PackagedComponentChanged", {
  mount: Schema.String,
  package: Schema.String,
  file: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `The mount "${this.mount}" reads ${this.package}'s ${this.file}, which changed since codegen read it: ${this.reason}. Run confect codegen again.`;
  }
}

/**
 * One `convex.config` import codegen followed, and what the generated reader
 * found for it: the package directory and version Node's `node_modules` lookup
 * finds from `from`, and the definition's bytes.
 */
export interface StepRead {
  readonly package?: string;
  readonly version?: string;
  readonly file: string;
  readonly digest: string;
  readonly from: string;
  readonly found?: string;
  readonly installed?: string;
  readonly bytes?: Uint8Array;
  readonly failure?: string;
}

/**
 * One module codegen read, beside the definition, and its bytes as read now.
 */
export interface FileRead {
  readonly file: string;
  readonly digest: string;
  readonly bytes?: Uint8Array;
  readonly failure?: string;
}

/**
 * What the generated reader returns for one packaged mount: the entries codegen
 * recorded, each with what it read. The reader checks nothing.
 */
export interface PackageRead {
  readonly steps: ReadonlyArray<StepRead>;
  readonly files: ReadonlyArray<FileRead>;
}

/**
 * Each packaged mount's reader, by component path, as generated `testing.ts`
 * writes them.
 */
export type PackagedSources = Readonly<
  Record<string, () => Promise<PackageRead>>
>;

const digestOf = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const decoder = new TextDecoder();

const join = (directory: string, file: string) =>
  directory === "." ? file : `${directory}/${file}`;

const directoryOf = (file: string) =>
  Option.match(Str.lastIndexOf("/")(file), {
    onNone: () => ".",
    onSome: (at) => pipe(file, Str.slice(0, at)),
  });

/**
 * One mount's sources, from bytes that match codegen's digests.
 */
const validate = Effect.fnUntraced(function* (
  mount: string,
  read: () => Promise<PackageRead>,
) {
  let name = "";
  const changed = (file: string, reason: string) =>
    PackagedComponentChanged.make({ mount, package: name, file, reason });
  const found = yield* Effect.tryPromise({
    try: read,
    catch: (cause) => changed("", `reading it failed: ${String(cause)}`),
  });
  let directory = ".";
  for (const step of found.steps) {
    if (step.package !== undefined) {
      name = step.package;
      if (step.found === undefined)
        return yield* changed(
          "package.json",
          `Node's node_modules lookup finds no ${name} from ${step.from}`,
        );
      if (step.installed !== step.version)
        return yield* changed(
          "package.json",
          `version ${step.installed ?? "(none)"} is installed at ${step.found}, and codegen read ${step.version ?? "(none)"}`,
        );
    }
    if (step.bytes === undefined)
      return yield* changed(step.file, step.failure ?? "it cannot be read");
    if (digestOf(step.bytes) !== step.digest)
      return yield* changed(
        step.file,
        "its bytes differ from the ones codegen read",
      );
    directory = directoryOf(step.file);
  }
  const sources: Record<string, () => Promise<string>> = {
    "_generated/testing.ts": () => Promise.resolve(""),
  };
  for (const file of found.files) {
    const inPackage = join(directory, file.file);
    if (file.bytes === undefined)
      return yield* changed(inPackage, file.failure ?? "it cannot be read");
    if (digestOf(file.bytes) !== file.digest)
      return yield* changed(
        inPackage,
        "its bytes differ from the ones codegen read",
      );
    const text = decoder.decode(file.bytes);
    sources[file.file] = () => Promise.resolve(text);
  }
  return sources;
});

/**
 * Read every packaged mount's files again and check them against codegen's
 * digests, on each layer build, so a session never runs on files that changed
 * since codegen. A mount whose runtime the layer declares reads no sources, so
 * it is not read.
 */
export const validateAll = (
  packaged: PackagedSources | undefined,
  componentRuntimes: ComponentRuntimes | undefined,
): Effect.Effect<
  Readonly<Record<string, Record<string, () => Promise<string>>>> | undefined,
  PackagedComponentChanged
> =>
  packaged === undefined
    ? Effect.undefined
    : Effect.forEach(
        Arr.filter(
          Rec.toEntries(packaged),
          ([mount]) => componentRuntimes?.[mount] === undefined,
        ),
        ([mount, read]) =>
          Effect.map(
            validate(mount, read),
            (sources) => [mount, sources] as const,
          ),
      ).pipe(Effect.map(Rec.fromEntries));
