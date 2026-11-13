// oxlint-disable-next-line effecttsgo/node-builtin-import -- Export is synchronous, and Effect 4.0's digests are asynchronous.
import { createHash } from "node:crypto";
import {
  convexToJson,
  jsonToConvex,
  type JSONValue,
  type Value,
} from "convex/values";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Kernel from "./Kernel.js";
import * as KernelRefusal from "./KernelRefusal.js";
import {
  tableNameFromId,
  type DocumentId,
  type FunctionPath,
  type StoredDocument,
} from "./KernelValues.js";

/**
 * The counters the kernel allocates identities from: the next document ID, the
 * latest creation time handed out, and the next held attempt's ID. A restored
 * world continues each where its source stopped, so the same calls mint the
 * same identities.
 */
export interface Identity {
  readonly nextDocumentId: number;
  readonly lastCreationTime: number;
  readonly nextAttemptId: number;
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

const digestOf = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Encode `image` as snapshot bytes: a header line naming the format and the
 * SHA-256 digest of the body, then the body as JSON. Components, tables, rows
 * and jobs are sorted, and every document keeps its own field order, so the
 * same state always encodes to the same bytes.
 */
export const encode = (image: Image, redact: Redact = asIs): Uint8Array => {
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
  };
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
    return Result.succeed(imageOf(body.success, unredact));
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
