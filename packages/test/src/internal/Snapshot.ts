// oxlint-disable-next-line effecttsgo/node-builtin-import -- Export is synchronous, and Effect 4.0's digests are asynchronous.
import { createHash } from "node:crypto";
import {
  Base64,
  convexToJson,
  jsonToConvex,
  type JSONValue,
  type Value,
} from "convex/values";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Kernel from "./Kernel.js";
import * as KernelRefusal from "./KernelRefusal.js";
import type * as Scheduling from "./Scheduling.js";
import * as Storage from "./Storage.js";
import {
  tableNameFromId,
  type DocumentId,
  type FunctionPath,
  type StoredDocument,
} from "./KernelValues.js";

/**
 * The counters the kernel allocates identities from: the next document ID, the
 * latest creation time handed out, the next held attempt's ID, the identity
 * epoch, which every subscriber's `authenticate` advances, the next stored
 * file's storage UUID and the next upload URL's token. A restored world
 * continues each where its source stopped, so the same calls mint the same
 * identities and the same identity versions.
 */
export interface Identity {
  readonly nextDocumentId: number;
  readonly lastCreationTime: number;
  readonly nextAttemptId: number;
  readonly identityEpoch: number;
  readonly nextFile: number;
  readonly nextUploadToken: number;
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
 * every job's target, every stored file's bytes, the clock's floor and the
 * identity counters.
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
  /**
   * The bytes, component and storage UUID of every file whose `_storage` row is
   * committed, by the row's ID.
   */
  readonly files: ReadonlyMap<DocumentId, Storage.File>;
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
 * state, of a job's target, of a stored file and of a `World` is listed here as
 * exported or excluded with its reason. The first three are checked by type: a
 * field added to `Kernel.State`, `Scheduling.Target` or `Storage.File` without
 * an entry fails to compile. A `World`'s fields are private, which no type can
 * enumerate, so `Snapshot.test.ts` compares a fresh world's own fields with
 * `world` below, and a field added without an entry fails that test.
 *
 * That test sees only the own fields a fresh world has. It cannot see state
 * created lazily after construction, held under a symbol or a `#private` name,
 * or kept in a closure or another object, as subscribers are. So every live
 * registry, state that exists only while something runs or a client is
 * attached, is also listed in `live`. `World.liveCounts` reports each one,
 * typed against `live`, and a restore refuses while any of them is non-empty,
 * so a piece of live state the snapshot does not carry fails loudly rather than
 * surviving a restore silently. A new live registry adds itself there.
 *
 * Owed by later rows, which add their state here when they land on `main`: cron
 * state (#133) and component init markers. A restore never redeclares a cron
 * and never draws a fresh random value: it installs the declared state as the
 * snapshot holds it, so a row whose state comes from a declaration or a random
 * draw exports what was declared or drawn.
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
  file: {
    componentPath: { exported: "files[].componentPath" },
    uuid: { exported: "files[].uuid" },
    bytes: { exported: "files[].bytes, base64" },
  } satisfies { readonly [K in keyof Storage.File]-?: Participation },
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
    live: {
      excluded:
        "Live registries, listed under `live` below. A world refuses to restore while any is non-empty.",
    },
    identityEpoch: { exported: "identity.identityEpoch" },
    files: { exported: "files, for every committed `_storage` row" },
    legacyIds: {
      exported:
        "files[].uuid: a restore rebuilds each storage UUID's document ID from its file",
    },
    nextFile: { exported: "identity.nextFile" },
    nextUploadToken: { exported: "identity.nextUploadToken" },
    nextErrorRequest: {
      excluded:
        "Request IDs the kernel names in an HTTP route's error body, which reach no committed state, as `requestIds` below.",
    },
    runtime: {
      excluded:
        "The driver's clock and commit timestamps. The restoring driver supplies its own.",
    },
    redaction: {
      excluded:
        "The secret policy is configuration: the restoring world is built with its own.",
    },
    secrets: {
      excluded:
        "Raw secrets are replay state and never reach an artifact. A snapshot writes markers, and a restore takes the raw values from the source's `secrets()`.",
    },
  } satisfies Readonly<Record<string, Participation>>,
  /**
   * Live registries: what blocks a snapshot while it is non-empty, and why.
   */
  live: {
    running: {
      blocks: "export and restore",
      reason:
        "Calls from the test in flight, whose effects a snapshot would split.",
    },
    walks: {
      blocks: "export and restore",
      reason: "Scheduler walks in flight, which would leave a job running.",
    },
    functions: {
      blocks: "export and restore",
      reason:
        "Function executions, nested and detached ones included, which may still write. The binary lets detached work finish within its function's lifetime, so a snapshot waits for it rather than cancel it.",
    },
    held: {
      blocks: "export and restore",
      reason: "Held attempts are running closures a snapshot does not carry.",
    },
    subscribers: {
      blocks: "restore",
      reason:
        "Live client state. A restore would rewind the identity versions an existing subscriber holds, so it needs a world with none.",
    },
  } satisfies Readonly<
    Record<
      string,
      {
        readonly blocks: "export and restore" | "restore";
        readonly reason: string;
      }
    >
  >,
  /**
   * State outside the kernel's world, live per client or per process.
   */
  outside: {
    subscriptions: {
      excluded:
        "Live client state: subscribers, their callers and runs. A restore requires a world with no subscribers (`live.subscribers`) and starts with none. Identity versions continue through `identityEpoch`.",
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
    nextFile: Schema.Int,
    nextUploadToken: Schema.Int,
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
  files: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      componentPath: Schema.String,
      uuid: Schema.String,
      // Base64, or a secret's marker in its place.
      bytes: Schema.Unknown,
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

/**
 * What an export writes for one document, before it reaches the bytes: the
 * kernel marks secrets here. `table` is the document's table.
 */
export type Redact = (
  componentPath: string,
  table: string,
  json: JSONValue,
) => JSONValue;

/**
 * What a restore reads back for one document before decoding it: the kernel
 * puts marked secrets back here.
 */
export type Unredact = (
  json: JSONValue,
) => Result.Result<JSONValue, KernelRefusal.SnapshotSecretMissing>;

const asIs: Redact = (_componentPath, _table, json) => json;

/**
 * What an export writes for a stored file's bytes: base64, or a marker the
 * kernel puts in its place.
 */
export type RedactBytes = (bytes: Uint8Array) => JSONValue;

const base64Of: RedactBytes = (bytes) => Base64.fromByteArray(bytes);

const digestOf = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Encode `image` as snapshot bytes: a header line naming the format and the
 * SHA-256 digest of the body, then the body as JSON. Components, tables, rows
 * and jobs are sorted, and every document keeps its own field order, so the
 * same state always encodes to the same bytes.
 */
export const encode = (
  image: Image,
  redact: Redact = asIs,
  redactBytes: RedactBytes = base64Of,
): Uint8Array => {
  const { state } = image;
  const encodeDocument = (
    componentPath: string,
    doc: StoredDocument | null,
  ): JSONValue | null =>
    doc === null
      ? null
      : redact(
          componentPath,
          tableNameFromId(doc._id) ?? "",
          convexToJson(doc as Value),
        );
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
          doc: encodeDocument(componentPath, row.doc),
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
      nextFile: image.identity.nextFile,
      nextUploadToken: image.identity.nextUploadToken,
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
    files: sorted(image.files, ([id]) => id).map(([id, file]) => ({
      id,
      componentPath: file.componentPath,
      uuid: file.uuid,
      bytes: redactBytes(file.bytes),
    })),
    log: state.log.map((commit) => ({
      version: commit.version,
      commitTs: commit.commitTs.toString(),
      changes: commit.changes.map((change) => ({
        componentPath: change.componentPath,
        id: change.id,
        before: encodeDocument(change.componentPath, change.before),
        after: encodeDocument(change.componentPath, change.after),
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

const decodeDocument = (
  json: unknown,
  unredact: Unredact,
): StoredDocument | null => {
  if (json === null) return null;
  const unredacted = unredact(json as JSONValue);
  if (Result.isFailure(unredacted)) throw unredacted.failure;
  const doc = jsonToConvex(unredacted.success);
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

const idOf = (doc: unknown): string => {
  const id = (doc as { readonly _id?: unknown } | null)?._id;
  return typeof id === "string" ? id : "";
};

/**
 * Why a document's system fields are not ones the kernel writes, or nothing: an
 * `_id` string and a finite, non-negative `_creationTime`.
 */
const systemFieldsProblem = (doc: unknown): string | undefined => {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc))
    return "is not an object";
  const { _id, _creationTime } = doc as {
    readonly _id?: unknown;
    readonly _creationTime?: unknown;
  };
  if (typeof _id !== "string") return "has no string `_id`";
  if (
    typeof _creationTime !== "number" ||
    !Number.isFinite(_creationTime) ||
    _creationTime < 0
  )
    return "has no finite, non-negative `_creationTime`";
  return undefined;
};

/**
 * Check the decoded body before any map is built from it, so its order cannot
 * change the result: components, tables, rows and jobs each appear once, and
 * every document carries the system fields the kernel writes.
 */
export const checkBody = (
  body: Body,
): Result.Result<
  void,
  | KernelRefusal.SnapshotMalformed
  | KernelRefusal.SnapshotRowInconsistent
  | KernelRefusal.SnapshotJobInconsistent
  | KernelRefusal.SnapshotFileInconsistent
> => {
  const once = <A>(items: ReadonlyArray<A>, key: (item: A) => string) => {
    const seen = new Set<string>();
    for (const item of items) {
      const k = key(item);
      if (seen.has(k)) return item;
      seen.add(k);
    }
    return undefined;
  };
  const component = once(body.components, (path) => path);
  if (component !== undefined)
    return Result.fail(
      malformed("duplicate", `component "${component}" appears twice`),
    );
  const twice = once(
    body.tables,
    (entry) => `${entry.componentPath}\u0000${entry.table}`,
  );
  if (twice !== undefined)
    return Result.fail(
      rowRefusal(
        twice.componentPath,
        twice.table,
        "duplicate",
        `names table "${twice.table}" twice`,
      ),
    );
  for (const { componentPath, rows } of body.tables) {
    for (const { doc } of rows) {
      const problem = systemFieldsProblem(doc);
      if (problem !== undefined)
        return Result.fail(
          rowRefusal(componentPath, idOf(doc), "systemFields", problem),
        );
    }
  }
  const byComponent = new Map<string, Array<string>>();
  for (const { componentPath, rows } of body.tables)
    byComponent.set(componentPath, [
      ...(byComponent.get(componentPath) ?? []),
      ...rows.map(({ doc }) => (doc as { _id: string })._id),
    ]);
  for (const [componentPath, ids] of byComponent) {
    const id = once(ids, (i) => i);
    if (id !== undefined)
      return Result.fail(
        rowRefusal(componentPath, id, "duplicate", "is stored twice"),
      );
  }
  for (const { changes } of body.log) {
    for (const { componentPath, id, before, after } of changes) {
      for (const doc of [before, after]) {
        if (doc === null) continue;
        const problem =
          systemFieldsProblem(doc) ??
          ((doc as { _id: unknown })._id === id
            ? undefined
            : "is logged under another ID");
        if (problem !== undefined)
          return Result.fail(
            rowRefusal(componentPath, id, "systemFields", problem),
          );
      }
    }
  }
  const file = once(body.files, ({ id }) => id);
  if (file !== undefined)
    return Result.fail(
      fileRefusal(file.componentPath, file.id, "duplicate", "appears twice"),
    );
  const job = once(body.jobs, ({ id }) => id);
  if (job !== undefined)
    return Result.fail(
      new KernelRefusal.SnapshotJobInconsistent({
        id: job.id,
        reason: "duplicate",
        message: `The snapshot's job ${job.id} appears twice.`,
      }),
    );
  return Result.succeed(undefined);
};

/**
 * `body` with every document's marked secrets put back, each document checked
 * to decode as a Convex value. No map is built, so the body checks that follow
 * see the documents as the kernel stored them, in the order they were written.
 */
const unredactBody = (
  body: Body,
  unredact: Unredact,
): Result.Result<
  Body,
  KernelRefusal.SnapshotSecretMissing | KernelRefusal.SnapshotMalformed
> => {
  let refusal:
    | KernelRefusal.SnapshotSecretMissing
    | KernelRefusal.SnapshotMalformed
    | undefined;
  const document = (json: unknown): unknown => {
    if (json === null || refusal !== undefined) return json;
    const unredacted = unredact(json as JSONValue);
    if (Result.isFailure(unredacted)) {
      refusal = unredacted.failure;
      return json;
    }
    try {
      jsonToConvex(unredacted.success);
    } catch (error) {
      refusal = malformed(
        "value",
        error instanceof Error ? error.message : String(error),
      );
    }
    return unredacted.success;
  };
  const unredacted: Body = {
    ...body,
    tables: body.tables.map((entry) => ({
      ...entry,
      rows: entry.rows.map((row) => ({ ...row, doc: document(row.doc) })),
    })),
    log: body.log.map((commit) => ({
      ...commit,
      changes: commit.changes.map((change) => ({
        ...change,
        before: document(change.before),
        after: document(change.after),
      })),
    })),
    files: body.files.map((file) => {
      if (refusal !== undefined) return file;
      const bytes = unredact(file.bytes as JSONValue);
      if (Result.isFailure(bytes)) {
        refusal = bytes.failure;
        return file;
      }
      if (typeof bytes.success !== "string") {
        refusal = malformed("value", `file ${file.id}'s bytes are not base64`);
      }
      return { ...file, bytes: bytes.success };
    }),
  };
  return refusal === undefined
    ? Result.succeed(unredacted)
    : Result.fail(refusal);
};

const imageOf = (body: Body, unredact: Unredact): Image => {
  const tables = new Map<string, Map<string, Map<DocumentId, Kernel.Row>>>();
  for (const { componentPath, table, rows } of body.tables) {
    const byTable = tables.get(componentPath) ?? new Map();
    tables.set(componentPath, byTable);
    const byId = new Map<DocumentId, Kernel.Row>();
    byTable.set(table, byId);
    for (const { version, doc } of rows) {
      const decoded = decodeDocument(doc, unredact)!;
      byId.set(decoded._id, { doc: decoded, version });
    }
  }
  const log = body.log.map((commit): Kernel.Commit => ({
    version: commit.version,
    commitTs: BigInt(commit.commitTs),
    changes: commit.changes.map((change) => ({
      componentPath: change.componentPath,
      id: change.id as DocumentId,
      before: decodeDocument(change.before, unredact),
      after: decodeDocument(change.after, unredact),
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
    files: new Map(
      body.files.map((file) => [
        file.id as DocumentId,
        {
          componentPath: file.componentPath,
          uuid: file.uuid,
          bytes: Base64.toByteArray(file.bytes as string),
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
  | KernelRefusal.SnapshotJobInconsistent
  | KernelRefusal.SnapshotFileInconsistent;

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

const fileRefusal = (
  componentPath: string,
  id: string,
  reason: KernelRefusal.SnapshotFileInconsistent["reason"],
  detail: string,
) =>
  new KernelRefusal.SnapshotFileInconsistent({
    componentPath,
    id,
    reason,
    message: `The snapshot's file ${id} in "${componentPath}" ${detail}.`,
  });

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
  let maxFile = 0;
  for (const { uuid } of image.files.values())
    maxFile = Math.max(maxFile, Storage.uuidCounter(uuid) ?? 0);
  if (identity.nextFile <= maxFile)
    return behind("nextFile", identity.nextFile, maxFile + 1);
  if (identity.nextUploadToken < 1)
    return behind("nextUploadToken", identity.nextUploadToken, 1);
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
 * Every file names a committed `_storage` row in its component, whose digest
 * and size are the file's bytes', under a storage UUID the kernel mints and no
 * other file holds, and every `_storage` row has its file.
 */
export const checkFiles = (
  image: Image,
): Result.Result<void, KernelRefusal.SnapshotFileInconsistent> => {
  const uuids = new Set<string>();
  for (const [id, file] of image.files) {
    const row = image.state.tables
      .get(file.componentPath)
      ?.get(Storage.table)
      ?.get(id)?.doc;
    if (row === undefined)
      return Result.fail(
        fileRefusal(
          file.componentPath,
          id,
          "row",
          "has no committed `_storage` row",
        ),
      );
    if (row["sha256"] !== Storage.digest(file.bytes))
      return Result.fail(
        fileRefusal(
          file.componentPath,
          id,
          "digest",
          `holds bytes whose SHA-256 is not its row's ${JSON.stringify(row["sha256"])}`,
        ),
      );
    if (row["size"] !== file.bytes.length)
      return Result.fail(
        fileRefusal(
          file.componentPath,
          id,
          "size",
          `holds ${file.bytes.length} bytes, not its row's ${JSON.stringify(row["size"])}`,
        ),
      );
    if (Storage.uuidCounter(file.uuid) === undefined || uuids.has(file.uuid))
      return Result.fail(
        fileRefusal(
          file.componentPath,
          id,
          "uuid",
          `has storage UUID "${file.uuid}", which the kernel would not mint or another file holds`,
        ),
      );
    uuids.add(file.uuid);
  }
  for (const [componentPath, byTable] of image.state.tables)
    for (const id of byTable.get(Storage.table)?.keys() ?? [])
      if (image.files.get(id)?.componentPath !== componentPath)
        return Result.fail(
          fileRefusal(componentPath, id, "untracked", "has a row but no file"),
        );
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
    () => checkFiles(image),
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
  unredact: Unredact = Result.succeed,
): Result.Result<
  Image,
  | KernelRefusal.SnapshotMalformed
  | KernelRefusal.SnapshotDigestMismatch
  | KernelRefusal.SnapshotSecretMissing
  | KernelRefusal.SnapshotRowInconsistent
  | KernelRefusal.SnapshotJobInconsistent
  | KernelRefusal.SnapshotFileInconsistent
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
  // Secrets go back first, so a document's system fields and IDs are checked as
  // the kernel stored them, and every check runs before any map is built.
  const unredacted = unredactBody(body.success, unredact);
  if (Result.isFailure(unredacted)) return Result.fail(unredacted.failure);
  const checkedBody = checkBody(unredacted.success);
  if (Result.isFailure(checkedBody)) return Result.fail(checkedBody.failure);
  try {
    return Result.succeed(imageOf(unredacted.success, Result.succeed));
  } catch (error) {
    if (Schema.is(KernelRefusal.SnapshotSecretMissing)(error)) {
      return Result.fail(error);
    }
    return Result.fail(
      malformed(
        "value",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
};
