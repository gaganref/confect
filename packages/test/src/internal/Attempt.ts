import * as Kernel from "./Kernel.js";
import type { DocumentId, StoredDocument } from "./KernelValues.js";
import { tableNameFromId } from "./KernelValues.js";

/**
 * Pending writes, keyed by component path, then document ID. `null` deletes.
 */
type Overlay = Map<string, Map<DocumentId, StoredDocument | null>>;

/**
 * One frame of an attempt at a query or mutation: the committed state the
 * attempt started from, its caller's frame and its own pending writes. The
 * outermost frame belongs to the top-level function. Each nested mutation opens
 * a child frame, which merges into its caller's frame when it returns and is
 * dropped when it fails.
 *
 * A frame belongs to one invocation, which alone writes to it, so a caller's
 * write made while its nested mutation is in flight stays the caller's.
 * `Kernel.apply` publishes the outermost frame's writes.
 */
export class KernelAttempt {
  private readonly overlay: Overlay = new Map();

  constructor(
    readonly snapshot: Kernel.State,
    private readonly parent?: KernelAttempt,
  ) {}

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
    return new KernelAttempt(this.snapshot, this);
  }

  /**
   * A nested mutation returned. Its writes become its caller's.
   */
  merge() {
    if (this.parent === undefined) {
      throw new Error("The outermost frame of an attempt has no caller.");
    }
    for (const [componentPath, writes] of this.overlay)
      for (const [id, doc] of writes) this.parent.write(componentPath, id, doc);
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
