/**
 * The test kernel's accepted differences from the Convex binary as data: a
 * count or refusal the binary makes that the kernel does not simulate, and why.
 * `kernelPlacement.ts` lists the cases the kernel lane skips. This lists what a
 * case running on the kernel cannot see. Each entry names the local backend
 * probe that measures it, and the probe reads its numbers from here, so a
 * binary that changes them fails the probe.
 *
 * The shape follows the convex-test lane's conformance exceptions (#137): one
 * exact name, the binary's behaviour, an owner and pinned evidence.
 */
export interface KernelBoundary {
  /**
   * A name to refer to the entry by, exactly.
   */
  readonly name: string;
  /**
   * The `TransactionMetrics` field the difference shows in.
   */
  readonly metric: string;
  /**
   * The refusal whose timing the difference moves.
   */
  readonly refusal: string;
  /**
   * What the binary does that the kernel does not.
   */
  readonly binary: string;
  /**
   * What the kernel does instead.
   */
  readonly kernel: string;
  /**
   * The amounts the probe measured on the pinned binary.
   */
  readonly measured: Readonly<Record<string, number>>;
  /**
   * The binary the amounts were measured on.
   */
  readonly backend: string;
  readonly owner: string;
  /**
   * Where the binary behaviour is shown, by source.
   */
  readonly evidence: string;
  /**
   * The local-backend case that measures it, as its file, describe block and
   * title joined by " > ".
   */
  readonly probe: string;
}

export const boundaries: ReadonlyArray<KernelBoundary> = [
  {
    name: "SystemTableReadIntervals",
    metric: "databaseQueries",
    refusal: "Too many reads in a single function execution (limit: 4096).",
    binary:
      "The binary counts, in databaseQueries, the system-table intervals it reads to run a function: the backend state and info, the function's module, its UDF config and its component. They depend on the deployment's modules, components and environment. On the local-backend fixture a root mutation starts at 19 before its first read, and its first nested call adds 2. A stale-snapshot query runs on a clone whose read set starts empty, so it starts at 19 again.",
    kernel:
      "The kernel counts only the intervals of the function's own reads, by the binary's rule, starting from zero. Each read maps a total x to max(0, x - before) + after, which never decreases and never moves two totals apart, so the binary's count stays between the kernel's and the kernel's plus the system share. While neither count saturates it is exactly the kernel's plus the share, and the binary refuses TooManyReads that many reads sooner. A read that covers inserted IDs can saturate only the kernel's lower count, and the gap shrinks: one insert and a read of its ID answer 19 on the binary and 1 on the kernel. Once both saturate they agree: 100 inserts and a read of one answer 100 on both. The binary refuses no later than the kernel, and at most the system share sooner.",
    measured: {
      rootMutationStart: 19,
      firstNestedCall: 2,
      staleSnapshotQueryStart: 19,
    },
    backend: "precompiled-2026-10-28-cccbade",
    owner: "@confect/test kernel, build-order row 6 (transaction limits)",
    evidence:
      "convex-backend cccbade4: ValidatedPathAndArgs::new_with_returns_validator reads the backend state (fail_while_not_running), the UDF version and the module metadata through the function's transaction (crates/udf/src/validation.rs:132-160, 490-620); record_indexed_directly counts every index read's intervals, a system table's included (crates/database/src/reads.rs:447-480); tx_metrics answers that count (crates/isolate/src/environment/udf/async_syscall.rs:947-993).",
    probe:
      "transactionControls.test.ts > transaction controls > answers getMetrics for one fixed workload as the test kernel does, apart from the SystemTableReadIntervals boundary",
  },
];

/**
 * The entry named `name`, refused unless every field is filled.
 */
export const boundary = (name: string): KernelBoundary => {
  const entry = boundaries.find((candidate) => candidate.name === name);
  if (entry === undefined) {
    throw new Error(`No kernel boundary is named "${name}".`);
  }
  const empty = (Object.keys(entry) as Array<keyof KernelBoundary>).filter(
    (field) => {
      const value = entry[field];
      return typeof value === "string"
        ? value.trim() === ""
        : Object.keys(value).length === 0;
    },
  );
  if (empty.length > 0) {
    throw new Error(
      `Kernel boundary "${name}" has no ${empty.join(", ")}. Fill every field.`,
    );
  }
  return entry;
};
