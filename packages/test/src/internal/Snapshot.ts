// oxlint-disable-next-line effecttsgo/node-builtin-import -- Export is synchronous, and Effect 4.0's digests are asynchronous.
import { createHash } from "node:crypto";
import { convexToJson, jsonToConvex, type Value } from "convex/values";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Kernel from "./Kernel.js";
import * as KernelRefusal from "./KernelRefusal.js";
import type * as Scheduling from "./Scheduling.js";
import {
  tableNameFromId,
  type DocumentId,
  type FunctionPath,
  type StoredDocument,
} from "./KernelValues.js";

/**
 * The counters the kernel allocates identities from: the next document ID, the
 * latest creation time handed out, the next held attempt's ID, and the identity
 * epoch, which every subscriber's `authenticate` advances. A restored world
 * continues each where its source stopped, so the same calls mint the same
 * identities and the same identity versions.
 */
export interface Identity {
  readonly nextDocumentId: number;
  readonly lastCreationTime: number;
  readonly nextAttemptId: number;
  readonly identityEpoch: number;
}

/**
 * What the kernel keeps beside a job's row, with the job's test world named
 * rather than held. `null` is a job scheduled with no invocation bound.
 */
export interface JobTarget {
  readonly functionPath: FunctionPath;
  readonly standing: boolean;
  readonly world: string | null;
}

/**
 * The kernel state a snapshot carries: committed rows of every component with
 * the version that wrote each, the write log, the latest commit timestamp,
 * every job's target, the clock's floor and the identity counters.
 */
export interface Image {
  readonly components: ReadonlyArray<string>;
  readonly state: Kernel.State;
  /**
   * The latest deadline the clock was advanced to. `-Infinity` before any.
   */
  readonly floor: number;
  readonly identity: Identity;
  /**
   * The target of every job whose row is committed, by job ID.
   */
  readonly jobs: ReadonlyMap<DocumentId, JobTarget>;
}

/**
 * Whether a piece of kernel state is in a snapshot. `exported` names the
 * snapshot field that carries it. `excluded` says why a restore starts without
 * it.
 */
export type Participation =
  | { readonly exported: string }
  | { readonly excluded: string };

/**
 * The snapshot's contract with the kernel's state. Every field of the committed
 * state, of a job's target and of a `World` is listed here as exported or
 * excluded with its reason. The first two are checked by type: a field added to
 * `Kernel.State` or `Scheduling.Target` without an entry fails to compile. A
 * `World`'s fields are private, which no type can enumerate, so
 * `Snapshot.test.ts` compares a fresh world's own fields with `world` below,
 * and a field added without an entry fails that test.
 *
 * Owed by later rows, which add their state here when they land on `main`: cron
 * state (#133), stored file bytes, storage ID mappings, `nextFile` and
 * upload-token counters (#138), and component init markers. A restore never
 * redeclares a cron and never draws a fresh random value: it installs the
 * declared state as the snapshot holds it, so a row whose state comes from a
 * declaration or a random draw exports what was declared or drawn.
 */
export const contract = {
  state: {
    tables: { exported: "tables" },
    version: { exported: "version" },
    commitTs: { exported: "commitTs" },
    log: { exported: "log" },
  } satisfies { readonly [K in keyof Kernel.State]-?: Participation },
  target: {
    functionPath: { exported: "jobs[].target" },
    standing: { exported: "jobs[].standing" },
    world: { exported: "jobs[].world, by name" },
  } satisfies { readonly [K in keyof Scheduling.Target]-?: Participation },
  world: {
    components: {
      excluded:
        "Registered code, not state: the restoring world registers the same components, which `components` checks.",
    },
    state: { exported: "the committed state above" },
    opened: {
      excluded: "Whether modules loaded. A restore opens its world first.",
    },
    nextDocId: { exported: "identity.nextDocumentId" },
    lastCreationTime: { exported: "identity.lastCreationTime" },
    nextQueryId: {
      excluded:
        "Ids of query streams, which live only inside a running function, and a snapshot is never taken while one runs.",
    },
    queries: {
      excluded:
        "Open query streams, which live only inside a running function.",
    },
    holding: {
      excluded:
        "Held attempts are running closures. A world holding one refuses to export.",
    },
    nextAttemptId: { exported: "identity.nextAttemptId" },
    floor: { exported: "floor" },
    targets: { exported: "jobs" },
    running: {
      excluded:
        "Calls in flight. A world running one refuses to export or restore.",
    },
    identityEpoch: { exported: "identity.identityEpoch" },
    runtime: {
      excluded:
        "The driver's clock and commit timestamps. The restoring driver supplies its own.",
    },
  } satisfies Readonly<Record<string, Participation>>,
  /**
   * State outside the kernel's world, live per client or per process.
   */
  outside: {
    subscriptions: {
      excluded:
        "Live client state: subscribers, their callers and runs. A restore starts with no subscriptions. Identity versions continue through `identityEpoch`.",
    },
    requestIds: {
      excluded:
        "Request IDs, a process-wide counter, reach no committed state.",
    },
  } satisfies Readonly<Record<string, Participation>>,
} as const;

const header = "confect-kernel-snapshot 1 sha256:";

const FunctionPathJson = Schema.Struct({
  componentPath: Schema.String,
  udfPath: Schema.String,
});

const Body = Schema.Struct({
  components: Schema.Array(Schema.String),
  version: Schema.Int,
  commitTs: Schema.String,
  floor: Schema.NullOr(Schema.Finite),
  identity: Schema.Struct({
    nextDocumentId: Schema.Int,
    lastCreationTime: Schema.Finite,
    nextAttemptId: Schema.Int,
    identityEpoch: Schema.Int,
  }),
  tables: Schema.Array(
    Schema.Struct({
      componentPath: Schema.String,
      table: Schema.String,
      rows: Schema.Array(
        Schema.Struct({ version: Schema.Int, doc: Schema.Unknown }),
      ),
    }),
  ),
  jobs: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      target: FunctionPathJson,
      standing: Schema.Boolean,
      world: Schema.NullOr(Schema.String),
    }),
  ),
  log: Schema.Array(
    Schema.Struct({
      version: Schema.Int,
      commitTs: Schema.String,
      changes: Schema.Array(
        Schema.Struct({
          componentPath: Schema.String,
          id: Schema.String,
          before: Schema.Unknown,
          after: Schema.Unknown,
        }),
      ),
    }),
  ),
});

type Body = typeof Body.Type;

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const sorted = <A>(items: Iterable<A>, key: (item: A) => string): Array<A> =>
  Array.from(items).sort((a, b) => byString(key(a), key(b)));

const encodeDocument = (doc: StoredDocument | null) =>
  doc === null ? null : convexToJson(doc as Value);

const digestOf = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Encode `image` as snapshot bytes: a header line naming the format and the
 * SHA-256 digest of the body, then the body as JSON. Components, tables, rows
 * and jobs are sorted, and every document keeps its own field order, so the
 * same state always encodes to the same bytes.
 */
export const encode = (image: Image): Uint8Array => {
  const { state } = image;
  const tables: Array<Body["tables"][number]> = [];
  for (const [componentPath, byTable] of sorted(
    state.tables,
    ([path]) => path,
  )) {
    for (const [table, rows] of sorted(byTable, ([name]) => name)) {
      if (rows.size === 0) continue;
      tables.push({
        componentPath,
        table,
        rows: sorted(rows, ([id]) => id).map(([, row]) => ({
          version: row.version,
          doc: encodeDocument(row.doc),
        })),
      });
    }
  }
  const body: Body = {
    components: sorted(image.components, (path) => path),
    version: state.version,
    commitTs: state.commitTs.toString(),
    floor: Number.isFinite(image.floor) ? image.floor : null,
    identity: {
      nextDocumentId: image.identity.nextDocumentId,
      lastCreationTime: image.identity.lastCreationTime,
      nextAttemptId: image.identity.nextAttemptId,
      identityEpoch: image.identity.identityEpoch,
    },
    tables,
    jobs: sorted(image.jobs, ([id]) => id).map(([id, target]) => ({
      id,
      target: {
        componentPath: target.functionPath.componentPath,
        udfPath: target.functionPath.udfPath,
      },
      standing: target.standing,
      world: target.world,
    })),
    log: state.log.map((commit) => ({
      version: commit.version,
      commitTs: commit.commitTs.toString(),
      changes: commit.changes.map((change) => ({
        componentPath: change.componentPath,
        id: change.id,
        before: encodeDocument(change.before),
        after: encodeDocument(change.after),
      })),
    })),
  };
  const bodyBytes = new TextEncoder().encode(JSON.stringify(body));
  const head = new TextEncoder().encode(`${header}${digestOf(bodyBytes)}\n`);
  const bytes = new Uint8Array(head.length + bodyBytes.length);
  bytes.set(head);
  bytes.set(bodyBytes, head.length);
  return bytes;
};

const malformed = (reason: string, detail: string) =>
  new KernelRefusal.SnapshotMalformed({
    reason,
    message: `These bytes are not a test kernel snapshot this kernel reads (${reason}): ${detail}`,
  });

const decodeDocument = (json: unknown): StoredDocument | null => {
  if (json === null) return null;
  const doc = jsonToConvex(json as never);
  if (
    typeof doc !== "object" ||
    doc === null ||
    Array.isArray(doc) ||
    typeof (doc as { _id?: unknown })._id !== "string"
  ) {
    throw new Error("a document is not an object with an `_id`");
  }
  return doc as StoredDocument;
};

const imageOf = (body: Body): Image => {
  const tables = new Map<string, Map<string, Map<DocumentId, Kernel.Row>>>();
  for (const { componentPath, table, rows } of body.tables) {
    const byTable = tables.get(componentPath) ?? new Map();
    tables.set(componentPath, byTable);
    const byId = new Map<DocumentId, Kernel.Row>();
    byTable.set(table, byId);
    for (const { version, doc } of rows) {
      const decoded = decodeDocument(doc)!;
      byId.set(decoded._id, { doc: decoded, version });
    }
  }
  const log = body.log.map((commit): Kernel.Commit => ({
    version: commit.version,
    commitTs: BigInt(commit.commitTs),
    changes: commit.changes.map((change) => ({
      componentPath: change.componentPath,
      id: change.id as DocumentId,
      before: decodeDocument(change.before),
      after: decodeDocument(change.after),
    })),
  }));
  if (log.length !== body.version || log.some((c, i) => c.version !== i + 1)) {
    throw new Error(
      `the write log holds ${log.length} commits for version ${body.version}`,
    );
  }
  return {
    components: body.components,
    state: {
      tables,
      version: body.version,
      commitTs: BigInt(body.commitTs),
      log,
    },
    floor: body.floor ?? Number.NEGATIVE_INFINITY,
    identity: body.identity,
    jobs: new Map(
      body.jobs.map((job) => [
        job.id as DocumentId,
        {
          functionPath: job.target,
          standing: job.standing,
          world: job.world,
        },
      ]),
    ),
  };
};

/**
 * Why a decoded snapshot is not state the kernel could have reached.
 */
export type Inconsistency =
  | KernelRefusal.SnapshotAllocatorBehind
  | KernelRefusal.SnapshotRowInconsistent
  | KernelRefusal.SnapshotTimestampInconsistent
  | KernelRefusal.SnapshotJobInconsistent;

const documentText = (doc: StoredDocument | null): string =>
  doc === null ? "null" : JSON.stringify(convexToJson(doc as Value));

/**
 * The counter a kernel-minted document ID carries, or `undefined` for an ID the
 * kernel never mints.
 */
const counterOf = (id: string): number | undefined => {
  const table = tableNameFromId(id);
  const digits = table === null ? "" : id.slice(0, id.length - table.length);
  return /^[0-9]+$/.test(digits) ? Number(digits) : undefined;
};

const rowRefusal = (
  componentPath: string,
  id: string,
  reason: KernelRefusal.SnapshotRowInconsistent["reason"],
  detail: string,
) =>
  new KernelRefusal.SnapshotRowInconsistent({
    componentPath,
    id,
    reason,
    message: `The snapshot's document ${id} in "${componentPath}" ${detail}.`,
  });

/**
 * Rows match the write log: replaying every commit from the empty world, each
 * change replacing the value the log last published, gives exactly the
 * snapshot's rows, each at the version that last wrote it, in a registered
 * component and under its ID's table.
 */
export const checkRows = (
  image: Image,
): Result.Result<void, KernelRefusal.SnapshotRowInconsistent> => {
  const components = new Set(image.components);
  const replayed = new Map<string, { doc: StoredDocument; version: number }>();
  const key = (componentPath: string, id: string) =>
    `${componentPath}\u0000${id}`;
  for (const commit of image.state.log) {
    for (const change of commit.changes) {
      const current = replayed.get(key(change.componentPath, change.id));
      if (documentText(current?.doc ?? null) !== documentText(change.before)) {
        return Result.fail(
          rowRefusal(
            change.componentPath,
            change.id,
            "log",
            `changes at version ${commit.version} from a value the log never published`,
          ),
        );
      }
      if (change.after === null)
        replayed.delete(key(change.componentPath, change.id));
      else
        replayed.set(key(change.componentPath, change.id), {
          doc: change.after,
          version: commit.version,
        });
    }
  }
  const filed = new Set<string>();
  for (const [componentPath, byTable] of image.state.tables) {
    for (const [table, byId] of byTable) {
      for (const [id, row] of byId) {
        filed.add(key(componentPath, id));
        if (counterOf(id) === undefined || tableNameFromId(id) !== table) {
          return Result.fail(
            rowRefusal(componentPath, id, "id", `is filed under "${table}"`),
          );
        }
        if (!components.has(componentPath)) {
          return Result.fail(
            rowRefusal(
              componentPath,
              id,
              "component",
              "belongs to no component the snapshot registers",
            ),
          );
        }
        const published = replayed.get(key(componentPath, id));
        if (
          published === undefined ||
          published.version !== row.version ||
          documentText(published.doc) !== documentText(row.doc)
        ) {
          return Result.fail(
            rowRefusal(
              componentPath,
              id,
              "row",
              "is not the value at the version the write log last published for it",
            ),
          );
        }
      }
    }
  }
  for (const published of replayed.keys()) {
    if (filed.has(published)) continue;
    const [componentPath, id] = published.split("\u0000") as [string, string];
    return Result.fail(
      rowRefusal(
        componentPath,
        id,
        "row",
        "is published by the log but missing",
      ),
    );
  }
  return Result.succeed(undefined);
};

/**
 * Identity counters run ahead of every identity the state holds: the next
 * document ID past every ID's counter, the latest creation time at or past
 * every document's, a positive next attempt ID and a non-negative epoch.
 */
export const checkAllocators = (
  image: Image,
): Result.Result<void, KernelRefusal.SnapshotAllocatorBehind> => {
  let maxCounter = -1;
  let maxCreation = 0;
  const see = (doc: StoredDocument | null) => {
    if (doc === null) return;
    maxCounter = Math.max(maxCounter, counterOf(doc._id) ?? -1);
    maxCreation = Math.max(maxCreation, doc._creationTime);
  };
  for (const byTable of image.state.tables.values())
    for (const byId of byTable.values())
      for (const { doc } of byId.values()) see(doc);
  for (const { changes } of image.state.log)
    for (const { before, after } of changes) {
      see(before);
      see(after);
    }
  for (const id of image.jobs.keys())
    maxCounter = Math.max(maxCounter, counterOf(id) ?? -1);
  const { identity } = image;
  const behind = (
    allocator: KernelRefusal.SnapshotAllocatorBehind["allocator"],
    value: number,
    required: number,
  ) =>
    Result.fail(
      new KernelRefusal.SnapshotAllocatorBehind({
        allocator,
        value,
        required,
        message: `The snapshot's ${allocator} is ${value}, but its state needs at least ${required}, or the next allocation would reuse an identity it already holds.`,
      }),
    );
  if (identity.nextDocumentId <= maxCounter)
    return behind("nextDocumentId", identity.nextDocumentId, maxCounter + 1);
  if (identity.lastCreationTime < maxCreation)
    return behind("lastCreationTime", identity.lastCreationTime, maxCreation);
  if (identity.nextAttemptId < 1)
    return behind("nextAttemptId", identity.nextAttemptId, 1);
  if (identity.identityEpoch < 0)
    return behind("identityEpoch", identity.identityEpoch, 0);
  return Result.succeed(undefined);
};

/**
 * Commit timestamps strictly increase through the write log, and the latest
 * commit timestamp is the log's last, or zero before any commit.
 */
export const checkTimestamps = (
  image: Image,
): Result.Result<void, KernelRefusal.SnapshotTimestampInconsistent> => {
  let previous = 0n;
  const refuse = (version: number, commitTs: bigint, detail: string) =>
    Result.fail(
      new KernelRefusal.SnapshotTimestampInconsistent({
        version,
        commitTs: commitTs.toString(),
        message: `The snapshot's commit timestamp ${commitTs} at version ${version} ${detail}.`,
      }),
    );
  for (const { version, commitTs } of image.state.log) {
    if (commitTs <= previous)
      return refuse(version, commitTs, `is not past the previous ${previous}`);
    previous = commitTs;
  }
  if (image.state.commitTs !== previous)
    return refuse(
      image.state.version,
      image.state.commitTs,
      `is not the write log's last, ${previous}`,
    );
  return Result.succeed(undefined);
};

/**
 * Every job names a committed job row and a registered component, every job row
 * has its job, and no job is left running: a snapshot is never taken while a
 * job runs.
 */
export const checkJobs = (
  image: Image,
  table: string,
): Result.Result<void, KernelRefusal.SnapshotJobInconsistent> => {
  const refuse = (
    id: string,
    reason: KernelRefusal.SnapshotJobInconsistent["reason"],
    detail: string,
  ) =>
    Result.fail(
      new KernelRefusal.SnapshotJobInconsistent({
        id,
        reason,
        message: `The snapshot's job ${id} ${detail}.`,
      }),
    );
  const rows = new Map<string, StoredDocument>();
  for (const byTable of image.state.tables.values())
    for (const { doc } of byTable.get(table)?.values() ?? [])
      rows.set(doc._id, doc);
  const components = new Set(image.components);
  for (const [id, target] of image.jobs) {
    if (!rows.has(id)) return refuse(id, "row", "has no committed job row");
    if (!components.has(target.functionPath.componentPath))
      return refuse(
        id,
        "component",
        `targets "${target.functionPath.componentPath}", which the snapshot does not register`,
      );
  }
  for (const [id, doc] of rows) {
    if (!image.jobs.has(id as DocumentId))
      return refuse(id, "untargeted", "has a row but no target");
    if ((doc["state"] as { kind?: unknown } | undefined)?.kind === "inProgress")
      return refuse(id, "inProgress", "is recorded as running");
  }
  return Result.succeed(undefined);
};

/**
 * Check a decoded image against every rule the kernel's own exports keep,
 * before any of it is installed.
 */
export const check = (
  image: Image,
  jobTable: string,
): Result.Result<void, Inconsistency> => {
  const checks: ReadonlyArray<() => Result.Result<void, Inconsistency>> = [
    () => checkRows(image),
    () => checkAllocators(image),
    () => checkTimestamps(image),
    () => checkJobs(image, jobTable),
  ];
  for (const run of checks) {
    const checked = run();
    if (Result.isFailure(checked)) return checked;
  }
  return Result.succeed(undefined);
};

/**
 * Read snapshot bytes back into the state they encode. Bytes whose body no
 * longer hashes to their header's digest refuse with `SnapshotDigestMismatch`
 * before any of the body is read.
 */
export const decode = (
  bytes: Uint8Array,
): Result.Result<
  Image,
  KernelRefusal.SnapshotMalformed | KernelRefusal.SnapshotDigestMismatch
> => {
  const newline = bytes.indexOf(0x0a);
  const head =
    newline === -1
      ? ""
      : new TextDecoder("utf-8", { fatal: false }).decode(
          bytes.subarray(0, newline),
        );
  const expected = head.startsWith(header) ? head.slice(header.length) : "";
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    return Result.fail(
      malformed("header", `the first line is not \`${header}<sha256>\``),
    );
  }
  const bodyBytes = bytes.subarray(newline + 1);
  const actual = digestOf(bodyBytes);
  if (actual !== expected) {
    return Result.fail(
      new KernelRefusal.SnapshotDigestMismatch({
        expected,
        actual,
        message: `The snapshot's body hashes to sha256:${actual}, not the sha256:${expected} its header names. Its bytes changed after export.`,
      }),
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes),
    );
  } catch (error) {
    return Result.fail(malformed("json", String(error)));
  }
  const body = Schema.decodeUnknownResult(Body)(json);
  if (Result.isFailure(body)) {
    return Result.fail(malformed("shape", body.failure.message));
  }
  try {
    return Result.succeed(imageOf(body.success));
  } catch (error) {
    return Result.fail(
      malformed(
        "value",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
};
