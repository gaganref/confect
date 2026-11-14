/**
 * The sync probe's binding and record. A probe runs only against a binary this
 * process started through `LocalBackend`: it finds the process that owns the
 * backend's port, checks this process is its ancestor, and binds the record to
 * that process, its executable's checksum, the ports, the worktree and its
 * revision. It takes ports, never a URL, so a record cannot describe a backend
 * someone else started.
 *
 * A leg's record is written before the leg runs, as `incomplete`, so a record
 * an earlier run left never stands for this one. Each side of a leg runs to a
 * deadline. A side that fails or passes its deadline leaves the record
 * `incomplete`, with what each side had observed by then.
 */
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The binding runs git synchronously, as it reads `/proc`, before the leg starts.
import { execFileSync } from "node:child_process";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The binding hashes files synchronously.
import { createHash } from "node:crypto";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The binding reads `/proc` and source files synchronously.
import * as Fs from "node:fs";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Paths of the files the record digests.
import * as Path from "node:path";
import type { JSONValue } from "convex/values";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Json from "../../../test/src/internal/Json";

/**
 * Two observations' canonical JSON, compared as text. The comparison is a
 * synchronous predicate, so it goes through the kernel's JSON helper.
 */
export const canonicalEqual = (a: unknown, b: unknown) =>
  Json.stringify(canonical(a)) === Json.stringify(canonical(b));

/**
 * The probe cannot bind its record to a binary this run started.
 */
export class ProbeBindingError extends Schema.TaggedError<
  ProbeBindingError,
  { readonly brand: unique symbol }
>()("ProbeBindingError", { message: Schema.String }) {}

/**
 * A side of a leg did not finish by its deadline.
 */
export class ProbeDeadline extends Schema.TaggedError<
  ProbeDeadline,
  { readonly brand: unique symbol }
>()("ProbeDeadline", {
  side: Schema.Literals(["binary", "kernel"]),
  deadline: Schema.Int,
  message: Schema.String,
}) {}

export interface Binding {
  readonly worktree: string;
  readonly revision: string;
  /**
   * Whether the worktree had changes `revision` does not hold.
   */
  readonly dirty: boolean;
  readonly binary: {
    /**
     * The precompiled release directory the executable sits in.
     */
    readonly version: string;
    readonly sha256: string;
  };
  readonly ports: { readonly cloud: number; readonly site: number };
  /**
   * The process that owns the cloud port.
   */
  readonly pid: number;
}

const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * The inodes of sockets listening on `port`, from `/proc/net/tcp` and `tcp6`.
 */
const listening = (port: number): ReadonlySet<string> => {
  const hex = Str.padStart(4, "0")(Str.toUpperCase(port.toString(16)));
  const inodes = new Set<string>();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    if (!Fs.existsSync(table)) continue;
    const rows = Arr.drop(Str.split(Fs.readFileSync(table, "utf8"), "\n"), 1);
    for (const row of rows) {
      const fields = Str.split(Str.trim(row), /\s+/);
      // `0A` is LISTEN.
      if (
        Str.endsWith(`:${hex}`)(fields[1] ?? "") &&
        fields[3] === "0A" &&
        fields[9] !== undefined
      ) {
        inodes.add(fields[9]);
      }
    }
  }
  return inodes;
};

const owner = (port: number): number => {
  const inodes = listening(port);
  for (const entry of Fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let fds: ReadonlyArray<string>;
    try {
      fds = Fs.readdirSync(`/proc/${entry}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let link: string;
      try {
        link = Fs.readlinkSync(`/proc/${entry}/fd/${fd}`);
      } catch {
        continue;
      }
      const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1];
      if (inode !== undefined && inodes.has(inode)) return Number(entry);
    }
  }
  throw ProbeBindingError.make({
    message: `No process of this user listens on port ${port}.`,
  });
};

const parent = (pid: number): number => {
  const stat = Fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  // The command name may hold spaces and parentheses, so read after the last.
  const after = Option.getOrElse(Str.lastIndexOf(")")(stat), () => -1);
  return Number(Str.split(Str.slice(after + 2)(stat), " ")[1]);
};

const descends = (pid: number, from: number): boolean => {
  for (let at = pid; at > 1; at = parent(at)) {
    if (at === from) return true;
  }
  return false;
};

const git = (worktree: string, ...args: ReadonlyArray<string>) =>
  Str.trim(execFileSync("git", args, { cwd: worktree, encoding: "utf8" }));

/**
 * Whether this platform can bind a record: the binding reads `/proc`.
 */
export const supported = process.platform === "linux";

/**
 * Bind a probe to the binary listening on `ports`. It refuses unless this
 * process started that binary.
 */
export const bind = (ports: Binding["ports"]): Binding => {
  if (!supported) {
    throw ProbeBindingError.make({
      message:
        "The sync probe binds its record through /proc, so it runs on Linux.",
    });
  }
  const pid = owner(ports.cloud);
  if (!descends(pid, process.pid)) {
    throw ProbeBindingError.make({
      message: `Process ${pid} owns port ${ports.cloud}, but this run did not start it. The probe runs only against a binary its runner started.`,
    });
  }
  const executable = Fs.readlinkSync(`/proc/${pid}/exe`);
  const worktree = git(import.meta.dirname, "rev-parse", "--show-toplevel");
  return {
    worktree,
    revision: git(worktree, "rev-parse", "HEAD"),
    dirty: git(worktree, "status", "--porcelain").length > 0,
    binary: {
      version: Path.basename(Path.dirname(executable)),
      sha256: sha256(Fs.readFileSync(executable)),
    },
    ports,
    pid,
  };
};

/**
 * The files whose behaviour a probe compares, by path from the worktree, each
 * with its SHA-256: the app both targets run, the legs and the kernel's sync
 * and subscription code.
 */
export const sources = (worktree: string): Record<string, string> =>
  Rec.fromEntries(
    Arr.map(
      [
        "tools/local-backend/fixtures/sync/convex/schema.ts",
        "tools/local-backend/fixtures/sync/convex/sync.ts",
        "packages/test/test/fixtures/syncLegs.ts",
        "packages/test/src/internal/Sync.ts",
        "packages/test/src/internal/Subscriptions.ts",
      ],
      (file) => [file, sha256(Fs.readFileSync(Path.join(worktree, file)))],
    ),
  );

/**
 * How many times `sync:increment` lost a conflict on the binary since `since`:
 * the function log's executions of it that carry OCC information, read with
 * `convex logs` from the fixture project, whose CLI holds its own credentials.
 * The command prints the history at once and then tails, so its output is read
 * for a few seconds and the process ends with the scope.
 */
export const contention = (directory: string, since: number) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(
        "pnpm",
        ["convex", "logs", "--history", "2000", "--jsonl"],
        {
          cwd: directory,
          extendEnv: true,
          env: { CONVEX_AGENT_MODE: "anonymous" },
        },
      ),
    );
    const lines = yield* handle.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter(Str.startsWith("{")),
      Stream.interruptWhen(Effect.sleep(Duration.seconds(8))),
      Stream.runCollect,
    );
    const entries = yield* Effect.forEach(lines, (line) =>
      Schema.decodeEffect(Schema.fromJsonString(LogEntry))(line).pipe(
        Effect.orDie,
      ),
    );
    return Arr.filter(
      entries,
      (entry) =>
        entry.identifier === "sync:increment" &&
        entry.occInfo !== null &&
        entry.occInfo !== undefined &&
        (entry.timestamp ?? 0) * 1000 >= since,
    ).length;
  }).pipe(Effect.scoped);

/**
 * The fields of a function log entry the contention count reads.
 */
const LogEntry = Schema.Struct({
  identifier: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.Finite),
  occInfo: Schema.optional(Schema.Unknown),
});

/**
 * `agree` and `disagree` compare two finished sides. `incomplete` is a leg that
 * has not finished, or one whose side failed or passed its deadline.
 */
export type Verdict = "agree" | "disagree" | "incomplete";

/**
 * One leg's record. Every record carries both targets' normalised observations,
 * partial when the leg is incomplete, and names the side that stopped it.
 */
export interface ProbeRecord {
  readonly leg: string;
  readonly verdict: Verdict;
  readonly binding: Binding;
  readonly sources: Record<string, string>;
  readonly observations: {
    readonly kernel: JSONValue;
    readonly binary: JSONValue;
  };
  readonly failure: {
    readonly side: "binary" | "kernel" | "none";
    readonly message: string;
  } | null;
}

/**
 * Where records go: the suite's ignored `.sync-probe` directory.
 */
export const records = Path.join(import.meta.dirname, ".sync-probe");

/**
 * Write `record` as `<leg>.json` under `directory`, after `redact` marks every
 * secret in it, and answer what was written.
 */
export const write = (
  record: ProbeRecord,
  redact: (json: JSONValue) => JSONValue,
  directory: string = records,
): Effect.Effect<JSONValue> =>
  Effect.gen(function* () {
    const marked = redact(record as unknown as JSONValue);
    const text = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.Unknown),
    )(marked).pipe(Effect.orDie);
    yield* Effect.sync(() => {
      Fs.mkdirSync(directory, { recursive: true });
      Fs.writeFileSync(Path.join(directory, `${record.leg}.json`), `${text}\n`);
    });
    return marked;
  });

/**
 * What a side has observed so far, which the leg rewrites after each step.
 */
export interface Progress {
  observed: unknown;
}

/**
 * `json` with every object's keys in order, for comparing observations.
 */
export const canonical = (json: unknown): unknown =>
  Arr.isArray(json)
    ? Arr.map(json, canonical)
    : json !== null && typeof json === "object"
      ? Rec.fromEntries(
          Arr.map(Arr.sort(Rec.keys(json), Str.Order), (key) => [
            key,
            canonical((json as Record<string, unknown>)[key]),
          ]),
        )
      : json;

/**
 * Run one leg on the binary, then on the kernel, each to `deadline`, and write
 * its record. The record is first written `incomplete`, so a run that never
 * finishes leaves no earlier verdict standing. A side that throws or passes its
 * deadline stops the leg and leaves the record `incomplete` with both sides'
 * partial observations. Two finished sides agree when their canonical
 * observations are equal and each `holds`.
 */
export const runLeg = (options: {
  readonly leg: string;
  readonly binding: Binding;
  readonly sources: Record<string, string>;
  readonly deadline: Duration.Duration;
  readonly binary: (progress: Progress) => Effect.Effect<unknown>;
  readonly kernel: (progress: Progress) => Effect.Effect<unknown>;
  readonly holds: (observed: unknown) => boolean;
  readonly redact: (json: JSONValue) => JSONValue;
  readonly directory?: string;
}): Effect.Effect<ProbeRecord> =>
  Effect.gen(function* () {
    const progress = {
      binary: { observed: null } as Progress,
      kernel: { observed: null } as Progress,
    };
    const record = (
      verdict: Verdict,
      observations: ProbeRecord["observations"],
      failure: ProbeRecord["failure"],
    ) =>
      write(
        {
          leg: options.leg,
          verdict,
          binding: options.binding,
          sources: options.sources,
          observations,
          failure,
        },
        options.redact,
        options.directory,
      ).pipe(Effect.map((marked) => marked as unknown as ProbeRecord));
    const partial = () => ({
      kernel: progress.kernel.observed as JSONValue,
      binary: progress.binary.observed as JSONValue,
    });
    yield* record("incomplete", partial(), {
      side: "none",
      message: "The leg has not finished.",
    });
    let running: "binary" | "kernel" = "binary";
    const side = (name: "binary" | "kernel") =>
      Effect.suspend(() => {
        running = name;
        return options[name](progress[name]).pipe(
          Effect.timeoutOrElse({
            duration: options.deadline,
            orElse: () =>
              Effect.fail(
                ProbeDeadline.make({
                  side: name,
                  deadline: Duration.toMillis(options.deadline),
                  message: `The ${name} side did not finish within ${Duration.toMillis(options.deadline)} ms.`,
                }),
              ),
          }),
        );
      });
    const finished = yield* Effect.exit(
      Effect.all({ binary: side("binary"), kernel: side("kernel") }),
    );
    if (Exit.isFailure(finished)) {
      const error = Cause.squash(finished.cause);
      return yield* record("incomplete", partial(), {
        side: running,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const { binary, kernel } = finished.value;
    const agree =
      canonicalEqual(kernel, binary) &&
      options.holds(kernel) &&
      options.holds(binary);
    return yield* record(
      agree ? "agree" : "disagree",
      { kernel: kernel as JSONValue, binary: binary as JSONValue },
      null,
    );
  });
