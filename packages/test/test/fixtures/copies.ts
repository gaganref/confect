// oxlint-disable-next-line effecttsgo/node-builtin-import -- The copies run in a fresh plain Node process, as an install that holds two copies loads them.
import { spawnSync } from "node:child_process";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Each copy is the package's own files, written to a directory of its own.
import * as Fs from "node:fs";
import { createRequire } from "node:module";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The copies' paths are built before any Effect runs.
import * as Path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDirectory = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Two real copies of this package, each its own `package.json` and `src` in a
 * directory of its own, as a hoisted copy and a nested one sit in an install.
 * Both resolve their dependencies through one `node_modules`, this package's,
 * so they share one `effect`, `convex` and `@confect/server`, as such an
 * install does. Each run gets fresh copies of the current source.
 *
 * The copies sit below this package's own `node_modules`, in its `.cache`, and
 * no link of ours leads there: Node's ESM resolver walks up from each copy's
 * files and finds `packages/test/node_modules/convex` as it does for every test
 * file here, through the links pnpm made. A copy in the system temp directory
 * with a `node_modules` junction back to this package resolved on Linux, but on
 * Windows the ESM resolver did not find `convex` through it.
 */
export const twoCopies = (): {
  readonly directories: readonly [string, string];
  readonly remove: () => void;
} => {
  const cache = Path.join(packageDirectory, "node_modules", ".cache");
  Fs.mkdirSync(cache, { recursive: true });
  const root = Fs.mkdtempSync(Path.join(cache, "confect-test-copies-"));
  const copy = (name: string) => {
    const directory = Path.join(root, name, "node_modules", "@confect", "test");
    Fs.mkdirSync(directory, { recursive: true });
    Fs.copyFileSync(
      Path.join(packageDirectory, "package.json"),
      Path.join(directory, "package.json"),
    );
    Fs.cpSync(Path.join(packageDirectory, "src"), Path.join(directory, "src"), {
      recursive: true,
    });
    return directory;
  };
  return {
    directories: [copy("hoisted"), copy(Path.join("nested", "app"))],
    remove: () => Fs.rmSync(root, { recursive: true, force: true }),
  };
};

/**
 * Run `twoCopies.ts` over `directories` in a fresh Node process, and what it
 * printed. The process gets no `NODE_PATH`, which `pnpm` sets for its scripts,
 * so the copies resolve their dependencies only through `node_modules`, on
 * every platform alike.
 */
export const runTwoCopies = (directories: readonly [string, string]) => {
  const loader = pathToFileURL(
    createRequire(import.meta.url).resolve("tsx/esm"),
  ).href;
  const script = fileURLToPath(new URL("twoCopies.ts", import.meta.url));
  const { NODE_PATH: _nodePath, ...env } = process.env;
  return spawnSync(
    process.execPath,
    ["--import", loader, script, ...directories],
    { encoding: "utf8", env },
  );
};

type Settled<A> = { readonly value: A } | { readonly error: string };

type Surface = {
  readonly setImmediate: string;
  readonly queueMicrotask: string;
};

/**
 * What one copy's backend did in `twoCopies.ts`.
 */
export interface KernelReport {
  readonly surface: Settled<Surface>;
  readonly atLoad: Settled<Surface>;
  readonly timer: Settled<string>;
  readonly read: Settled<{
    readonly labels: ReadonlyArray<string>;
    readonly now: number;
  }>;
  readonly held: number;
  readonly charge: Settled<string>;
}

/**
 * What `twoCopies.ts` printed: each copy's backend, the `TestConfect` sessions'
 * isolate actions, and the host's own globals.
 */
export interface Report {
  readonly kernel: { readonly one: KernelReport; readonly two: KernelReport };
  readonly sessions: {
    readonly bothOpen: { readonly one: Surface; readonly two: Surface };
    readonly afterOneClosed: Surface;
    readonly afterTwoClosed: Surface;
  };
  readonly host: Surface;
}

let report: Report | undefined;

/**
 * One run of `twoCopies.ts` over fresh copies, removed once it ran, per test
 * file. It throws with the process's output if the run failed.
 */
export const twoCopiesReport = (): Report => {
  if (report !== undefined) return report;
  const copies = twoCopies();
  try {
    const run = runTwoCopies(copies.directories);
    if (run.status !== 0 || run.stderr !== "") {
      throw new Error(
        `twoCopies.ts exited ${String(run.status)}: ${run.stderr}${run.stdout}`,
      );
    }
    // oxlint-disable-next-line effecttsgo/global-json -- The child's one line of output, read synchronously.
    report = JSON.parse(run.stdout) as Report;
    return report;
  } finally {
    copies.remove();
  }
};
