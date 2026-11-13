/**
 * The sync probe's binding and record. A probe runs only against a binary this
 * process started through `LocalBackend`: it finds the process that owns the
 * backend's port, checks this process is its ancestor, and binds the record to
 * that process, its executable's checksum, the ports, the worktree and its
 * revision. It takes ports, never a URL, so a record cannot describe a backend
 * someone else started.
 */
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The binding runs git once, before any Effect runtime matters.
import { execFileSync, spawn } from "node:child_process";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The binding hashes files synchronously.
import { createHash } from "node:crypto";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The binding reads `/proc` and source files synchronously.
import * as Fs from "node:fs";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Paths of the files the record digests.
import * as Path from "node:path";
import type { JSONValue } from "convex/values";
import * as Schema from "effect/Schema";

/**
 * The probe cannot bind its record to a binary this run started.
 */
export class ProbeBindingError extends Schema.TaggedError<ProbeBindingError>()(
  "ProbeBindingError",
  { message: Schema.String },
) {}

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
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Set<string>();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    if (!Fs.existsSync(table)) continue;
    for (const line of Fs.readFileSync(table, "utf8").split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      // `0A` is LISTEN.
      if (fields[1]?.endsWith(`:${hex}`) && fields[3] === "0A") {
        inodes.add(fields[9]!);
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
  throw new ProbeBindingError({
    message: `No process of this user listens on port ${port}.`,
  });
};

const parent = (pid: number): number => {
  const stat = Fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  // The command name may hold spaces and parentheses, so read after the last.
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
};

const descends = (pid: number, from: number): boolean => {
  for (let at = pid; at > 1; at = parent(at)) {
    if (at === from) return true;
  }
  return false;
};

const git = (worktree: string, ...args: ReadonlyArray<string>) =>
  execFileSync("git", args, { cwd: worktree, encoding: "utf8" }).trim();

/**
 * Bind a probe to the binary listening on `ports`. It refuses unless this
 * process started that binary.
 */
export const bind = (ports: Binding["ports"]): Binding => {
  if (process.platform !== "linux") {
    throw new ProbeBindingError({
      message:
        "The sync probe binds its record through /proc, so it runs on Linux.",
    });
  }
  const pid = owner(ports.cloud);
  if (!descends(pid, process.pid)) {
    throw new ProbeBindingError({
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
  Object.fromEntries(
    [
      "tools/local-backend/fixtures/sync/convex/schema.ts",
      "tools/local-backend/fixtures/sync/convex/sync.ts",
      "packages/test/test/fixtures/syncLegs.ts",
      "packages/test/src/internal/Sync.ts",
      "packages/test/src/internal/Subscriptions.ts",
    ].map((file) => [file, sha256(Fs.readFileSync(Path.join(worktree, file)))]),
  );

/**
 * How many times `sync:increment` lost a conflict on the binary since `since`:
 * the function log's executions of it that carry OCC information, read with
 * `convex logs` from the fixture project, whose CLI holds its own credentials.
 */
export const contention = (directory: string, since: number) =>
  // oxlint-disable-next-line effecttsgo/new-promise -- `convex logs` tails until it is killed, so the count settles from its output stream and a host timer.
  new Promise<number>((resolve, reject) => {
    const child = spawn(
      "pnpm",
      ["convex", "logs", "--history", "2000", "--jsonl"],
      {
        cwd: directory,
        env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    let output = "";
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      clearTimeout(limit);
      clearTimeout(quiet);
      child.kill();
      const retried = output
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map(
          (line) =>
            JSON.parse(line) as {
              readonly identifier?: string;
              readonly timestamp?: number;
              readonly occInfo?: unknown;
            },
        )
        .filter(
          (entry) =>
            entry.identifier === "sync:increment" &&
            entry.occInfo !== null &&
            entry.occInfo !== undefined &&
            (entry.timestamp ?? 0) * 1000 >= since,
        );
      resolve(retried.length);
    };
    // The first poll prints the history at once; the command then tails, so
    // it ends when output has been quiet for a while.
    // oxlint-disable-next-line effecttsgo/global-timers -- See above.
    const limit = setTimeout(finish, 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      clearTimeout(quiet);
      // oxlint-disable-next-line effecttsgo/global-timers -- See above.
      quiet = setTimeout(finish, 3_000);
    });
    child.on("error", reject);
  });

export type Verdict = "agree" | "disagree";

/**
 * One leg's record. A disagreement carries both targets' normalised
 * observations.
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
}

/**
 * Write `record` under the suite's ignored `.sync-probe` directory, after
 * `redact` marks every secret in it, and answer what was written.
 */
export const write = (
  record: ProbeRecord,
  redact: (json: JSONValue) => JSONValue,
): JSONValue => {
  const marked = redact(record as unknown as JSONValue);
  const directory = Path.join(import.meta.dirname, ".sync-probe");
  Fs.mkdirSync(directory, { recursive: true });
  Fs.writeFileSync(
    Path.join(directory, `${record.leg}.json`),
    `${JSON.stringify(marked, null, 2)}\n`,
  );
  return marked;
};
