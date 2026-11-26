import * as SecretSchema from "@confect/core/SecretSchema";
import * as DatabaseSchema from "@confect/server/DatabaseSchema";
import {
  Base64,
  convexToJson,
  jsonToConvex,
  type JSONValue,
  type Value,
} from "convex/values";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as KernelRefusal from "./KernelRefusal.js";
import type { FunctionPath } from "./KernelValues.js";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Json from "./Json.js";

/**
 * What a marker writes in place of a secret in text and in values: a failure
 * report, a diff, a read record.
 */
export const marker = "[redacted]";

/**
 * The key of a snapshot's marker object, `{ "$redacted": <ref> }`. Convex's
 * encoded JSON allows no object key that starts with `$`, so no stored value
 * reads as a marker.
 */
export const markerKey = "$redacted";

/**
 * Free text has no schema, so a failure report's message and stack are searched
 * for every kept secret string. A string shorter than this is not searched for,
 * or text that merely shares a few letters would be marked. Values are marked
 * by their schema at any length.
 */
const searchableLength = 4;

/**
 * Where a value may hold secrets: a schema's AST, read on its type side, with
 * the encodings that take each node to its stored form. A walk follows it
 * through the stored value, so the value bounds the walk.
 */
export type Shape = SchemaAST.AST;

/**
 * A shape placed at a path inside a value: a table's schema at a document's
 * root, a job's target arguments at its row's `args.0`.
 */
export interface Placement {
  readonly at: ReadonlyArray<string>;
  readonly shape: Shape;
}

const { isSecretNode } = SecretSchema;

/**
 * Whether `shape` holds a secret anywhere beneath it, by the walk codegen's
 * secret policy reads too.
 */
export const hasSecret: (shape: Shape) => boolean = SecretSchema.hasSecret;

const isObject = (json: JSONValue): json is { [key: string]: JSONValue } =>
  typeof json === "object" && json !== null && !Arr.isArray(json);

/**
 * A Convex encoded leaf, such as `{"$integer": …}` or `{"$bytes": …}`, or a
 * marker: one key that starts with `$`.
 */
const isWrapped = (json: JSONValue): boolean => {
  if (!isObject(json)) return false;
  const keys = Rec.keys(json);
  return keys.length === 1 && pipe(keys[0]!, Str.startsWith("$"));
};

const isMarker = (json: JSONValue): boolean =>
  isObject(json) && Rec.keys(json).length === 1 && markerKey in json;

const isRecord = (json: JSONValue): json is { [key: string]: JSONValue } =>
  isObject(json) && !isWrapped(json);

/**
 * Whether `json` cannot be a value `ast` stores as. `ast` is a union member's
 * encoded side, as `SchemaAST.toEncoded` gives it, which every encode checks
 * its output against. Only a JSON kind, a present field or a literal that the
 * encoded side rules out answers `true`. A check, a declaration, a number
 * Convex writes as `$float` beside a number literal, and every node the shape
 * cannot settle answer `false`.
 */
export const rulesOut = (
  ast: SchemaAST.AST,
  json: JSONValue,
  ancestry: Set<SchemaAST.AST> = new Set(),
): boolean => {
  switch (ast._tag) {
    case "Objects":
      return (
        !isRecord(json) ||
        Arr.some(
          ast.propertySignatures,
          (p) =>
            typeof p.name === "string" &&
            Rec.has(json, p.name) &&
            rulesOut(p.type, json[p.name]!),
        )
      );
    case "Arrays":
      return !Arr.isArray(json);
    case "String":
    case "TemplateLiteral":
      return typeof json !== "string";
    case "Number":
      return typeof json !== "number" && !(isObject(json) && "$float" in json);
    case "BigInt":
      return !(isObject(json) && "$integer" in json);
    case "Boolean":
      return typeof json !== "boolean";
    case "Null":
      return json !== null;
    case "Literal":
      if (typeof ast.literal === "bigint")
        return !(isObject(json) && "$integer" in json);
      if (typeof ast.literal === "number" && isObject(json) && "$float" in json)
        return false;
      return json !== ast.literal;
    case "Union":
      return Arr.every(ast.types, (t) => rulesOut(t, json, ancestry));
    case "Suspend": {
      if (ancestry.has(ast)) return false;
      ancestry.add(ast);
      const out = rulesOut(ast.thunk(), json, ancestry);
      ancestry.delete(ast);
      return out;
    }
    default:
      return false;
  }
};

/**
 * Where a value holds secrets: `true` for the whole value, or the marks of some
 * of its entries, by key or array index.
 */
type Marks = true | ReadonlyMap<string, Marks>;

/**
 * All of `marks` as one: a whole mark wins over a partial one, and partial
 * marks merge entry by entry.
 */
const join = (marks: ReadonlyArray<Marks | undefined>): Marks | undefined =>
  Arr.reduce(marks, undefined as Marks | undefined, (joined, next) => {
    if (joined === undefined) return next;
    if (next === undefined) return joined;
    if (joined === true || next === true) return true;
    const merged = new Map(joined);
    for (const [key, entry] of next) {
      merged.set(key, join([merged.get(key), entry])!);
    }
    return merged;
  });

/**
 * The marks of a value's entries, keeping each entry that marks something, or
 * none when no entry does.
 */
const entryMarks = (
  marked: ReadonlyArray<readonly [string, Marks | undefined]>,
): Marks | undefined => {
  const some = Arr.filter(
    marked,
    (entry): entry is readonly [string, Marks] => entry[1] !== undefined,
  );
  return some.length === 0 ? undefined : new Map(some);
};

/**
 * Where `shape` puts a secret in `json`. The walk follows a node's structure
 * only where that structure is the stored one. A node that holds a secret is
 * marked whole when its stored form is something else, such as an encoding, a
 * declaration or a value of another kind: the walk fails closed. Each union
 * member that `json` could have come from is walked on `json` itself, and their
 * marks join. A marker is never walked again, so marking is idempotent.
 */
const marksOf = (
  shape: SchemaAST.AST,
  json: JSONValue,
  unconsumed: Set<SchemaAST.AST> = new Set(),
): Marks | undefined => {
  if (isMarker(json)) return undefined;
  if (isSecretNode(shape)) return true;
  if (!hasSecret(shape)) return undefined;
  // An encoding, such as renamed keys or a JSON string, stores the node in a
  // form its own structure does not describe.
  if (shape.encoding !== undefined) return true;
  switch (shape._tag) {
    case "Objects": {
      if (!isRecord(json)) return true;
      const named = new Map(
        Arr.map(shape.propertySignatures, (p) => [String(p.name), p.type]),
      );
      return entryMarks(
        Arr.map(Rec.toEntries(json), ([key, item]) => {
          const type = named.get(key);
          return [
            key,
            type !== undefined
              ? marksOf(type, item)
              : join(
                  Arr.map(shape.indexSignatures, (index) =>
                    marksOf(index.type, item),
                  ),
                ),
          ] as const;
        }),
      );
    }
    case "Arrays": {
      if (!Arr.isArray(json)) return true;
      const [rest, ...post] = shape.rest;
      return entryMarks(
        Arr.map(json, (item, i) => {
          const fromEnd = json.length - i;
          const type =
            i < shape.elements.length
              ? shape.elements[i]
              : fromEnd <= post.length
                ? post[post.length - fromEnd]
                : rest;
          return [
            `${i}`,
            type === undefined ? undefined : marksOf(type, item),
          ] as const;
        }),
      );
    }
    case "Union": {
      const sources = Arr.filter(
        shape.types,
        (member) => !rulesOut(SchemaAST.toEncoded(member), json),
      );
      return sources.length === 0
        ? true
        : join(Arr.map(sources, (member) => marksOf(member, json, unconsumed)));
    }
    case "Suspend": {
      if (unconsumed.has(shape)) return undefined;
      unconsumed.add(shape);
      const marks = marksOf(shape.thunk(), json, unconsumed);
      unconsumed.delete(shape);
      return marks;
    }
    default:
      return true;
  }
};

/**
 * The marks of `shape` placed at `at` inside `json`, or none when `json` holds
 * nothing there.
 */
const placedMarks = (
  json: JSONValue,
  at: ReadonlyArray<string>,
  shape: Shape,
): Marks | undefined => {
  if (at.length === 0) return marksOf(shape, json);
  const [head, ...rest] = at as [string, ...Array<string>];
  const item = Arr.isArray(json)
    ? Option.getOrUndefined(Arr.findFirst(json, (_, i) => `${i}` === head))
    : isRecord(json) && Rec.has(json, head)
      ? json[head]
      : undefined;
  const marks = item === undefined ? undefined : placedMarks(item, rest, shape);
  return marks === undefined ? undefined : new Map([[head, marks]]);
};

/**
 * `json` with `onSecret` applied at every position `marks` names.
 */
const apply = (
  json: JSONValue,
  marks: Marks | undefined,
  onSecret: (value: JSONValue) => JSONValue,
): JSONValue => {
  if (marks === undefined) return json;
  if (marks === true) return onSecret(json);
  if (Arr.isArray(json))
    return Arr.map(json, (item, i) => apply(item, marks.get(`${i}`), onSecret));
  if (!isObject(json)) return json;
  return Rec.fromEntries(
    Arr.map(Rec.toEntries(json), ([key, item]) => [
      key,
      apply(item, marks.get(key), onSecret),
    ]),
  );
};

/**
 * `json` with `onSecret` applied at every position where `placements` put a
 * secret. Every placement reads `json` as it is, so one placement's marks never
 * change what another reads.
 */
const walkPlaced = (
  json: JSONValue,
  placements: ReadonlyArray<Placement>,
  onSecret: (value: JSONValue) => JSONValue,
): JSONValue =>
  apply(
    json,
    join(Arr.map(placements, ({ at, shape }) => placedMarks(json, at, shape))),
    onSecret,
  );

/**
 * Whether the field at `fieldPath` of a document of `shape` holds a secret, or
 * sits under one.
 */
export const sensitiveAt = (
  shape: Shape,
  fieldPath: ReadonlyArray<string>,
): boolean => {
  const at = (
    ast: SchemaAST.AST,
    path: ReadonlyArray<string>,
    ancestry: Set<SchemaAST.AST>,
  ): boolean => {
    if (isSecretNode(ast)) return true;
    if (path.length === 0) return hasSecret(ast);
    const [head, ...rest] = path as [string, ...Array<string>];
    switch (ast._tag) {
      case "Objects": {
        const property = Option.getOrUndefined(
          Arr.findFirst(ast.propertySignatures, (p) => String(p.name) === head),
        );
        // A segment is consumed here, so a suspension met again further down
        // the path is a new descent, not a cycle.
        return property !== undefined
          ? at(property.type, rest, new Set())
          : Arr.some(ast.indexSignatures, (i) => at(i.type, rest, new Set()));
      }
      case "Union":
        return Arr.some(ast.types, (t) => at(t, path, ancestry));
      case "Declaration":
        return Arr.some(ast.typeParameters, (t) => at(t, path, ancestry));
      case "Suspend": {
        if (ancestry.has(ast)) return false;
        ancestry.add(ast);
        const found = at(ast.thunk(), path, ancestry);
        ancestry.delete(ast);
        return found;
      }
      default:
        return hasSecret(ast);
    }
  };
  return at(shape, fieldPath, new Set());
};

/**
 * Which values the kernel treats as secret: the shapes of a table's documents,
 * of a function's arguments and of its return value.
 */
export interface Policy {
  readonly table: (componentPath: string, table: string) => Shape | undefined;
  readonly args: (functionPath: FunctionPath) => Shape | undefined;
  readonly returns: (functionPath: FunctionPath) => Shape | undefined;
}

/**
 * A schema the policy builds the first time it needs it, as Confect's specs and
 * tables keep theirs.
 */
export type Lazy = () => Schema.Top;

/**
 * The schemas a policy reads its secret nodes from, by component path, then
 * table name or `module:export`. Row 8's codegen fills this from the Confect
 * specs. A test that declares it by hand writes the same record.
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
 * A policy from `declared`'s schemas. Each schema is built the first time its
 * shape is asked for.
 */
export const policy = (declared: Declared): Policy => {
  const split = (key: string) =>
    pipe(key, Str.split("\u0000")) as [string, string];
  const table = memo((key) => {
    const [componentPath, name] = split(key);
    return declared.tables?.[componentPath]?.[name]?.().ast;
  });
  const fn = (part: "args" | "returns") =>
    memo((key) => {
      const [componentPath, udfPath] = split(key);
      return declared.functions?.[componentPath]?.[udfPath]?.[part]?.().ast;
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
 * Two declarations as one: `second`'s entries win where both name a table or
 * function.
 */
export const merge = (first: Declared, second: Declared): Declared => {
  const each = <A>(
    a: Readonly<Record<string, Readonly<Record<string, A>>>> | undefined,
    b: Readonly<Record<string, Readonly<Record<string, A>>>> | undefined,
  ) =>
    Rec.fromEntries(
      Arr.map(
        [...new Set([...Rec.keys(a ?? {}), ...Rec.keys(b ?? {})])],
        (componentPath) => [
          componentPath,
          { ...a?.[componentPath], ...b?.[componentPath] },
        ],
      ),
    );
  return {
    tables: each(first.tables, second.tables),
    functions: each(first.functions, second.functions),
  };
};

/**
 * A component kit's declaration, keyed from the component (`""` for itself,
 * `child` for a component it mounts), as the backend keys it at
 * `componentPath`.
 */
export const qualify = (
  declared: Declared,
  componentPath: string,
): Declared => {
  const rekey = <A>(
    record: Readonly<Record<string, A>> | undefined,
  ): Record<string, A> =>
    Rec.mapKeys(record ?? {}, (relative) =>
      relative === "" ? componentPath : `${componentPath}/${relative}`,
    );
  return {
    tables: rekey(declared.tables),
    functions: rekey(declared.functions),
  };
};

/**
 * `base` with `declared`'s schemas added; `declared` wins where both name one.
 */
export const extend = (base: Policy, declared: Declared): Policy => {
  const added = policy(declared);
  return {
    table: (componentPath, name) =>
      added.table(componentPath, name) ?? base.table(componentPath, name),
    args: (functionPath) => added.args(functionPath) ?? base.args(functionPath),
    returns: (functionPath) =>
      added.returns(functionPath) ?? base.returns(functionPath),
  };
};

/**
 * A Confect database schema's tables, as a policy's `tables` entry for one
 * component. No table's schema is built until the kernel asks for its shape.
 */
export const tablesOf = (
  databaseSchema: DatabaseSchema.AnyWithProps,
): Readonly<Record<string, Lazy>> =>
  Rec.fromEntries(
    Arr.map(
      Rec.values(DatabaseSchema.tables(databaseSchema)),
      (table: { readonly tableName: string; readonly Fields: Schema.Top }) => [
        table.tableName,
        () => table.Fields,
      ],
    ),
  );

/**
 * The text a secret leaf can show in free text: a string itself, an int64 as
 * its decimal digits.
 */
const leafTexts = (json: JSONValue): Array<string> => {
  if (typeof json === "string") return [json];
  if (Arr.isArray(json)) return Arr.flatMap(json, leafTexts);
  if (isObject(json)) {
    if ("$integer" in json) {
      try {
        const integer = jsonToConvex(json);
        return typeof integer === "bigint" ? [integer.toString()] : [];
      } catch {
        return [];
      }
    }
    if (isWrapped(json)) return [];
    return Arr.flatMap(Rec.values(json), leafTexts);
  }
  return [];
};

/**
 * The raw secrets the kernel has seen under a secret node, in the order it
 * first saw each, with every string a compound secret holds beneath it. This
 * store is replay state: it lives in memory beside the world and is never
 * written to an artifact. A snapshot's markers name entries here by position.
 */
export class Secrets {
  private readonly values: Array<JSONValue> = [];
  private readonly refs = new Map<string, number>();
  private readonly texts = new Set<string>();

  /**
   * Keep `value` and answer its position. A value kept before answers its first
   * position.
   */
  keep(value: JSONValue): number {
    const key = Json.stringify(value);
    const known = this.refs.get(key);
    if (known !== undefined) return known;
    this.values.push(value);
    this.refs.set(key, this.values.length - 1);
    for (const text of leafTexts(value)) this.texts.add(text);
    return this.values.length - 1;
  }

  raw(ref: number): JSONValue | undefined {
    return this.values[ref];
  }

  /**
   * Every kept secret's text long enough to search free text for, longest
   * first, so a secret inside another is never marked half.
   */
  searchable(): ReadonlyArray<string> {
    return Arr.filter(
      [...this.texts],
      (text) => text.length >= searchableLength,
    ).sort((a, b) => b.length - a.length);
  }

  copy(): Secrets {
    const copy = new Secrets();
    for (const value of this.values) copy.keep(value);
    return copy;
  }
}

/**
 * Keep every secret of `value` that `placements` put there, before it is
 * validated, so a validation error can already mark it.
 */
export const keep = (
  value: unknown,
  placements: ReadonlyArray<Placement>,
  secrets: Secrets,
): void => {
  if (placements.length === 0) return;
  let json: JSONValue;
  try {
    json = convexToJson(value as Value);
  } catch {
    // A value Convex cannot encode is never stored or passed, so it reaches no
    // artifact as a value.
    return;
  }
  walkPlaced(json, placements, (secret) => {
    secrets.keep(secret);
    return secret;
  });
};

const containsSecret = (text: string, searchable: ReadonlyArray<string>) =>
  Arr.some(searchable, (secret) => pipe(text, Str.includes(secret)));

/**
 * The backstop beneath every schema walk: each string, outside a marker, that
 * holds a kept secret, replaced by `replace`.
 */
const backstop = (
  json: JSONValue,
  searchable: ReadonlyArray<string>,
  replace: (value: JSONValue) => JSONValue,
): JSONValue => {
  if (searchable.length === 0) return json;
  const go = (value: JSONValue): JSONValue => {
    if (typeof value === "string")
      return containsSecret(value, searchable) ? replace(value) : value;
    if (Arr.isArray(value)) return Arr.map(value, go);
    if (isObject(value)) {
      if (isWrapped(value)) return value;
      // A document's ID and creation time are its identity, never a secret
      // value, even when a secret field holds the same ID. Convex reserves
      // these names for system fields, so no user value is skipped.
      return Rec.fromEntries(
        Arr.map(Rec.toEntries(value), ([key, item]) => [
          key,
          systemFields.has(key) ? item : go(item),
        ]),
      );
    }
    return value;
  };
  return go(json);
};

const systemFields = new Set(["_id", "_creationTime"]);

/**
 * `json`, a document bound for a snapshot, with every secret its placements put
 * there, and every string holding a kept secret, replaced by a marker that
 * names the raw value's position in `secrets`. The walk never enters a marker,
 * so marking a marked value changes nothing.
 */
export const mark = (
  json: JSONValue,
  placements: ReadonlyArray<Placement>,
  secrets: Secrets,
): JSONValue => {
  const toMarker = (value: JSONValue): JSONValue => ({
    [markerKey]: secrets.keep(value),
  });
  return backstop(
    walkPlaced(json, placements, toMarker),
    secrets.searchable(),
    toMarker,
  );
};

const utf8 = new TextEncoder();

const holds = (bytes: Uint8Array, needle: Uint8Array): boolean => {
  if (needle.length === 0) return false;
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
};

/**
 * A stored file's bytes as a snapshot writes them: base64, or a marker in their
 * place when they hold a kept secret's UTF-8 text. File bytes have no schema,
 * so only the backstop's rule applies, and base64 would otherwise hide the
 * secret from it while any reader could decode it. A restore given the secrets
 * puts the bytes back as they were.
 */
export const markBytes = (bytes: Uint8Array, secrets: Secrets): JSONValue => {
  const base64 = Base64.fromByteArray(bytes);
  return Arr.some(secrets.searchable(), (secret) =>
    holds(bytes, utf8.encode(secret)),
  )
    ? { [markerKey]: secrets.keep(base64) }
    : base64;
};

/**
 * `value` as an artifact other than a snapshot writes it: every secret its
 * placements put there, and every string holding a kept secret, replaced by the
 * marker text.
 */
export const markValue = (
  value: Value,
  placements: ReadonlyArray<Placement>,
  secrets: Secrets,
): Value => {
  let json: JSONValue;
  try {
    json = convexToJson(value);
  } catch {
    return value;
  }
  const marked = backstop(
    walkPlaced(json, placements, () => marker),
    secrets.searchable(),
    () => marker,
  );
  return marked === json ? value : jsonToConvex(marked);
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
  const go = (value: JSONValue): JSONValue => {
    if (Arr.isArray(value)) return Arr.map(value, go);
    if (!isObject(value)) return value;
    if (isMarker(value)) {
      const ref = value[markerKey];
      const raw = typeof ref === "number" ? secrets.raw(ref) : undefined;
      if (raw === undefined) missing ??= ref;
      return raw ?? null;
    }
    return Rec.fromEntries(
      Arr.map(Rec.toEntries(value), ([key, item]) => [key, go(item)]),
    );
  };
  const unmarked = go(json);
  return missing === undefined
    ? Result.succeed(unmarked)
    : Result.fail(
        KernelRefusal.SnapshotSecretMissing.make({
          ref: Json.stringify(missing),
          message: `The snapshot marks a secret at ${Json.stringify(missing)}, which the secrets passed to restore do not hold. Restore with the secrets of the backend that exported it.`,
        }),
      );
};

/**
 * `json` with every string value that holds a kept secret replaced by the
 * marker, as the backstop marks one: keys, encoded bytes and integers, and
 * system fields stay as they are.
 */
export const scrubJson = (json: JSONValue, secrets: Secrets): JSONValue =>
  backstop(json, secrets.searchable(), () => marker);

/**
 * `text` with every kept secret, raw or as it appears inside a JSON string,
 * replaced by the marker.
 */
export const scrubText = (text: string, secrets: Secrets): string =>
  Arr.reduce(secrets.searchable(), text, (scrubbed, secret) => {
    const escaped = pipe(Json.stringify(secret), Str.slice(1, -1));
    return pipe(
      scrubbed,
      Str.split(secret),
      Arr.join(marker),
      Str.split(escaped),
      Arr.join(marker),
    );
  });

const isPlainObject = (value: object): boolean =>
  Object.getPrototypeOf(value) === Object.prototype ||
  Object.getPrototypeOf(value) === null;

/**
 * A failure report for `thrown`, whatever was thrown: every kept secret in its
 * text, its data and its causes marked. When nothing needs marking it is
 * `thrown` itself. Otherwise it is a copy with the same prototype and fields,
 * so its class and tag still read the same. `thrown` is never changed, so a
 * subscription that keeps the raw error compares it as it was.
 */
export const failure = (thrown: unknown, secrets: Secrets): unknown => {
  if (secrets.searchable().length === 0) return thrown;
  const copyable = (value: object) =>
    Arr.isArray(value) || value instanceof Error || isPlainObject(value);
  const field = (value: object, key: string | symbol) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return {
      raw: "value" in descriptor ? descriptor.value : Reflect.get(value, key),
      enumerable: descriptor.enumerable ?? false,
    };
  };
  // First find whether anything reachable holds a kept secret. Every object is
  // visited once, so a cycle ends.
  const visited = new Set<object>();
  const holdsSecret = (value: unknown): boolean => {
    if (typeof value === "string") return scrubText(value, secrets) !== value;
    if (typeof value !== "object" || value === null) return false;
    if (visited.has(value) || !copyable(value)) return false;
    visited.add(value);
    return Arr.some(Reflect.ownKeys(value), (key) =>
      holdsSecret(field(value, key).raw),
    );
  };
  if (!holdsSecret(thrown)) return thrown;
  // Then copy every reachable error, array and plain object. Each copy is
  // registered before its fields are walked, so a cycle that leads back to it
  // reaches the copy, never the raw value.
  const copies = new Map<object, unknown>();
  const copy = (value: unknown): unknown => {
    if (typeof value === "string") return scrubText(value, secrets);
    if (typeof value !== "object" || value === null) return value;
    if (copies.has(value)) return copies.get(value);
    if (!copyable(value)) return value;
    if (Arr.isArray(value)) {
      // The copy is registered first, so a cycle through it reaches the copy.
      // Its entries and its own other properties, such as a `code`, are copied.
      const items: Array<unknown> = [];
      copies.set(value, items);
      for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue;
        const { raw, enumerable } = field(value, key);
        if (typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key))
          items[Number(key)] = copy(raw);
        else
          Object.defineProperty(items, key, {
            value: copy(raw),
            writable: true,
            enumerable,
            configurable: true,
          });
      }
      items.length = value.length;
      return items;
    }
    const target: object = Object.create(Object.getPrototypeOf(value));
    copies.set(value, target);
    for (const key of Reflect.ownKeys(value)) {
      const { raw, enumerable } = field(value, key);
      Object.defineProperty(target, key, {
        value: copy(raw),
        writable: true,
        enumerable,
        configurable: true,
      });
    }
    return target;
  };
  return copy(thrown);
};
