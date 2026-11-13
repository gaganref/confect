// oxlint-disable-next-line effecttsgo/node-builtin-import, no-restricted-imports -- An attempt's drain waits one real turn of the event loop, which is no deadline. Fake timers in a test replace the global `setImmediate`, not this one.
import { setImmediate } from "node:timers/promises";
import type { Attempt as AttemptNumber } from "./Invocation.js";
import * as Kernel from "./Kernel.js";
import type { DocumentId, StoredDocument } from "./KernelValues.js";
import { tableNameFromId } from "./KernelValues.js";
import * as Metering from "./Metering.js";
import type * as ReadSet from "./ReadSet.js";

/**
 * Pending writes, keyed by component path, then document ID. `null` deletes.
 */
type Overlay = Map<string, Map<DocumentId, StoredDocument | null>>;

/**
 * How long one frame takes syscalls: those it has running, those it has
 * started, and whether it still takes them.
 */
interface Life {
  running: number;
  started: number;
  open: boolean;
}

/**
 * One frame of an attempt at a query or mutation: the committed state the
 * attempt started from, its caller's frame and its own pending writes. The
 * outermost frame belongs to the top-level function. Each nested mutation opens
 * a child frame, which merges into its caller's frame when it returns and is
 * dropped when it fails. Reads belong to the whole attempt and are never
 * dropped: a failed nested mutation's reads stay in the attempt.
 *
 * Each frame has its own lifetime. A frame takes reads and writes until it is
 * closed. A mutation's frame closes once its function has returned and no
 * syscall it started is still running, so a write a detached fiber makes after
 * the handler settled still lands in it, as on the binary. A nested mutation's
 * frame closes before it merges into its caller's, so no write reaches it after
 * its writes became its caller's.
 *
 * A frame belongs to one invocation, which alone writes to it, so a caller's
 * write made while its nested mutation is in flight stays the caller's.
 * `Kernel.apply` publishes the outermost frame's writes.
 */
export class KernelAttempt {
  private readonly overlay: Overlay = new Map();
  private readonly life: Life = { running: 0, started: 0, open: true };
  private readonly allReads: Array<ReadSet.Read>;
  /**
   * The attempt's transaction-limit accounting. A nested mutation's frame
   * meters into its own child, so its writes merge or drop with it while its
   * reads stay.
   */
  readonly meter: Metering.Meter;
  /**
   * Whether the attempt asked for its caller's identity, and the time it read.
   * Every frame of the attempt shares them, as it shares the reads.
   */
  private readonly observed: { identity: boolean; time: number | null };

  constructor(
    readonly snapshot: Kernel.State,
    readonly number: AttemptNumber = 1,
    private readonly parent?: KernelAttempt,
  ) {
    this.allReads = parent?.allReads ?? [];
    this.meter = parent?.meter.child() ?? new Metering.Meter();
    this.observed = parent?.observed ?? { identity: false, time: null };
  }

  get reads(): ReadonlyArray<ReadSet.Read> {
    return this.allReads;
  }

  /**
   * Whether the function asked for its caller's identity.
   */
  get observedIdentity(): boolean {
    return this.observed.identity;
  }

  /**
   * The pinned time the function read, or `null` when it never read the time.
   */
  get observedTime(): number | null {
    return this.observed.time;
  }

  observeIdentity() {
    this.observed.identity = true;
  }

  observeTime(at: number) {
    this.observed.time = at;
  }

  get closed(): boolean {
    return !this.life.open;
  }

  readDocument(componentPath: string, id: DocumentId) {
    this.allReads.push({ kind: "document", componentPath, id });
  }

  /**
   * Record a read of an interval. The returned function advances how far the
   * query examined it.
   */
  readInterval(
    read: Omit<ReadSet.IntervalRead, "through">,
  ): (through: ReadSet.Key | "end") => void {
    const interval: ReadSet.IntervalRead = { ...read, through: null };
    this.allReads.push(interval);
    return (through) => {
      interval.through = through;
    };
  }

  /**
   * A syscall began. `end` runs when it settles.
   */
  begin(): () => void {
    const life = this.life;
    life.running++;
    life.started++;
    return () => {
      life.running--;
    };
  }

  /**
   * Resolves once a whole turn of the event loop passes with no syscall of this
   * frame running or started. A nested call is a syscall of its caller's frame
   * until it has drained.
   */
  drained(): Promise<void> {
    const before = this.life.started;
    return setImmediate().then(() =>
      this.life.running === 0 && this.life.started === before
        ? undefined
        : this.drained(),
    );
  }

  close() {
    this.life.open = false;
  }

  /**
   * The pending writes this frame sees, from the outermost frame to this one.
   */
  private overlays(): Array<Overlay> {
    return this.parent === undefined
      ? [this.overlay]
      : [...this.parent.overlays(), this.overlay];
  }

  get(componentPath: string, id: DocumentId): StoredDocument | null {
    for (const overlay of this.overlays().toReversed()) {
      const write = overlay.get(componentPath)?.get(id);
      if (write !== undefined) return write;
    }
    return Kernel.get(this.snapshot, componentPath, id)?.doc ?? null;
  }

  /**
   * The table as this frame sees it, committed rows under every pending write
   * from the outermost frame to this one.
   */
  scan(componentPath: string, tableName: string): Array<StoredDocument> {
    const ids = new Set<DocumentId>();
    for (const row of Kernel.rows(this.snapshot, componentPath, tableName))
      ids.add(row.doc._id);
    for (const overlay of this.overlays())
      for (const id of overlay.get(componentPath)?.keys() ?? [])
        if (tableNameFromId(id) === tableName) ids.add(id);
    const docs: Array<StoredDocument> = [];
    for (const id of ids) {
      const doc = this.get(componentPath, id);
      if (doc !== null) docs.push(doc);
    }
    return docs;
  }

  write(componentPath: string, id: DocumentId, doc: StoredDocument | null) {
    const writes = this.overlay.get(componentPath) ?? new Map();
    this.overlay.set(componentPath, writes);
    writes.set(id, doc);
  }

  /**
   * A nested mutation begins, in a frame of its own. Dropping a failed one is
   * forgetting it.
   */
  child(): KernelAttempt {
    return new KernelAttempt(this.snapshot, this.number, this);
  }

  /**
   * A nested mutation returned and its frame closed. Its writes become its
   * caller's.
   */
  merge() {
    if (this.parent === undefined) {
      throw new Error("The outermost frame of an attempt has no caller.");
    }
    if (this.life.open) {
      throw new Error("A nested mutation's frame merges only once closed.");
    }
    for (const [componentPath, writes] of this.overlay)
      for (const [id, doc] of writes) this.parent.write(componentPath, id, doc);
    this.meter.merge();
  }

  /**
   * The outermost frame's writes, for `Kernel.apply`.
   */
  writes(): Array<Kernel.Write> {
    return Array.from(this.overlay, ([componentPath, writes]) =>
      Array.from(writes, ([id, doc]) => ({ componentPath, id, doc })),
    ).flat();
  }
}
