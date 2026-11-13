import * as DatabaseSchema from "@confect/server/DatabaseSchema";
import { convexToJson, type JSONValue, type Value } from "convex/values";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as KernelRefusal from "./KernelRefusal.js";
import type { FunctionPath } from "./KernelValues.js";

/**
 * A path into an encoded value: object field names and array indexes, with `*`
 * for every element of an array or every value of a record.
 */
export type Path = ReadonlyArray<string>;

const every = "*";

/**
 * What a marker writes in place of a secret in text and in values: a failure
 * report, a diff.
 */
export const marker = "[redacted]";

/**
 * The key of a snapshot's marker object, `{ "$redacted": <ref> }`. Convex's
 * encoded JSON allows no object key that starts with `$`, so no stored value
 * reads as a marker.
 */
export const markerKey = "$redacted";

/**
 * A secret shorter than this is marked only where a secret schema node puts it.
 * Searching every string for it would mark text that merely shares a few
 * letters.
 */
const searchableLength = 4;

const isSecretNode = (ast: SchemaAST.AST): boolean =>
  ast._tag === "Declaration" &&
  (SchemaAST.resolve(ast)?.["representation"] as { id?: unknown } | undefined)
    ?.id === "effect/schema/Redacted";

/**
 * Every path at which `schema` holds a secret: a `Schema.Redacted` node, which
 * `Schema.RedactedFromValue` decodes to. The paths address the encoded value
 * the kernel stores and passes, whose fields keep the schema's names.
 */
export const secretPaths = (schema: Schema.Top): ReadonlyArray<Path> => {
  const paths: Array<Path> = [];
  const seen = new Set<SchemaAST.AST>();
  const walk = (ast: SchemaAST.AST, path: Path) => {
    if (seen.has(ast)) return;
    if (isSecretNode(ast)) {
      paths.push(path);
      return;
    }
    switch (ast._tag) {
      case "Objects":
        for (const property of ast.propertySignatures)
          walk(property.type, [...path, String(property.name)]);
        for (const index of ast.indexSignatures)
          walk(index.type, [...path, every]);
        return;
      case "Arrays":
        ast.elements.forEach((element, i) => walk(element, [...path, `${i}`]));
        for (const rest of ast.rest) walk(rest, [...path, every]);
        return;
      case "Union":
        for (const member of ast.types) walk(member, path);
        return;
      case "Suspend":
        seen.add(ast);
        walk(ast.thunk(), path);
        return;
      default:
        return;
    }
  };
  walk(schema.ast, []);
  return paths;
};

/**
 * Which values the kernel treats as secret: at paths in a table's documents, in
 * a function's arguments and in its return value.
 */
export interface Policy {
  readonly table: (componentPath: string, table: string) => ReadonlyArray<Path>;
  readonly args: (functionPath: FunctionPath) => ReadonlyArray<Path>;
  readonly returns: (functionPath: FunctionPath) => ReadonlyArray<Path>;
}

/**
 * A schema the policy builds the first time it needs its paths, as Confect's
 * specs and tables keep theirs.
 */
export type Lazy = () => Schema.Top;

/**
 * The schemas a policy reads its secret nodes from, by component path, then
 * table name or `module:export`.
 */
export interface Declared {
  readonly tables?: Readonly<Record<string, Readonly<Record<string, Lazy>>>>;
  readonly functions?: Readonly<
    Record<
      string,
      Readonly<
        Record<string, { readonly args?: Lazy; readonly returns?: Lazy }>
      >
    >
  >;
}

const memo = <A>(compute: (key: string) => A) => {
  const cache = new Map<string, A>();
  return (key: string): A => {
    if (!cache.has(key)) cache.set(key, compute(key));
    return cache.get(key)!;
  };
};

/**
 * A policy from `declared`'s schemas. Each schema is built and walked the first
 * time its paths are asked for.
 */
export const policy = (declared: Declared): Policy => {
  const split = (key: string) => key.split("\u0000") as [string, string];
  const table = memo((key) => {
    const [componentPath, name] = split(key);
    const schema = declared.tables?.[componentPath]?.[name];
    return schema === undefined ? [] : secretPaths(schema());
  });
  const fn = (part: "args" | "returns") =>
    memo((key) => {
      const [componentPath, udfPath] = split(key);
      const schema = declared.functions?.[componentPath]?.[udfPath]?.[part];
      return schema === undefined ? [] : secretPaths(schema());
    });
  const args = fn("args");
  const returns = fn("returns");
  return {
    table: (componentPath, name) => table(`${componentPath}\u0000${name}`),
    args: ({ componentPath, udfPath }) =>
      args(`${componentPath}\u0000${udfPath}`),
    returns: ({ componentPath, udfPath }) =>
      returns(`${componentPath}\u0000${udfPath}`),
  };
};

export const none: Policy = policy({});

/**
 * A Confect database schema's tables, as a policy's `tables` entry for one
 * component. No table's schema is built until the kernel asks for its paths.
 */
export const tablesOf = (
  databaseSchema: DatabaseSchema.AnyWithProps,
): Readonly<Record<string, Lazy>> =>
  Object.fromEntries(
    Object.values(DatabaseSchema.tables(databaseSchema)).map(
      (table: { readonly tableName: string; readonly Fields: Schema.Top }) => [
        table.tableName,
        () => table.Fields,
      ],
    ),
  );

/**
 * The raw secrets the kernel has seen under a secret node, in the order it
 * first saw each. This store is replay state: it lives in memory beside the
 * world and is never written to an artifact. A snapshot's markers name entries
 * here by position.
 */
export class Secrets {
  private readonly values: Array<JSONValue> = [];
  private readonly refs = new Map<string, number>();

  /**
   * Keep `value` and answer its position. A value kept before answers its first
   * position.
   */
  keep(value: JSONValue): number {
    const key = JSON.stringify(value);
    const known = this.refs.get(key);
    if (known !== undefined) return known;
    this.values.push(value);
    this.refs.set(key, this.values.length - 1);
    return this.values.length - 1;
  }

  raw(ref: number): JSONValue | undefined {
    return this.values[ref];
  }

  /**
   * The kept strings long enough to search for, longest first, so a secret
   * inside another is never marked half.
   */
  searchable(): ReadonlyArray<string> {
    return this.values
      .filter(
        (value): value is string =>
          typeof value === "string" && value.length >= searchableLength,
      )
      .sort((a, b) => b.length - a.length);
  }

  copy(): Secrets {
    const copy = new Secrets();
    for (const value of this.values) copy.keep(value);
    return copy;
  }
}

const isRecord = (json: JSONValue): json is { [key: string]: JSONValue } =>
  typeof json === "object" && json !== null && !Array.isArray(json);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  Object.getPrototypeOf(value) === Object.prototype;

/**
 * Every value of a Convex value at `path`, before it is encoded or validated.
 */
const valuesAt = (value: unknown, path: Path): Array<unknown> => {
  if (path.length === 0) return value === undefined ? [] : [value];
  const [head, ...rest] = path as [string, ...Array<string>];
  if (Array.isArray(value)) {
    return head === every
      ? value.flatMap((item) => valuesAt(item, rest))
      : valuesAt(value[Number(head)], rest);
  }
  if (isPlainObject(value)) {
    return head === every
      ? Object.values(value).flatMap((item) => valuesAt(item, rest))
      : valuesAt(value[head], rest);
  }
  return [];
};

/**
 * Keep every value of `value` at `paths` in `secrets`. The kernel keeps a
 * function's arguments and a document's fields before it validates them, so a
 * validation error can already mark them.
 */
export const keep = (
  value: unknown,
  paths: ReadonlyArray<Path>,
  secrets: Secrets,
): void => {
  for (const path of paths) {
    for (const found of valuesAt(value, path)) {
      try {
        secrets.keep(convexToJson(found as Value));
      } catch {
        // A value Convex cannot encode is never stored or passed, so it
        // reaches no artifact as a value.
      }
    }
  }
};

const replaceAt = (
  json: JSONValue,
  path: Path,
  replace: (value: JSONValue) => JSONValue,
): JSONValue => {
  if (path.length === 0) return replace(json);
  const [head, ...rest] = path as [string, ...Array<string>];
  if (Array.isArray(json)) {
    return json.map((item, i) =>
      head === every || head === `${i}` ? replaceAt(item, rest, replace) : item,
    );
  }
  if (isRecord(json)) {
    return Object.fromEntries(
      Object.entries(json).map(([key, item]) => [
        key,
        head === every || head === key ? replaceAt(item, rest, replace) : item,
      ]),
    );
  }
  return json;
};

const containsSecret = (text: string, secrets: ReadonlyArray<string>) =>
  secrets.some((secret) => text.includes(secret));

/**
 * `json`, a value bound for an artifact, with each value at `paths` and each
 * string holding a kept secret replaced by a marker that names the raw value's
 * position in `secrets`. The raw values are kept there, so the artifact can be
 * read back by whoever holds the store.
 */
export const mark = (
  json: JSONValue,
  paths: ReadonlyArray<Path>,
  secrets: Secrets,
): JSONValue => {
  const toMarker = (value: JSONValue): JSONValue => ({
    [markerKey]: secrets.keep(value),
  });
  const pathMarked = paths.reduce(
    (marked, path) => replaceAt(marked, path, toMarker),
    json,
  );
  const searchable = secrets.searchable();
  if (searchable.length === 0) return pathMarked;
  const strings = (value: JSONValue): JSONValue => {
    if (typeof value === "string")
      return containsSecret(value, searchable) ? toMarker(value) : value;
    if (Array.isArray(value)) return value.map(strings);
    if (isRecord(value)) {
      if (markerKey in value) return value;
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, strings(item)]),
      );
    }
    return value;
  };
  return strings(pathMarked);
};

/**
 * `json` with each marker replaced by the raw value it names in `secrets`, or
 * `SnapshotSecretMissing` for the first marker the store cannot answer.
 */
export const unmark = (
  json: JSONValue,
  secrets: Secrets,
): Result.Result<JSONValue, KernelRefusal.SnapshotSecretMissing> => {
  let missing: unknown = undefined;
  const walk = (value: JSONValue): JSONValue => {
    if (Array.isArray(value)) return value.map(walk);
    if (!isRecord(value)) return value;
    if (markerKey in value) {
      const ref = value[markerKey];
      const raw = typeof ref === "number" ? secrets.raw(ref) : undefined;
      if (raw === undefined) missing ??= ref;
      return raw ?? null;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, walk(item)]),
    );
  };
  const unmarked = walk(json);
  return missing === undefined
    ? Result.succeed(unmarked)
    : Result.fail(
        new KernelRefusal.SnapshotSecretMissing({
          ref: JSON.stringify(missing),
          message: `The snapshot marks a secret at ${JSON.stringify(missing)}, which the secrets passed to restore do not hold. Restore with the secrets of the backend that exported it.`,
        }),
      );
};

/**
 * `text` with every kept secret, raw or as it appears inside a JSON string,
 * replaced by the marker.
 */
export const scrubText = (text: string, secrets: Secrets): string =>
  secrets.searchable().reduce((scrubbed, secret) => {
    const escaped = JSON.stringify(secret).slice(1, -1);
    return scrubbed.split(secret).join(marker).split(escaped).join(marker);
  }, text);

/**
 * `value` with every string that holds a kept secret replaced by the marker.
 */
export const scrubValue = (value: Value, secrets: Secrets): Value => {
  const searchable = secrets.searchable();
  if (searchable.length === 0) return value;
  const walk = (v: Value): Value => {
    if (typeof v === "string")
      return containsSecret(v, searchable) ? marker : v;
    if (Array.isArray(v)) return v.map(walk);
    if (isPlainObject(v)) {
      return Object.fromEntries(
        Object.entries(v).map(([key, item]) => [key, walk(item as Value)]),
      );
    }
    return v;
  };
  return walk(value);
};
