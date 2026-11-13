import { compareValues, type Value } from "convex/values";
import type {
  DocumentId,
  SerializedRangeExpression,
  StoredDocument,
} from "./KernelValues.js";
import {
  evaluateFieldPath,
  evaluateRangeFilter,
  tableNameFromId,
} from "./KernelValues.js";
import * as Array from "effect/Array";

/**
 * A row's position in an interval's order: its value at each of the interval's
 * fields.
 */
export type Key = ReadonlyArray<Value | undefined>;

/**
 * A read of one document by ID. It records the document's absence as well as
 * its presence, so a commit that creates the document invalidates it.
 */
export interface DocumentRead {
  readonly kind: "document";
  readonly componentPath: string;
  readonly id: DocumentId;
}

/**
 * A read of an ordered interval of one table.
 *
 * `fields` is the sort key: an index's fields, then the tie-breakers
 * `_creationTime` and `_id`. `range` is the index range expression, whose `Gt`
 * and `Lt` bounds are exclusive and `Gte` and `Lte` inclusive. `after` is an
 * exclusive start in `order`, a page's cursor. `through` is how far the query
 * examined, inclusive: nothing yet, up to a key, or to the end of the range. An
 * empty result reads to the end, so it still covers an insert into the range.
 *
 * Only the attempt that owns the read advances `through`.
 */
export interface IntervalRead {
  readonly kind: "interval";
  readonly componentPath: string;
  readonly table: string;
  readonly fields: ReadonlyArray<string>;
  readonly order: "asc" | "desc";
  readonly range: ReadonlyArray<SerializedRangeExpression>;
  readonly after: Key | null;
  through: Key | "end" | null;
}

export type Read = DocumentRead | IntervalRead;

/**
 * Where `doc` sorts against `key` in the interval's order.
 */
export const compareToKey = (
  fields: ReadonlyArray<string>,
  order: "asc" | "desc",
  doc: StoredDocument,
  key: Key,
): number => {
  const direction = order === "asc" ? 1 : -1;
  for (let i = 0; i < fields.length; i++) {
    const cmp = compareValues(
      evaluateFieldPath(fields[i]!, doc),
      key[i] as Value,
    );
    if (cmp !== 0) return cmp * direction;
  }
  return 0;
};

export const keyOf = (
  fields: ReadonlyArray<string>,
  doc: StoredDocument,
): Key => Array.map(fields, (field) => evaluateFieldPath(field, doc));

const inInterval = (read: IntervalRead, doc: StoredDocument): boolean =>
  read.through !== null &&
  Array.every(read.range, (filter) => evaluateRangeFilter(doc, filter)) &&
  (read.after === null ||
    compareToKey(read.fields, read.order, doc, read.after) > 0) &&
  (read.through === "end" ||
    compareToKey(read.fields, read.order, doc, read.through) <= 0);

/**
 * Whether a commit's change to one document invalidates `read`: it wrote the
 * document read by ID, or the document entered or left the interval.
 */
export const covers = (
  read: Read,
  change: {
    readonly componentPath: string;
    readonly id: DocumentId;
    readonly before: StoredDocument | null;
    readonly after: StoredDocument | null;
  },
): boolean => {
  if (read.componentPath !== change.componentPath) return false;
  if (read.kind === "document") return read.id === change.id;
  return (
    tableNameFromId(change.id) === read.table &&
    Array.some(
      [change.before, change.after],
      (doc) => doc !== null && inInterval(read, doc),
    )
  );
};
