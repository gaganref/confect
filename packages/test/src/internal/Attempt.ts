// oxlint-disable-next-line effecttsgo/node-builtin-import -- The drain waits a real turn of the event loop. Fake timers in a test replace the global `setImmediate`, not this one.
import { setImmediate } from "node:timers/promises";
import type { Attempt as AttemptNumber } from "./Invocation.js";
import * as Kernel from "./Kernel.js";
import type { DocumentId, StoredDocument } from "./KernelValues.js";
import { tableNameFromId } from "./KernelValues.js";
import type * as ReadSet from "./ReadSet.js";

/**
 * Pending writes, keyed by component path, then document ID. `null` deletes.
 */
type Overlay = Map<string, Map<DocumentId, StoredDocument | null>>;

/**
 * One attempt at a query or mutation: the committed state it started from, its
 * pending writes and what it read. The outermost frame belongs to the top-level
 * function. Each nested mutation pushes a frame, which merges into its caller's
 * frame when it returns and is dropped when it fails. Reads are never dropped:
 * a failed nested mutation's reads stay in the attempt.
 *
 * An attempt takes reads and writes until it is closed. A mutation's attempt
 * closes once its function has returned and no syscall it started is still
 * running, so a write a detached fiber makes after the handler settled still
 * lands in it, as on the binary.
 *
 * Only the invocation that owns an attempt writes to it. `Kernel.apply`
 * publishes its writes.
 */
export class KernelAttempt {
  private readonly frames: Array<Overlay> = [new Map()];
  private readonly recorded: Array<ReadSet.Read> = [];
  private running = 0;
  private started = 0;
  private open = true;

  constructor(
    readonly snapshot: Kernel.State,
    readonly number: AttemptNumber = 1,
  ) {}

  get reads(): ReadonlyArray<ReadSet.Read> {
    return this.recorded;
  }

  get closed(): boolean {
    return !this.open;
  }

  readDocument(componentPath: string, id: DocumentId) {
    this.recorded.push({ kind: "document", componentPath, id });
  }

  /**
   * Record a read of an interval. The returned function advances how far the
   * query examined it.
   */
  readInterval(
    read: Omit<ReadSet.IntervalRead, "through">,
  ): (through: ReadSet.Key | "end") => void {
    const interval: ReadSet.IntervalRead = { ...read, through: null };
    this.recorded.push(interval);
    return (through) => {
      interval.through = through;
    };
  }

  /**
   * A syscall began. `end` runs when it settles.
   */
  begin(): () => void {
    this.running++;
    this.started++;
    return () => {
      this.running--;
    };
  }

  /**
   * Resolves once a whole turn of the event loop passes with no syscall of this
   * attempt running or started.
   */
  drained(): Promise<void> {
    const before = this.started;
    return setImmediate().then(() =>
      this.running === 0 && this.started === before
        ? undefined
        : this.drained(),
    );
  }

  close() {
    this.open = false;
  }

  get depth(): number {
    return this.frames.length;
  }

  get(componentPath: string, id: DocumentId): StoredDocument | null {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const write = this.frames[i]!.get(componentPath)?.get(id);
      if (write !== undefined) return write;
    }
    return Kernel.get(this.snapshot, componentPath, id)?.doc ?? null;
  }

  /**
   * The table as this attempt sees it, committed rows under pending writes.
   */
  scan(componentPath: string, tableName: string): Array<StoredDocument> {
    const ids = new Set<DocumentId>();
    for (const row of Kernel.rows(this.snapshot, componentPath, tableName))
      ids.add(row.doc._id);
    for (const frame of this.frames)
      for (const id of frame.get(componentPath)?.keys() ?? [])
        if (tableNameFromId(id) === tableName) ids.add(id);
    const docs: Array<StoredDocument> = [];
    for (const id of ids) {
      const doc = this.get(componentPath, id);
      if (doc !== null) docs.push(doc);
    }
    return docs;
  }

  write(componentPath: string, id: DocumentId, doc: StoredDocument | null) {
    const frame = this.frames[this.frames.length - 1]!;
    const writes = frame.get(componentPath) ?? new Map();
    frame.set(componentPath, writes);
    writes.set(id, doc);
  }

  /**
   * A nested mutation begins.
   */
  push() {
    this.frames.push(new Map());
  }

  /**
   * A nested mutation returned. Its writes become its caller's.
   */
  merge() {
    const frame = this.frames.pop()!;
    for (const [componentPath, writes] of frame)
      for (const [id, doc] of writes) this.write(componentPath, id, doc);
  }

  /**
   * A nested mutation failed. Its writes are gone.
   */
  drop() {
    this.frames.pop();
  }

  /**
   * The outermost frame's writes, for `Kernel.apply`.
   */
  writes(): Array<Kernel.Write> {
    return Array.from(this.frames[0]!, ([componentPath, writes]) =>
      Array.from(writes, ([id, doc]) => ({ componentPath, id, doc })),
    ).flat();
  }
}
