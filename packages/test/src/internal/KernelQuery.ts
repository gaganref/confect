// Derived from convex-test 0.0.65 (index.ts, `DatabaseFake`), Copyright Convex,
// Inc., licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). The ordering, index range and
// pagination rules are convex-test's. They read a table through the attempt
// that runs the query instead of convex-test's database.

import type {
  GenericDocument,
  GenericSchema,
  SchemaDefinition,
} from "convex/server";
import {
  compareValues,
  convexToJson,
  getDocumentSize,
  jsonToConvex,
} from "convex/values";
import * as KernelRefusal from "./KernelRefusal.js";
import type {
  FilterJson,
  Index,
  SerializedQuery,
  StoredDocument,
  ValidatorJSON,
} from "./KernelValues.js";
import {
  evaluateFieldPath,
  evaluateFilter,
  evaluateRangeFilter,
  isValidIdentifier,
  resolvePendingValues,
  validateFieldNames,
  validateIndexRangeExpression,
  validateValidator,
} from "./KernelValues.js";

/**
 * A component's tables as its schema declares them.
 */
export interface KernelSchema {
  readonly schemaValidation: boolean;
  readonly tables: ReadonlyMap<
    string,
    {
      readonly indexes: ReadonlyArray<Index>;
      readonly documentType: ValidatorJSON;
    }
  >;
}

export const exportSchema = (
  schema: SchemaDefinition<GenericSchema, boolean> | null | undefined,
): KernelSchema | null => {
  if (schema === null || schema === undefined) return null;
  const exported: KernelSchema = {
    schemaValidation: (schema as unknown as { schemaValidation: boolean })
      .schemaValidation,
    tables: new Map(
      Object.entries(schema.tables).map(([name, table]) => [
        name,
        (table as unknown as { export: () => any }).export(),
      ]),
    ),
  };
  exported.tables.forEach((table, tableName) => {
    if (!isValidIdentifier(tableName)) {
      throw new Error(
        `Table names must be valid identifiers, got "${tableName}"`,
      );
    }
    validateFieldNames(table.documentType);
    table.indexes.forEach(({ indexDescriptor }) => {
      if (!isValidIdentifier(indexDescriptor)) {
        throw new Error(
          `Index names must be valid identifiers, got "${indexDescriptor}"`,
        );
      }
    });
  });
  return exported;
};

/**
 * Check a document against its table's declared type, as the backend does
 * before a write.
 */
export const validateDocument = (
  schema: KernelSchema | null,
  tableName: string,
  doc: Record<string, unknown>,
) => {
  if (schema === null || !schema.schemaValidation) return;
  const validator = schema.tables.get(tableName)?.documentType;
  if (validator === undefined) return;
  validateValidator(validator, resolvePendingValues(doc as GenericDocument));
};

/**
 * What a query reads: one table of one component, as the running attempt sees
 * it.
 */
export interface TableView {
  readonly schema: KernelSchema | null;
  readonly scan: (tableName: string) => ReadonlyArray<StoredDocument>;
}

interface ResolvedSource {
  readonly sortedDocs: ReadonlyArray<GenericDocument>;
  readonly filterFn: (doc: GenericDocument) => boolean;
  readonly limit: number | null;
  readonly fieldPathsToSortBy: ReadonlyArray<string>;
  readonly order: "asc" | "desc";
}

const resolveSource = (
  view: TableView,
  query: SerializedQuery,
): ResolvedSource => {
  const source = query.source;
  let docs: Array<GenericDocument>;
  let fieldPathsToSortBy: Array<string>;
  let order: "asc" | "desc";
  switch (source.type) {
    case "FullTableScan": {
      docs = [...view.scan(source.tableName)];
      order = source.order ?? "asc";
      fieldPathsToSortBy = ["_creationTime"];
      break;
    }
    case "IndexRange": {
      const [tableName, indexName] = source.indexName.split(".") as [
        string,
        string,
      ];
      order = source.order ?? "asc";
      let fields: Array<string>;
      if (indexName === "by_creation_time") {
        fields = ["_creationTime", "_id"];
      } else if (indexName === "by_id") {
        fields = ["_id"];
      } else {
        const index = view.schema?.tables
          .get(tableName)
          ?.indexes.find(
            ({ indexDescriptor }) => indexDescriptor === indexName,
          );
        if (index === undefined) {
          throw new Error(
            `Cannot use index "${indexName}" for table "${tableName}" because ` +
              `it is not declared in the schema.`,
          );
        }
        fields = index.fields.concat(["_creationTime", "_id"]);
      }
      fieldPathsToSortBy = fields;
      validateIndexRangeExpression(source, fields);
      docs = view
        .scan(tableName)
        .filter((doc) =>
          source.range.every((filter) => evaluateRangeFilter(doc, filter)),
        );
      break;
    }
    case "Search": {
      throw KernelRefusal.requiresBinary("textSearch");
    }
  }

  const filters = query.operators
    .filter(
      (operator): operator is { filter: FilterJson } => "filter" in operator,
    )
    .map((operator) => operator.filter);
  const limit =
    query.operators.find(
      (operator): operator is { limit: number } => "limit" in operator,
    ) ?? null;

  const orderMultiplier = order === "asc" ? 1 : -1;
  docs.sort((a, b) => {
    for (const fp of fieldPathsToSortBy) {
      const v = compareValues(
        evaluateFieldPath(fp, a),
        evaluateFieldPath(fp, b),
      );
      if (v !== 0) return v * orderMultiplier;
    }
    return 0;
  });

  return {
    sortedDocs: docs,
    filterFn: (doc) => filters.every((f) => evaluateFilter(doc, f)),
    limit: limit?.limit ?? null,
    fieldPathsToSortBy,
    order,
  };
};

/**
 * A query's documents in order. The source is read when the query starts, as a
 * snapshot, and consumed lazily.
 */
export const stream = (
  view: TableView,
  query: SerializedQuery,
): Iterator<GenericDocument> => {
  const { sortedDocs, filterFn, limit } = resolveSource(view, query);
  return (function* () {
    let returned = 0;
    for (const doc of sortedDocs) {
      if (limit !== null && returned >= limit) return;
      if (filterFn(doc)) {
        returned++;
        yield doc;
      }
    }
  })();
};

const encodeCursor = (
  doc: GenericDocument,
  fieldPaths: ReadonlyArray<string>,
): string =>
  JSON.stringify(
    fieldPaths.map((fp) => {
      const k = evaluateFieldPath(fp, doc);
      return k === undefined ? null : JSON.stringify(convexToJson(k));
    }),
  );

const parseCursor = (c: string | null | undefined) =>
  c
    ? (JSON.parse(c) as Array<string | null>).map((k) =>
        k === null ? undefined : jsonToConvex(JSON.parse(k)),
      )
    : null;

const compareToCursor = (
  doc: GenericDocument,
  cursorKeys: ReadonlyArray<unknown>,
  fieldPaths: ReadonlyArray<string>,
  order: "asc" | "desc",
): number => {
  const orderMultiplier = order === "asc" ? 1 : -1;
  for (let i = 0; i < fieldPaths.length; i++) {
    const cmp = compareValues(
      evaluateFieldPath(fieldPaths[i]!, doc),
      cursorKeys[i] as any,
    );
    if (cmp !== 0) return cmp * orderMultiplier;
  }
  return 0;
};

export interface PageRequest {
  readonly query: SerializedQuery;
  readonly cursor: string | null;
  readonly endCursor?: string | null;
  readonly pageSize: number;
  readonly maximumRowsRead?: number | null;
  readonly maximumBytesRead?: number | null;
}

export const paginate = (
  view: TableView,
  {
    query,
    cursor,
    endCursor,
    pageSize,
    maximumRowsRead,
    maximumBytesRead,
  }: PageRequest,
) => {
  const { sortedDocs, filterFn, fieldPathsToSortBy, order } = resolveSource(
    view,
    query,
  );
  const cursorFields = fieldPathsToSortBy.includes("_id")
    ? fieldPathsToSortBy
    : [...fieldPathsToSortBy, "_id"];
  const cursorKeys = cursor !== "_end_cursor" ? parseCursor(cursor) : null;
  const hasEndBoundary = !!endCursor && endCursor !== "_end_cursor";
  const endCursorKeys = hasEndBoundary ? parseCursor(endCursor) : null;

  const page: Array<GenericDocument> = [];
  let isInPage = cursor === null;
  let continueCursor = "_end_cursor";
  let splitCursor: string | null = null;
  let pageStatus: "SplitRecommended" | "SplitRequired" | null = null;
  let rowsRead = 0;
  let bytesRead = 0;
  const readDocCursors: Array<string> = [];

  for (let i = 0; i < sortedDocs.length; i++) {
    const doc = sortedDocs[i]!;
    const isLastDoc = i === sortedDocs.length - 1;
    if (!isInPage) {
      if (cursor === "_end_cursor") continue;
      if (cursorKeys) {
        if (compareToCursor(doc, cursorKeys, cursorFields, order) > 0) {
          isInPage = true;
        } else {
          continue;
        }
      }
    }
    if (hasEndBoundary && endCursorKeys) {
      const cmp = compareToCursor(doc, endCursorKeys, cursorFields, order);
      if (cmp >= 0) {
        if (cmp === 0) {
          rowsRead += 1;
          bytesRead += getDocumentSize(doc);
          readDocCursors.push(encodeCursor(doc, cursorFields));
          if (filterFn(doc)) page.push(doc);
          continueCursor = encodeCursor(doc, cursorFields);
        }
        break;
      }
    }
    rowsRead += 1;
    bytesRead += getDocumentSize(doc);
    readDocCursors.push(encodeCursor(doc, cursorFields));
    const hitLimit =
      (!!maximumRowsRead && rowsRead >= maximumRowsRead) ||
      (!!maximumBytesRead && bytesRead >= maximumBytesRead);
    if (filterFn(doc)) page.push(doc);
    if (hitLimit) {
      pageStatus = "SplitRequired";
      continueCursor = encodeCursor(doc, cursorFields);
      break;
    }
    if (!endCursor && page.length >= pageSize) {
      if (!isLastDoc) continueCursor = encodeCursor(doc, cursorFields);
      break;
    }
  }

  if (pageStatus === "SplitRequired" && readDocCursors.length >= 2) {
    splitCursor = readDocCursors[Math.floor((readDocCursors.length - 1) / 2)]!;
  } else if (
    pageStatus === null &&
    rowsRead > pageSize + 1 &&
    readDocCursors.length >= 2
  ) {
    pageStatus = "SplitRecommended";
    splitCursor = readDocCursors[Math.floor((readDocCursors.length - 1) / 2)]!;
  }

  return {
    page,
    isDone: continueCursor === "_end_cursor",
    continueCursor,
    splitCursor,
    pageStatus,
  };
};
