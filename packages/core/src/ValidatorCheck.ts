import { CommitTsPlaceholder, type GenericValidator } from "convex/values";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import type * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import type * as SchemaAST from "effect/SchemaAST";
import * as Str from "effect/String";
import * as SecretMarking from "./internal/secretMarking.js";

/**
 * What the check needs from the backend it runs on.
 *
 * @stability unstable
 */
export interface Lookups {
  /**
   * The table `id` names, or `undefined` when it names no table. `expected` is
   * the table the validator names, for a backend that can only test an ID
   * against one table.
   */
  readonly tableOf: (id: string, expected: string) => string | undefined;
  /**
   * Whether `value` parses as one of the backend's function handles.
   */
  readonly isFunctionHandle: (value: string) => boolean;
}

type ObjectValidator = Extract<GenericValidator, { readonly kind: "object" }>;

/**
 * @stability unstable
 */
export type LiteralValue = string | number | bigint | boolean;

/**
 * One of the binary's `ValidationError`s and the path it was found at. It holds
 * the refused value, so only a caller that may print the value reads it.
 *
 * @stability unstable
 */
export type Problem = { readonly path: string } & (
  | {
      readonly kind: "table";
      readonly id: string;
      readonly found: string;
      readonly tableName: string;
    }
  | { readonly kind: "system"; readonly id: string; readonly tableName: string }
  | {
      readonly kind: "literal";
      readonly value: unknown;
      readonly literal: LiteralValue;
      readonly validator: GenericValidator;
    }
  | {
      readonly kind: "missing" | "extra";
      readonly object: Readonly<Record<string, unknown>>;
      readonly field: string;
      readonly validator: ObjectValidator;
    }
  | {
      readonly kind: "noMatch";
      readonly value: unknown;
      readonly validator: GenericValidator;
    }
);

/**
 * Whether `value` is a Convex object, as convex's `isSimpleObject` reads one:
 * an object whose prototype is `Object.prototype` or `null`, or an `Object` of
 * another realm. An array, bytes, a `Date`, a `Map`, a `Set` or a class
 * instance is not.
 *
 * @stability unstable
 */
export const isPlainObject = (
  value: unknown,
): value is Record<string, unknown> => {
  if (!Predicate.isObject(value) || Arr.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return (
    prototype === null ||
    prototype === Object.prototype ||
    (Predicate.isObject(prototype) &&
      (prototype as { readonly constructor?: { readonly name?: unknown } })
        .constructor?.name === "Object")
  );
};

/**
 * The int64 the binary checks a pending commit timestamp as: it projects
 * `db.vars.commitTs` to the largest int64 before it checks pending arguments
 * and returns.
 */
const MAX_INT64 = 2n ** 63n - 1n;

/**
 * Whether `object` holds `key` as its own, defined field: the binary reads no
 * inherited property, and a field set to `undefined` is absent.
 */
const holdsField = (object: Readonly<Record<string, unknown>>, key: string) =>
  Rec.has(object, key) && object[key] !== undefined;

const noMatch = (
  path: string,
  value: unknown,
  validator: GenericValidator,
): Problem => ({ kind: "noMatch", path, value, validator });

const accepts =
  (holds: boolean) =>
  (path: string, value: unknown, validator: GenericValidator) =>
    holds ? undefined : noMatch(path, value, validator);

const codePoint = (character: string): number =>
  Option.getOrElse(pipe(character, Str.codePointAt(0)), () => 0);

/**
 * Strings in Unicode code point order, as Rust orders a `String`'s UTF-8 bytes,
 * which is how the binary's `BTreeMap`s of fields and keys iterate.
 */
const codePointOrder: Order.Order<string> = (self, that) => {
  const left = Arr.map(Arr.fromIterable(self), codePoint);
  const right = Arr.map(Arr.fromIterable(that), codePoint);
  for (let index = 0; index < left.length && index < right.length; index++) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
};

/**
 * A record's keys in the order the binary iterates them.
 *
 * @stability unstable
 */
export const sortedKeys = (record: Readonly<Record<string, unknown>>) =>
  Arr.sort(Rec.keys(record), codePointOrder);

/**
 * Whether `value` equals `literal` as the binary compares Convex values: a
 * float by its total order, so `-0` is not `0` and `NaN` is `NaN`, and an int64
 * never equals a float64.
 */
const equalsLiteral = (value: unknown, literal: LiteralValue): boolean =>
  typeof value === "number" && typeof literal === "number"
    ? Object.is(value, literal)
    : value === literal;

const assertNever = (validator: never): never => {
  throw new Error(
    `The validator check cannot check the validator kind of ${String((validator as { readonly kind?: unknown }).kind)}.`,
  );
};

/**
 * The first problem with `value` under `validator`, or `undefined` when the
 * validator accepts it, as the binary checks a function's arguments and its
 * return. Each case ports convex-backend `cccbade4`'s
 * `Validator::check_value_internal` (`crates/common/src/schemas/validator.rs`),
 * one per validator kind of convex 1.49's `Validator` union, so a kind added
 * later fails typecheck here rather than passing unchecked. The seeded
 * differential in
 * `packages/server/test/local-backend/validationDifferential.test.ts` compares
 * it with the local backend through the test kernel's refusals.
 *
 * @stability unstable
 */
export const check = (
  validator: GenericValidator,
  value: unknown,
  lookups: Lookups,
  path = "",
): Problem | undefined => {
  if (value instanceof CommitTsPlaceholder)
    return check(validator, MAX_INT64, lookups, path);
  switch (validator.kind) {
    case "any":
      return undefined;
    case "null":
      return accepts(value === null)(path, value, validator);
    case "float64":
      return accepts(typeof value === "number")(path, value, validator);
    case "int64":
      return accepts(typeof value === "bigint")(path, value, validator);
    case "commitTs":
      return accepts(typeof value === "bigint")(path, value, validator);
    case "boolean":
      return accepts(typeof value === "boolean")(path, value, validator);
    case "string":
      return accepts(typeof value === "string")(path, value, validator);
    case "bytes":
      return accepts(value instanceof ArrayBuffer)(path, value, validator);
    case "function":
      // The binary accepts a string it parses as its own handle format.
      return accepts(
        typeof value === "string" && lookups.isFunctionHandle(value),
      )(path, value, validator);
    case "id": {
      const found =
        typeof value === "string"
          ? lookups.tableOf(value, validator.tableName)
          : undefined;
      if (found === undefined) return noMatch(path, value, validator);
      if (found === validator.tableName) return undefined;
      const id = value as string;
      return pipe(found, Str.startsWith("_"))
        ? { kind: "system", path, id, tableName: validator.tableName }
        : { kind: "table", path, id, found, tableName: validator.tableName };
    }
    case "literal":
      return equalsLiteral(value, validator.value)
        ? undefined
        : { kind: "literal", path, value, literal: validator.value, validator };
    case "union": {
      // A union of one member reports its member's own problem.
      if (validator.members.length === 1)
        return check(validator.members[0]!, value, lookups, path);
      return accepts(
        Arr.some(
          validator.members,
          (member) => check(member, value, lookups, path) === undefined,
        ),
      )(path, value, validator);
    }
    case "array": {
      if (!Arr.isArray(value)) return noMatch(path, value, validator);
      for (const [index, element] of value.entries()) {
        const problem = check(
          validator.element,
          element,
          lookups,
          `${path}[${index}]`,
        );
        if (problem !== undefined) return problem;
      }
      return undefined;
    }
    case "record": {
      if (!isPlainObject(value)) return noMatch(path, value, validator);
      for (const key of sortedKeys(value)) {
        // The binary drops a record's undefined values before it checks them.
        if (value[key] === undefined) continue;
        const keyProblem = check(validator.key, key, lookups, `${path}.keys()`);
        if (keyProblem !== undefined) return keyProblem;
        const valueProblem = check(
          validator.value,
          value[key],
          lookups,
          `${path}.values()`,
        );
        if (valueProblem !== undefined) return valueProblem;
      }
      return undefined;
    }
    case "object":
      return checkObject(validator, value, lookups, path);
    default:
      return assertNever(validator);
  }
};

/**
 * An object's first problem as the binary finds it: each declared field in key
 * order, checked when present and refused when required and absent, then the
 * first extra field in key order.
 */
const checkObject = (
  validator: ObjectValidator,
  value: unknown,
  lookups: Lookups,
  path: string,
): Problem | undefined => {
  if (!isPlainObject(value)) return noMatch(path, value, validator);
  const fields = validator.fields as Readonly<Record<string, GenericValidator>>;
  for (const key of sortedKeys(fields)) {
    if (holdsField(value, key)) {
      const problem = check(
        fields[key]!,
        value[key],
        lookups,
        `${path}.${key}`,
      );
      if (problem !== undefined) return problem;
    } else if (fields[key]!.isOptional !== "optional")
      return { kind: "missing", path, object: value, field: key, validator };
  }
  const extra = Arr.findFirst(
    sortedKeys(value),
    (key) => value[key] !== undefined && !Rec.has(fields, key),
  );
  return extra._tag === "Some"
    ? { kind: "extra", path, object: value, field: extra.value, validator }
    : undefined;
};

/**
 * A finite float64 as serde_json prints a literal's, through `ryu`: the
 * shortest round-trip digits, fixed from 1e-5 to below 1e16 with `.0` on an
 * integral value, and an exponent outside that, signed.
 */
const printJsonFloat = (value: number): string => {
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const sign = value < 0 ? "-" : "";
  const [mantissa, exponent = "0"] = pipe(
    Math.abs(value).toExponential(),
    Str.split("e"),
  );
  const digits = pipe(mantissa, Str.replace(".", ""));
  // The value is `digits` times ten to `point - digits.length`.
  const point = Number(exponent) + 1;
  if (digits.length <= point && point <= 16)
    return `${sign}${digits}${Str.repeat(point - digits.length)("0")}.0`;
  if (0 < point && point <= 16)
    return `${sign}${pipe(digits, Str.slice(0, point))}.${pipe(digits, Str.slice(point))}`;
  if (-5 < point && point <= 0)
    return `${sign}0.${Str.repeat(-point)("0")}${digits}`;
  return `${sign}${mantissa}e${point > 0 ? "+" : ""}${point - 1}`;
};

/**
 * A literal as the binary prints it, through serde_json: JSON for a string, a
 * boolean and a finite float, `<number>` for any other float and `<bigint>` for
 * an int64.
 *
 * @stability unstable
 */
export const printLiteral = (literal: LiteralValue): string => {
  if (typeof literal === "bigint") return "<bigint>";
  if (typeof literal === "number")
    return Number.isFinite(literal) ? printJsonFloat(literal) : "<number>";
  // oxlint-disable-next-line effecttsgo/global-json -- A string or boolean literal prints as serde_json writes it, synchronously and outside an Effect.
  return JSON.stringify(literal);
};

/**
 * What a printer leaves out: the validators that check a secret, beneath which
 * a literal's value is the secret's own.
 *
 * @stability unstable
 */
export type Secrets = {
  readonly has: (validator: GenericValidator) => boolean;
};

const noSecrets: Secrets = { has: () => false };

/**
 * A validator as the binary's `Display` prints it. It prints only the
 * validator, never a value, and a literal beneath one of `secrets` as
 * `v.literal(<secret>)`.
 *
 * @stability unstable
 */
export const printValidator = (
  validator: GenericValidator,
  secrets: Secrets = noSecrets,
): string => printWithin(validator, secrets, false);

const printWithin = (
  validator: GenericValidator,
  secrets: Secrets,
  outerSecret: boolean,
): string => {
  const secret = outerSecret || secrets.has(validator);
  const print = (inner: GenericValidator) =>
    printWithin(inner, secrets, secret);
  const field = (inner: GenericValidator) =>
    inner.isOptional === "optional"
      ? `v.optional(${print(inner)})`
      : print(inner);
  switch (validator.kind) {
    case "id":
      return `v.id("${validator.tableName}")`;
    case "literal":
      return `v.literal(${secret ? "<secret>" : printLiteral(validator.value)})`;
    case "array":
      return `v.array(${print(validator.element)})`;
    case "union":
      return `v.union(${Arr.join(Arr.map(validator.members, print), ", ")})`;
    case "record":
      return `v.record(${print(validator.key)}, ${print(validator.value)})`;
    case "object": {
      const fields = validator.fields as Readonly<
        Record<string, GenericValidator>
      >;
      return `v.object({${Arr.join(
        Arr.map(sortedKeys(fields), (key) => `${key}: ${field(fields[key]!)}`),
        ", ",
      )}})`;
    }
    case "function": {
      const signature = [
        ...(validator.fnType === undefined
          ? []
          : [`fnType: "${validator.fnType}"`]),
        ...(validator.args === undefined
          ? []
          : [`args: ${print(validator.args)}`]),
        ...(validator.returns === undefined
          ? []
          : [`returns: ${print(validator.returns)}`]),
      ];
      return signature.length === 0
        ? "v.function()"
        : `v.function({ ${Arr.join(signature, ", ")} })`;
    }
    case "any":
    case "null":
    case "float64":
    case "int64":
    case "commitTs":
    case "boolean":
    case "string":
    case "bytes":
      return `v.${validator.kind}()`;
    default:
      return assertNever(validator);
  }
};

/**
 * Why the binary refuses `name` as a field of an object validator at push, or
 * `undefined` when it takes it: a field name starts with no `$` and holds only
 * non-control ASCII, and is an identifier of 1 to 64 letters, digits and
 * underscores that starts with a letter or underscore.
 */
const fieldNameProblem = (name: string): string | undefined => {
  if (pipe(name, Str.startsWith("$")))
    return `Field name ${name} starts with '$', which is reserved.`;
  const characters = Arr.fromIterable(name);
  const control = Arr.findFirst(characters, (character) => {
    const point = codePoint(character);
    return point < 0x20 || point > 0x7e;
  });
  if (control._tag === "Some")
    return `Field name ${name} has invalid character '${control.value}': Field names can only contain non-control ASCII characters`;
  if (name.length === 0) return "Identifier cannot be empty";
  if (name.length > 64)
    return `Identifier is too long (${name.length} > maximum 64)`;
  if (!/^[A-Za-z_]/u.test(name))
    return `Invalid first character '${characters[0]}' in ${name}: Identifiers must start with an alphabetic character or underscore`;
  const invalid = Arr.findFirst(characters, (character) =>
    /[^A-Za-z0-9_]/u.test(character),
  );
  return invalid._tag === "Some"
    ? `Identifier ${name} has invalid character '${invalid.value}': Identifiers can only contain alphanumeric characters or underscores`
    : undefined;
};

/**
 * Why the binary would refuse `validator` as a function's arguments or return
 * validator when it reads it at push, or `undefined` when it would take it. It
 * checks each object field's name, as the binary parses a validator's JSON.
 *
 * @stability unstable
 */
export const declarationProblem = (
  validator: GenericValidator,
): string | undefined => {
  switch (validator.kind) {
    case "object": {
      const fields = validator.fields as Readonly<
        Record<string, GenericValidator>
      >;
      for (const key of sortedKeys(fields)) {
        const problem =
          fieldNameProblem(key) ?? declarationProblem(fields[key]!);
        if (problem !== undefined) return problem;
      }
      return undefined;
    }
    case "array":
      return declarationProblem(validator.element);
    case "record":
      return (
        declarationProblem(validator.key) ?? declarationProblem(validator.value)
      );
    case "union":
      return Option.getOrUndefined(
        Arr.findFirst(
          Arr.map(validator.members, declarationProblem),
          (problem) => problem !== undefined,
        ),
      );
    default:
      return undefined;
  }
};

/**
 * Run `compile`, which compiles validators synchronously with
 * `SchemaToValidator`, and record each validator it compiles from one of
 * `nodes`, the encoded nodes of a schema's secrets. A validator beneath a
 * recorded one checks part of that secret.
 *
 * @stability unstable
 */
export const withSecretValidators = <A>(
  nodes: ReadonlySet<SchemaAST.AST>,
  compile: () => A,
): { readonly value: A; readonly secrets: Secrets } => {
  const marked = new WeakSet<GenericValidator>();
  return {
    value: SecretMarking.during({ nodes, marked }, compile),
    secrets: { has: (validator) => marked.has(validator) },
  };
};
