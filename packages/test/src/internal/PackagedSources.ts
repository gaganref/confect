// oxlint-disable-next-line effecttsgo/node-builtin-import -- A synchronous hash of bytes already read, matching the digest codegen records; Effect's Crypto is a service.
import { createHash } from "node:crypto";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
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
 * Why a packaged mount's layout is not the one the generated registry reads, as
 * codegen recorded it.
 */
export type UnsupportedLayout =
  | "outside-exports"
  | "no-exports"
  | "config-file"
  | "config-siblings"
  | "config-imports"
  | "inside-unsupported";

const layoutReasons: Readonly<Record<UnsupportedLayout, string>> = {
  "outside-exports":
    "its convex.config import does not resolve through a package's exports map",
  "no-exports": "the package has no exports map, or a null one",
  "config-file":
    "its exports map resolves the convex.config import to a file not named convex.config.js or convex.config.ts",
  "config-siblings":
    "a convex.config.js and a convex.config.ts sit side by side, and Convex deploys the .ts",
  "config-imports":
    "its convex.config imports something other than convex and other components' convex.config, which Convex's conditions may resolve to code that mounts other components",
  "inside-unsupported": "it is mounted below a mount whose layout is not read",
};

/**
 * A packaged mount whose layout is not the one the generated registry reads,
 * and which the test did not declare a runtime for in `componentRuntimes`, so
 * the kernel could not tell which of its actions Convex runs in Node.
 */
export class PackagedLayoutUnsupported extends Schema.TaggedError<
  PackagedLayoutUnsupported,
  { readonly brand: unique symbol }
>()("PackagedLayoutUnsupported", {
  mount: Schema.String,
  package: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `The mount "${this.mount}" installs ${this.package}, whose layout the generated test registry does not read: ${layoutReasons[this.reason as UnsupportedLayout] ?? this.reason}. Declare its runtime, componentRuntimes: { "${this.mount}": "isolate" } or "node", in TestBackend.layer or TestConfect.layer.`;
  }
}

/**
 * Why a layer with packaged mounts can refuse to build.
 */
export type PackagedRefusal =
  | PackagedComponentChanged
  | PackagedLayoutUnsupported;

/**
 * What codegen records for a packaged mount whose layout the registry does not
 * read, in place of its reader.
 */
export interface UnsupportedPackage {
  readonly mount: string;
  readonly package: string;
  readonly reason: UnsupportedLayout;
}

/**
 * One `convex.config` import codegen followed, and what the generated reader
 * found for it: the package directory and version Node's `node_modules` lookup
 * finds from `from`, its `package.json` bytes, and the definition's bytes.
 * `manifest` is the digest of the `package.json` codegen read, whose `exports`,
 * `imports`, `main` and `module` decide what a deploy resolves.
 */
export interface StepRead {
  readonly package?: string | undefined;
  readonly version?: string | undefined;
  readonly manifest?: string | undefined;
  readonly manifestBytes?: Uint8Array | undefined;
  /**
   * Whether a `convex.config` of the other extension now sits beside the
   * definition, which changes the file Convex deploys.
   */
  readonly sibling?: boolean | undefined;
  /**
   * Each file inside the package that the definition's imports reach, as
   * codegen read it, with its bytes as read now.
   */
  readonly helpers?: ReadonlyArray<FileRead> | undefined;
  readonly file: string;
  readonly digest: string;
  readonly from: string;
  readonly found?: string | undefined;
  readonly installed?: string | undefined;
  readonly bytes?: Uint8Array | undefined;
  readonly failure?: string | undefined;
}

/**
 * One module codegen read, beside the definition, and its bytes as read now.
 */
export interface FileRead {
  readonly file: string;
  readonly digest: string;
  readonly bytes?: Uint8Array | undefined;
  readonly failure?: string | undefined;
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
 * Each packaged mount's reader, or the record of a layout it does not read, by
 * component path, as generated `testing.ts` writes them.
 */
export type PackagedSources = Readonly<
  Record<string, (() => Promise<PackageRead>) | UnsupportedPackage>
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
      if (
        step.manifest !== undefined &&
        (step.manifestBytes === undefined ||
          digestOf(step.manifestBytes) !== step.manifest)
      )
        return yield* changed(
          "package.json",
          "its bytes differ from the ones codegen read, and they decide which files a deploy resolves",
        );
    }
    if (step.bytes === undefined)
      return yield* changed(step.file, step.failure ?? "it cannot be read");
    for (const helper of step.helpers ?? []) {
      if (helper.bytes === undefined)
        return yield* changed(
          helper.file,
          helper.failure ?? "it cannot be read",
        );
      if (digestOf(helper.bytes) !== helper.digest)
        return yield* changed(
          helper.file,
          "its bytes differ from the ones codegen read",
        );
    }
    if (step.sibling === true)
      return yield* changed(
        step.file,
        "a convex.config of the other extension now sits beside it, which Convex deploys instead",
      );
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
 * it is not read. A mount whose layout codegen recorded as unsupported refuses
 * unless the layer declares its runtime.
 */
export const validateAll = (
  packaged: PackagedSources | undefined,
  componentRuntimes: ComponentRuntimes | undefined,
): Effect.Effect<
  Readonly<Record<string, Record<string, () => Promise<string>>>> | undefined,
  PackagedRefusal
> =>
  packaged === undefined
    ? Effect.undefined
    : Effect.forEach(
        Arr.filter(
          Rec.toEntries(packaged),
          ([mount]) => componentRuntimes?.[mount] === undefined,
        ),
        ([mount, entry]): Effect.Effect<
          readonly [string, Record<string, () => Promise<string>>],
          PackagedRefusal
        > =>
          Predicate.isFunction(entry)
            ? Effect.map(
                validate(mount, entry),
                (sources) => [mount, sources] as const,
              )
            : Effect.fail(
                PackagedLayoutUnsupported.make({
                  mount,
                  package: entry.package,
                  reason: entry.reason,
                }),
              ),
      ).pipe(Effect.map(Rec.fromEntries));
