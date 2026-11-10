import type { Value } from "convex/values";
import type * as Kernel from "./Kernel.js";
import type {
  DocumentId,
  FunctionPath,
  StoredDocument,
} from "./KernelValues.js";

/**
 * Convex's system table of scheduled functions. Each component has its own.
 */
export const table = "_scheduled_functions";

export type JobState =
  | { readonly kind: "pending" }
  | { readonly kind: "inProgress" }
  | { readonly kind: "success" }
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "canceled" };

/**
 * What the kernel keeps beside a job's row: the function it calls, which a
 * handle may place in another component, and whether a standing source owns the
 * job. The row holds only what Convex's system table holds.
 */
export interface Target {
  readonly functionPath: FunctionPath;
  readonly standing: boolean;
}

/**
 * A pending job as a driver sees it.
 */
export interface Job {
  readonly id: DocumentId;
  readonly componentPath: string;
  readonly name: string;
  readonly scheduledTime: number;
  /**
   * A standing job is never drain work. Time reaches it through `advance`.
   */
  readonly standing: boolean;
}

/**
 * A pending job with what running it needs.
 */
export interface Due extends Job {
  readonly target: FunctionPath;
  readonly args: Value;
}

export const row = (
  id: DocumentId,
  creationTime: number,
  name: string,
  args: Value,
  scheduledTime: number,
): StoredDocument => ({
  _id: id,
  _creationTime: creationTime,
  name,
  args: [args],
  scheduledTime,
  state: { kind: "pending" },
});

export const stateOf = (doc: StoredDocument): JobState =>
  doc["state"] as JobState;

const byDeadline = (a: Due, b: Due) =>
  a.scheduledTime - b.scheduledTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Every committed pending job of every component, earliest deadline first. Jobs
 * that share a deadline run in the order they were scheduled.
 */
export const pending = (
  state: Kernel.State,
  targets: ReadonlyMap<DocumentId, Target>,
): Array<Due> => {
  const due: Array<Due> = [];
  for (const [componentPath, tables] of state.tables) {
    for (const { doc } of tables.get(table)?.values() ?? []) {
      if (stateOf(doc).kind !== "pending") continue;
      const name = doc["name"] as string;
      const target = targets.get(doc._id) ?? {
        functionPath: { componentPath, udfPath: name },
        standing: false,
      };
      due.push({
        id: doc._id,
        componentPath,
        name,
        scheduledTime: doc["scheduledTime"] as number,
        standing: target.standing,
        target: target.functionPath,
        args: (doc["args"] as ReadonlyArray<Value>)[0]!,
      });
    }
  }
  return due.sort(byDeadline);
};

/**
 * The distinct functions of `jobs`, for a refusal that names what is left.
 */
export const functions = (
  jobs: ReadonlyArray<Job>,
): Array<{ readonly componentPath: string; readonly name: string }> => {
  const seen = new Map<string, { componentPath: string; name: string }>();
  for (const { componentPath, name } of jobs) {
    seen.set(`${componentPath}\u0000${name}`, { componentPath, name });
  }
  return [...seen.values()];
};
