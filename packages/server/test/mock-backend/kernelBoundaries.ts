import * as Option from "effect/Option";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as String from "effect/String";
import { pipe } from "effect/Function";
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
      "The binary counts, in databaseQueries, the system-table intervals it reads to run a function: the backend state and info, the function's module, its UDF config and its component. They depend on the deployment's modules, components and environment. On the local-backend fixture a root mutation starts at 23 before its first read, and its first nested call adds 2. A stale-snapshot query runs on a clone whose read set starts empty, so it starts at 23 again.",
    kernel:
      "The kernel counts only the intervals of the function's own reads, by the binary's rule, starting from zero. Each read maps a total x to max(0, x - before) + after, which never decreases and never moves two totals apart, so the binary's count stays between the kernel's and the kernel's plus the system share. While neither count saturates it is exactly the kernel's plus the share, and the binary refuses TooManyReads that many reads sooner. A read that covers inserted IDs can saturate only the kernel's lower count, and the gap shrinks: one insert and a read of its ID answer 23 on the binary and 1 on the kernel. Once both saturate they agree: 100 inserts and a read of one answer 100 on both. The binary refuses no later than the kernel, and at most the system share sooner.",
    measured: {
      rootMutationStart: 23,
      firstNestedCall: 2,
      staleSnapshotQueryStart: 23,
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
  const entry = Option.getOrUndefined(
    Arr.findFirst(boundaries, (candidate) => candidate.name === name),
  );
  if (entry === undefined) {
    throw new Error(`No kernel boundary is named "${name}".`);
  }
  const empty = Arr.filter(
    Rec.keys(entry) as Array<keyof KernelBoundary>,
    (field) => {
      const value = entry[field];
      return typeof value === "string"
        ? pipe(value, String.trim) === ""
        : Rec.keys(value).length === 0;
    },
  );
  if (empty.length > 0) {
    throw new Error(
      `Kernel boundary "${name}" has no ${Arr.join(empty, ", ")}. Fill every field.`,
    );
  }
  return entry;
};

/**
 * An operation the binary runs that the kernel refuses rather than answer
 * without the binary's inputs, recorded the same way: one exact name, what the
 * binary does, the kernel's typed refusal, an owner and pinned evidence. The
 * probe it names reads the binary's answer, so a binary that stops running the
 * operation fails it.
 */
export interface KernelRefusalBoundary {
  readonly name: string;
  /**
   * The operation, and where it runs.
   */
  readonly operation: string;
  readonly binary: string;
  readonly kernel: string;
  /**
   * The refusal the kernel raises instead, by tag and fields.
   */
  readonly refusal: string;
  readonly backend: string;
  readonly owner: string;
  readonly evidence: string;
  readonly probe: string;
}

const randomnessProbe =
  "randomness.test.ts > randomness on a real backend > a query, a mutation and an action may each draw from Math.random and crypto, refuse the fills the binary refuses, and generate a key only in an action";

export const refusalBoundaries: ReadonlyArray<KernelRefusalBoundary> = [
  {
    name: "ActionCryptoRandomness",
    operation:
      "crypto.subtle.generateKey, RSA-OAEP encrypt, and ECDSA or RSA-PSS sign, in an action",
    binary:
      "An action's CryptoRng is the system's, so the binary generates the key or draws the padding or nonce from system entropy.",
    kernel:
      "The kernel holds no generator, and the system's entropy is not replayable, so it rejects the operation's promise instead of drawing host entropy. Deterministic subtle operations (digest, importKey, exportKey, decrypt, verify, deriveBits, deriveKey, and HMAC, Ed25519 or RSASSA-PKCS1-v1_5 sign) run as on the host.",
    refusal:
      'RequiresBinary { operation: "subtleGenerateKey" | "subtleEncrypt" | "subtleSign" }',
    backend: "precompiled-2026-10-28-cccbade",
    owner: "@confect/test kernel, build-order row 6 (randomness)",
    evidence:
      "convex-backend cccbade4: the action environment's crypto_rng returns CryptoRng::new() (crates/isolate/src/environment/action/mod.rs:1576-1578); generateKey always asks for it (crates/isolate/src/ops/subtle_crypto/mod.rs:326-333, crates/webcrypto/src/lib.rs:349-373), encrypt for RSA-OAEP (subtle_crypto/mod.rs:401, webcrypto/src/lib.rs:478-481), sign for ECDSA and RSA-PSS (subtle_crypto/mod.rs:472, webcrypto/src/lib.rs:525-531, webcrypto/src/rsa.rs:471-475).",
    probe: randomnessProbe,
  },
  {
    name: "ActionLoadCryptoRandomness",
    operation:
      "the same crypto.subtle operations while a module loads for an action",
    binary:
      "The binary loads a module in the environment of the function it runs, so a module loading for an action generates the key, as the action would.",
    kernel:
      "The kernel loads each module once for every function type, before any function runs, so it cannot tell an action's load from a query's. It rejects the operation with the binary's queries-and-mutations error, the answer a load for a query or a mutation gets.",
    refusal:
      "Error: Can't use cryptographic randomness in queries and mutations. Please consider using an action. See https://docs.convex.dev/functions/actions for more details.",
    backend: "precompiled-2026-10-28-cccbade",
    owner: "@confect/test kernel, build-order row 6 (randomness)",
    evidence:
      "convex-backend cccbade4: the UDF environment refuses cryptographic randomness in every phase (crates/isolate/src/environment/udf/mod.rs:264-272, :290-292), and the action environment allows it in every phase (crates/isolate/src/environment/action/mod.rs:1576-1578). Measured on the pinned binary: a module-scope generateKey answers the refusal to a query and a mutation and generates the key for an action.",
    probe: randomnessProbe,
  },
];

/**
 * The refusal entry named `name`, refused unless every field is filled.
 */
export const refusalBoundary = (name: string): KernelRefusalBoundary => {
  const entry = Option.getOrUndefined(
    Arr.findFirst(refusalBoundaries, (candidate) => candidate.name === name),
  );
  if (entry === undefined) {
    throw new Error(`No kernel refusal boundary is named "${name}".`);
  }
  const empty = Arr.filter(
    Rec.keys(entry) as Array<keyof KernelRefusalBoundary>,
    (field) => pipe(entry[field], String.trim) === "",
  );
  if (empty.length > 0) {
    throw new Error(
      `Kernel refusal boundary "${name}" has no ${Arr.join(empty, ", ")}. Fill every field.`,
    );
  }
  return entry;
};
