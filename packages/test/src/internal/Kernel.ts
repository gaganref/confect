import type { DocumentId, StoredDocument } from "./KernelValues.js";
import { resolveCommittedValues, tableNameFromId } from "./KernelValues.js";

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

export interface Commit {
  readonly version: Version;
  readonly commitTs: bigint;
  readonly writes: ReadonlyArray<Write>;
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
 * Publish one attempt's writes as a single commit. Every component's writes
 * land in the same version, so a reader sees all of them or none.
 *
 * A commit with no writes publishes nothing and leaves the state as it was.
 * `now` is the wall clock in milliseconds. The commit timestamp is its
 * nanoseconds, bumped past the previous commit's when the clock stands still.
 */
export const apply = (
  state: State,
  writes: ReadonlyArray<Write>,
  now: number,
): State => {
  if (writes.length === 0) return state;
  const version = state.version + 1;
  const commitTs = nextCommitTs(state, now);
  const tables = new Map(
    Array.from(state.tables, ([path, byTable]) => [path, new Map(byTable)]),
  );
  const resolved = writes.map((write): Write =>
    write.doc === null
      ? write
      : { ...write, doc: resolveCommittedValues(write.doc, commitTs) },
  );
  const touched = new Set<string>();
  for (const { componentPath, id, doc } of resolved) {
    const tableName = tableNameFromId(id)!;
    const byTable = tables.get(componentPath) ?? new Map();
    tables.set(componentPath, byTable);
    const key = `${componentPath}\u0000${tableName}`;
    const table = touched.has(key)
      ? byTable.get(tableName)!
      : new Map(byTable.get(tableName) ?? []);
    touched.add(key);
    byTable.set(tableName, table);
    if (doc === null) table.delete(id);
    else table.set(id, { doc, version });
  }
  return {
    tables,
    version,
    commitTs,
    log: [...state.log, { version, commitTs, writes: resolved }],
  };
};

const nextCommitTs = (state: State, now: number): bigint => {
  const nowNanos = BigInt(now) * 1_000_000n;
  return nowNanos > state.commitTs ? nowNanos : state.commitTs + 1n;
};

/**
 * The commit timestamp a mutation that began at `before` resolves its result
 * with: its commit's, or the next one when it wrote nothing.
 */
export const commitTsAt = (after: State, before: State, now: number) =>
  after.version === before.version ? nextCommitTs(before, now) : after.commitTs;
