import * as Clock from "./Clock.js";
import type { DocumentId, StoredDocument } from "./KernelValues.js";
import { resolveCommittedValues, tableNameFromId } from "./KernelValues.js";
import * as ReadSet from "./ReadSet.js";

/**
 * The number of commits the kernel has published. The empty world is 0.
 */
export type Version = number;

/**
 * A committed document and the version that wrote it.
 */
export interface Row {
  readonly doc: StoredDocument;
  readonly version: Version;
}

/**
 * Committed rows, keyed by component path, then table name, then document ID. A
 * published state is never changed. A commit makes a new one.
 */
export type Tables = ReadonlyMap<
  string,
  ReadonlyMap<string, ReadonlyMap<DocumentId, Row>>
>;

/**
 * One document's final value in a commit. `null` deletes it.
 */
export interface Write {
  readonly componentPath: string;
  readonly id: DocumentId;
  readonly doc: StoredDocument | null;
}

/**
 * One document a commit changed: its value before and after. `null` is absent.
 */
export interface Change {
  readonly componentPath: string;
  readonly id: DocumentId;
  readonly before: StoredDocument | null;
  readonly after: StoredDocument | null;
}

export interface Commit {
  readonly version: Version;
  readonly commitTs: bigint;
  readonly changes: ReadonlyArray<Change>;
}

/**
 * The kernel's committed state: rows, the latest version and commit timestamp,
 * and the write log, oldest first.
 */
export interface State {
  readonly tables: Tables;
  readonly version: Version;
  readonly commitTs: bigint;
  readonly log: ReadonlyArray<Commit>;
}

export const empty: State = {
  tables: new Map(),
  version: 0,
  commitTs: 0n,
  log: [],
};

/**
 * The committed row for `id` in `componentPath`, if any.
 */
export const get = (
  state: State,
  componentPath: string,
  id: DocumentId,
): Row | undefined => {
  const tableName = tableNameFromId(id);
  return tableName === null
    ? undefined
    : state.tables.get(componentPath)?.get(tableName)?.get(id);
};

/**
 * Every committed row of one table in one component.
 */
export const rows = (
  state: State,
  componentPath: string,
  tableName: string,
): Iterable<Row> =>
  state.tables.get(componentPath)?.get(tableName)?.values() ?? [];

/**
 * Publish one attempt's writes as a single commit at `commitTs`. Every
 * component's writes land in the same version, so a reader sees all of them or
 * none. A commit with no writes publishes nothing and leaves the state as it
 * was.
 */
export const apply = (
  state: State,
  writes: ReadonlyArray<Write>,
  commitTs: bigint,
): State => {
  if (writes.length === 0) return state;
  const version = state.version + 1;
  const tables = new Map(
    Array.from(state.tables, ([path, byTable]) => [path, new Map(byTable)]),
  );
  const changes = writes.map(({ componentPath, id, doc }): Change => ({
    componentPath,
    id,
    before: get(state, componentPath, id)?.doc ?? null,
    after: doc === null ? null : resolveCommittedValues(doc, commitTs),
  }));
  const touched = new Set<string>();
  for (const { componentPath, id, after } of changes) {
    const tableName = tableNameFromId(id)!;
    const byTable = tables.get(componentPath) ?? new Map();
    tables.set(componentPath, byTable);
    const key = `${componentPath}\u0000${tableName}`;
    const table = touched.has(key)
      ? byTable.get(tableName)!
      : new Map(byTable.get(tableName) ?? []);
    touched.add(key);
    byTable.set(tableName, table);
    if (after === null) table.delete(id);
    else table.set(id, { doc: after, version });
  }
  return {
    tables,
    version,
    commitTs,
    log: [...state.log, { version, commitTs, changes }],
  };
};

/**
 * The first change published after version `snapshot` that invalidates one of
 * `reads`, if any.
 */
export const conflict = (
  state: State,
  snapshot: Version,
  reads: ReadonlyArray<ReadSet.Read>,
): Change | undefined => {
  for (const commit of state.log.slice(snapshot)) {
    for (const change of commit.changes) {
      if (reads.some((read) => ReadSet.covers(read, change))) return change;
    }
  }
  return undefined;
};

/**
 * What the driver supplies. The kernel holds no clock of its own.
 */
export interface KernelRuntime {
  /**
   * The time in milliseconds, for each inserted document's creation time.
   */
  readonly now: () => number;
  /**
   * The commit timestamp of `version`. Strictly increasing with it.
   */
  readonly commitTs: (version: Version) => bigint;
}

/**
 * The wall clock, as convex-test reads it. A version's commit timestamp is the
 * time in nanoseconds when it is first asked for, bumped past the previous
 * one's when the clock stands still.
 */
export const wallClock = (): KernelRuntime => {
  const stamps = new Map<Version, bigint>();
  let latest = 0n;
  const now = Clock.hostNow;
  return {
    now,
    commitTs: (version) => {
      const known = stamps.get(version);
      if (known !== undefined) return known;
      const nanos = BigInt(now()) * 1_000_000n;
      latest = nanos > latest ? nanos : latest + 1n;
      stamps.set(version, latest);
      return latest;
    },
  };
};
