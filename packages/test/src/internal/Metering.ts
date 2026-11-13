// The limits, counters and messages are convex-backend's, read at the commit
// the fork's local backend runs (`precompiled-2026-10-28-cccbade`). Paths below
// are in that repository.

import type { TransactionMetrics } from "convex/server";
import { compareValues, getConvexSize, type Value } from "convex/values";
import * as Schema from "effect/Schema";
import type { SerializedRangeExpression } from "./KernelValues.js";
import { evaluateQueryValue } from "./KernelValues.js";

/**
 * The ceilings one function execution runs under, the binary's
 * `TransactionLimits` (`crates/database/src/execution_size.rs:62-95`).
 */
export type Limits = { readonly [K in keyof TransactionMetrics]: number };

/**
 * The binary's default ceilings (`crates/common/src/knobs.rs`).
 */
export const defaults: Limits = {
  // `TRANSACTION_MAX_READ_SIZE_BYTES`, knobs.rs:645-647.
  bytesRead: 1 << 24,
  // `TRANSACTION_MAX_READ_SIZE_ROWS`, knobs.rs:641-642.
  documentsRead: 32000,
  // `TRANSACTION_MAX_READ_SET_INTERVALS`, knobs.rs:657-658.
  databaseQueries: 4096,
  // `TRANSACTION_MAX_NUM_USER_WRITES`, knobs.rs:406-407.
  documentsWritten: 16000,
  // `TRANSACTION_MAX_USER_WRITE_SIZE_BYTES`, knobs.rs:410-412.
  bytesWritten: 1 << 24,
  // `TRANSACTION_MAX_NUM_SCHEDULED`, knobs.rs:514-515.
  functionsScheduled: 1000,
  // `TRANSACTION_MAX_SCHEDULED_TOTAL_ARGUMENT_SIZE_BYTES`, knobs.rs:530-536.
  scheduledFunctionArgsBytes: 1 << 24,
  // `TRANSACTION_MAX_NUM_FILES_WRITTEN`, knobs.rs:539-540.
  filesWritten: 10,
  // `TRANSACTION_MAX_FILE_WRITE_SIZE_BYTES`, knobs.rs:544-546.
  fileWriteBytes: 1 << 24,
  // `TRANSACTION_MAX_NUM_FILES_READ`, knobs.rs:549-550.
  filesRead: 10,
  // `TRANSACTION_MAX_FILE_READ_SIZE_BYTES`, knobs.rs:554-556.
  fileReadBytes: 1 << 24,
};

/**
 * What a nested call may use on top of what its transaction has used, as
 * `ctx.runQuery` and `ctx.runMutation` take it in `transactionLimits`.
 */
export type Budget = Partial<Limits>;

/**
 * A nested call's ceilings: each one what the transaction has used plus the
 * call's budget, never above the caller's (`TransactionLimits::from_budget`,
 * execution_size.rs:97-160). An unset field leaves the caller's ceiling.
 */
export const fromBudget = (
  budget: Budget,
  used: Limits,
  ceiling: Limits,
): Limits =>
  Object.fromEntries(
    (Object.keys(ceiling) as Array<keyof Limits>).map((metric) => [
      metric,
      Math.min(
        used[metric] + (budget[metric] ?? ceiling[metric]),
        ceiling[metric],
      ),
    ]),
  ) as unknown as Limits;

const overLimitHelp =
  "Consider using smaller limits in your queries, paginating your queries, or using indexed queries with a selective index range expressions.";

/**
 * A function execution crossed one of its ceilings. `code` is the binary's
 * short message and `message` its text, which the function receives as a
 * catchable error.
 */
export class TransactionLimitExceeded extends Schema.TaggedError<TransactionLimitExceeded>()(
  "TransactionLimitExceeded",
  {
    code: Schema.Literals([
      "TooManyReads",
      "TooManyDocumentsRead",
      "TooManyBytesRead",
      "TooManyWrites",
      "TooManyBytesWritten",
      "TooManyFunctionsScheduled",
      "ScheduledFunctionsArgumentsTooLarge",
    ]),
    limit: Schema.Int,
    message: Schema.String,
  },
) {}

const byteUnits: ReadonlyArray<readonly [number, string]> = [
  [2 ** 30, "GiB"],
  [1_000_000_000, "GB"],
  [2 ** 20, "MiB"],
  [1_000_000, "MB"],
  [2 ** 10, "KiB"],
  [1_000, "KB"],
];

/**
 * `common::fmt::format_bytes` (`crates/common/src/fmt.rs:29-47`).
 */
export const formatBytes = (n: number): string => {
  if (n === 0) return "0 bytes";
  for (const [unit, name] of byteUnits) {
    if (n < unit) continue;
    if (n % unit === 0) return `${n / unit} ${name}`;
    if ((n * 10) % unit === 0) {
      return `${Math.floor(n / unit)}.${Math.floor((n * 10) / unit) % 10} ${name}`;
    }
  }
  return `${n} bytes`;
};

/**
 * A position in an index's key space: just before, or just after, every key
 * that starts with `key`.
 */
interface Bound {
  readonly key: ReadonlyArray<Value | undefined>;
  readonly side: -1 | 1;
}

/**
 * The keys from `start` up to `end`.
 */
export interface KeyInterval {
  readonly start: Bound;
  readonly end: Bound;
}

const compareBounds = (a: Bound, b: Bound): number => {
  const shared = Math.min(a.key.length, b.key.length);
  for (let i = 0; i < shared; i++) {
    const cmp = compareValues(a.key[i] as Value, b.key[i] as Value);
    if (cmp !== 0) return cmp;
  }
  if (a.key.length === b.key.length) return a.side - b.side;
  return a.key.length < b.key.length ? a.side : -b.side;
};

const maxBound = (a: Bound, b: Bound) => (compareBounds(a, b) >= 0 ? a : b);
const minBound = (a: Bound, b: Bound) => (compareBounds(a, b) <= 0 ? a : b);

/**
 * The one key `key`, as a read or write of a document by ID records it.
 */
export const point = (key: ReadonlyArray<Value | undefined>): KeyInterval => ({
  start: { key, side: -1 },
  end: { key, side: 1 },
});

/**
 * Every key of an index.
 */
export const everything: KeyInterval = point([]);

/**
 * The part of an index range a query has examined: from where it starts, past
 * the cursor `after`, through `through` in its order. `null` when it has
 * examined nothing.
 */
export const examined = (
  range: ReadonlyArray<SerializedRangeExpression>,
  order: "asc" | "desc",
  after: ReadonlyArray<Value | undefined> | null,
  through: ReadonlyArray<Value | undefined> | "end",
): KeyInterval | null => {
  const equal: Array<Value | undefined> = [];
  let start: Bound | undefined;
  let end: Bound | undefined;
  for (const expression of range) {
    const value = evaluateQueryValue(expression.value);
    switch (expression.type) {
      case "Eq":
        equal.push(value);
        break;
      case "Gt":
      case "Gte":
        start = {
          key: [...equal, value],
          side: expression.type === "Gt" ? 1 : -1,
        };
        break;
      case "Lt":
      case "Lte":
        end = {
          key: [...equal, value],
          side: expression.type === "Lt" ? -1 : 1,
        };
        break;
    }
  }
  start ??= { key: equal, side: -1 };
  end ??= { key: equal, side: 1 };
  if (after !== null) {
    if (order === "asc") start = maxBound(start, { key: after, side: 1 });
    else end = minBound(end, { key: after, side: -1 });
  }
  if (through !== "end") {
    if (order === "asc") end = minBound(end, { key: through, side: 1 });
    else start = maxBound(start, { key: through, side: -1 });
  }
  return compareBounds(start, end) < 0 ? { start, end } : null;
};

/**
 * The intervals read from one index, overlapping and adjacent ones merged
 * (`IntervalSet::add`, `crates/common/src/interval/interval_set.rs:150-230`).
 * They stay sorted and disjoint, so an add touches only its neighbours.
 */
class IntervalSet {
  private readonly intervals: Array<KeyInterval> = [];

  get size(): number {
    return this.intervals.length;
  }

  add(interval: KeyInterval) {
    const intervals = this.intervals;
    // The first interval that ends at or after the new one's start.
    let low = 0;
    let high = intervals.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (compareBounds(intervals[middle]!.end, interval.start) < 0) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    let last = low;
    let merged = interval;
    while (
      last < intervals.length &&
      compareBounds(intervals[last]!.start, interval.end) <= 0
    ) {
      const other = intervals[last]!;
      merged = {
        start: minBound(merged.start, other.start),
        end: maxBound(merged.end, other.end),
      };
      last++;
    }
    intervals.splice(low, last - low, merged);
  }
}

/**
 * The counters every frame of one attempt shares: reads and schedules stay when
 * a nested mutation fails, as the binary keeps them outside its subtransaction
 * token (`crates/database/src/transaction.rs:418-454`).
 */
class Shared {
  readonly indexes = new Map<string, IntervalSet>();
  intervals = 0;
  documentsRead = 0;
  bytesRead = 0;
  functionsScheduled = 0;
  scheduledFunctionArgsBytes = 0;
  // File storage counters stay at zero until the kernel stores files.
  readonly filesRead = 0;
  readonly fileReadBytes = 0;

  /**
   * A stale-snapshot query's counters: the scheduling and file-read counters
   * carried over, reads and intervals from zero (`clone_for_snapshot_query`,
   * `crates/database/src/transaction.rs:1460-1485`).
   */
  forStaleSnapshot(): Shared {
    const copy = new Shared();
    copy.functionsScheduled = this.functionsScheduled;
    copy.scheduledFunctionArgsBytes = this.scheduledFunctionArgsBytes;
    return copy;
  }
}

/**
 * `a - b`, or 0 when `b` is larger: Rust's `usize::saturating_sub`.
 */
const saturatingSub = (a: number, b: number) => (a > b ? a - b : 0);

/**
 * One frame's share of an attempt's accounting. The outermost frame belongs to
 * the top-level function and each nested mutation gets a child. A child's
 * writes count toward its caller's once it merges and are forgotten when it
 * fails, as the binary's nested write set rolls its sizes back
 * (`crates/database/src/writes.rs:96-136`).
 */
export class Meter {
  private documentsWritten = 0;
  private bytesWritten = 0;
  // File storage counters stay at zero until the kernel stores files.
  private readonly filesWritten = 0;
  private readonly fileWriteBytes = 0;

  constructor(
    private readonly shared: Shared = new Shared(),
    private readonly parent?: Meter,
  ) {}

  child(): Meter {
    return new Meter(this.shared, this);
  }

  /**
   * The meter of a query run on a stale snapshot. The binary runs it on a clone
   * of the transaction that keeps the scheduling counters and starts reads and
   * writes from zero, then drops the clone, so nothing it counts reaches this
   * meter (`clone_for_snapshot_query`,
   * `crates/database/src/transaction.rs:1460-1485`; `run_udf`,
   * `crates/isolate/src/environment/udf/async_syscall.rs:695-776`).
   */
  forStaleSnapshot(): Meter {
    return new Meter(this.shared.forStaleSnapshot());
  }

  /**
   * The child's writes become its caller's.
   */
  merge() {
    if (this.parent === undefined) {
      throw new Error("The outermost meter of an attempt has no caller.");
    }
    this.parent.documentsWritten += this.documentsWritten;
    this.parent.bytesWritten += this.bytesWritten;
  }

  private chain(): Array<Meter> {
    return this.parent === undefined ? [this] : [...this.parent.chain(), this];
  }

  /**
   * How much of each limit the execution has used.
   */
  used(): Limits {
    const frames = this.chain();
    const sum = (of: (meter: Meter) => number) =>
      frames.reduce((total, meter) => total + of(meter), 0);
    const shared = this.shared;
    return {
      bytesRead: shared.bytesRead,
      documentsRead: shared.documentsRead,
      databaseQueries: shared.intervals,
      documentsWritten: sum((meter) => meter.documentsWritten),
      bytesWritten: sum((meter) => meter.bytesWritten),
      functionsScheduled: shared.functionsScheduled,
      scheduledFunctionArgsBytes: shared.scheduledFunctionArgsBytes,
      filesWritten: sum((meter) => meter.filesWritten),
      fileWriteBytes: sum((meter) => meter.fileWriteBytes),
      filesRead: shared.filesRead,
      fileReadBytes: shared.fileReadBytes,
    };
  }

  /**
   * What `getTransactionMetrics` answers (`tx_metrics`,
   * `crates/isolate/src/environment/udf/async_syscall.rs:947-993`).
   */
  metrics(limits: Limits): TransactionMetrics {
    const used = this.used();
    return Object.fromEntries(
      (Object.keys(limits) as Array<keyof Limits>).map((metric) => [
        metric,
        { used: used[metric], remaining: limits[metric] - used[metric] },
      ]),
    ) as unknown as TransactionMetrics;
  }

  private set(index: string): IntervalSet {
    const set = this.shared.indexes.get(index) ?? new IntervalSet();
    this.shared.indexes.set(index, set);
    return set;
  }

  /**
   * A read the function made of `interval` in `index`, counted as the binary
   * counts it: the total drops by the index's interval count before the read,
   * saturating at zero, and rises by its count after
   * (`record_indexed_directly`, `crates/database/src/reads.rs:447-480`). The
   * index's count includes the intervals of IDs this execution inserted, which
   * joined it without counting (`deriveInterval`), so a read that covers them
   * can move the total by more than the read itself. The binary starts the
   * total at the system-table intervals it reads to run the function, which the
   * kernel does not simulate, so the two totals differ by that share until a
   * read saturates both (see the `SystemTableReadIntervals` boundary).
   */
  readInterval(
    index: string,
    interval: KeyInterval,
    limits: Limits,
  ): TransactionLimitExceeded | undefined {
    const set = this.set(index);
    const before = set.size;
    set.add(interval);
    const shared = this.shared;
    shared.intervals = saturatingSub(shared.intervals, before) + set.size;
    // Both terms are counts, so the total never goes below zero.
    if (!Number.isSafeInteger(shared.intervals) || shared.intervals < 0) {
      throw new Error(
        `The kernel counted ${shared.intervals} intervals read, which is no count.`,
      );
    }
    return shared.intervals > limits.databaseQueries
      ? new TransactionLimitExceeded({
          code: "TooManyReads",
          limit: limits.databaseQueries,
          message: `Too many reads in a single function execution (limit: ${limits.databaseQueries}). ${overLimitHelp}`,
        })
      : undefined;
  }

  /**
   * A read the binary takes for a write rather than for the function: a new
   * document's ID (`register_new_id`, writes.rs:426-441). It joins the index's
   * intervals and leaves the total as it was (`record_indexed_derived` calls
   * `_record_indexed` and ignores its counts, reads.rs:333-344), so a later
   * read of that index starts from a count that includes it.
   */
  deriveInterval(index: string, interval: KeyInterval) {
    this.set(index).add(interval);
  }

  /**
   * A document the function read. A system table's document counts toward no
   * limit (`record_read_document`, reads.rs:365-445).
   */
  readDocument(
    document: Value,
    system: boolean,
    limits: Limits,
  ): TransactionLimitExceeded | undefined {
    if (system) return undefined;
    const shared = this.shared;
    shared.documentsRead += 1;
    shared.bytesRead += getConvexSize(document);
    if (shared.documentsRead > limits.documentsRead) {
      return new TransactionLimitExceeded({
        code: "TooManyDocumentsRead",
        limit: limits.documentsRead,
        message: `Too many documents read in a single function execution (limit: ${limits.documentsRead}). ${overLimitHelp}`,
      });
    }
    if (shared.bytesRead > limits.bytesRead) {
      return new TransactionLimitExceeded({
        code: "TooManyBytesRead",
        limit: limits.bytesRead,
        message: `Too many bytes read in a single function execution (limit: ${limits.bytesRead} bytes). ${overLimitHelp}`,
      });
    }
    return undefined;
  }

  /**
   * A write to a user table: the new document, or `null` for a delete. Each
   * write counts, even to a document this execution already wrote
   * (`Writes::update`, writes.rs:241-310).
   */
  write(
    document: Value | null,
    limits: Limits,
  ): TransactionLimitExceeded | undefined {
    this.documentsWritten += 1;
    this.bytesWritten += document === null ? 0 : getConvexSize(document);
    const used = this.used();
    if (used.documentsWritten > limits.documentsWritten) {
      return new TransactionLimitExceeded({
        code: "TooManyWrites",
        limit: limits.documentsWritten,
        message: `Too many writes in a single function execution (limit: ${limits.documentsWritten})`,
      });
    }
    if (used.bytesWritten > limits.bytesWritten) {
      return new TransactionLimitExceeded({
        code: "TooManyBytesWritten",
        limit: limits.bytesWritten,
        message: `Too many bytes written in a single function execution (limit: ${formatBytes(limits.bytesWritten)})`,
      });
    }
    return undefined;
  }

  /**
   * A function scheduled with `args`. The binary checks before it counts, so a
   * refused schedule counts nothing (`check_scheduling_limits`,
   * `crates/model/src/scheduled_jobs/mod.rs:162-196`). Its arguments are sized
   * as the one-element array the scheduler stores.
   */
  schedule(args: Value, limits: Limits): TransactionLimitExceeded | undefined {
    const shared = this.shared;
    const size = getConvexSize([args]);
    if (shared.functionsScheduled >= limits.functionsScheduled) {
      return new TransactionLimitExceeded({
        code: "TooManyFunctionsScheduled",
        limit: limits.functionsScheduled,
        message: `Too many functions scheduled by this mutation (limit: ${limits.functionsScheduled})`,
      });
    }
    if (
      shared.scheduledFunctionArgsBytes + size >
      limits.scheduledFunctionArgsBytes
    ) {
      return new TransactionLimitExceeded({
        code: "ScheduledFunctionsArgumentsTooLarge",
        limit: limits.scheduledFunctionArgsBytes,
        message: `Too large total size of the arguments of scheduled functions from this mutation (limit: ${limits.scheduledFunctionArgsBytes} bytes)`,
      });
    }
    shared.functionsScheduled += 1;
    shared.scheduledFunctionArgsBytes += size;
    return undefined;
  }
}
