import { CommitTsPlaceholder, type GenericValidator } from "convex/values";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import type * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Str from "effect/String";

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
 * Whether `value` is a Convex object: an object that is neither an array nor
 * bytes.
 *
 * @stability unstable
 */
export const isPlainObject = (
  value: unknown,
): value is Record<string, unknown> =>
  Predicate.isObject(value) &&
  !Arr.isArray(value) &&
  !(value instanceof ArrayBuffer);

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
      // A pending write's placeholder resolves to a commit timestamp before
      // the binary checks it (`check_pending_args`).
      return accepts(
        typeof value === "bigint" || value instanceof CommitTsPlaceholder,
      )(path, value, validator);
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
        : { kind: "literal", path, value, literal: validator.value };
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
    if (value[key] !== undefined) {
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

const printField = (validator: GenericValidator): string =>
  validator.isOptional === "optional"
    ? `v.optional(${printValidator(validator)})`
    : printValidator(validator);

/**
 * A validator as the binary's `Display` prints it. It prints only the
 * validator, never a value.
 *
 * @stability unstable
 */
export const printValidator = (validator: GenericValidator): string => {
  switch (validator.kind) {
    case "id":
      return `v.id("${validator.tableName}")`;
    case "literal":
      return `v.literal(${printLiteral(validator.value)})`;
    case "array":
      return `v.array(${printValidator(validator.element)})`;
    case "union":
      return `v.union(${Arr.join(Arr.map(validator.members, printValidator), ", ")})`;
    case "record":
      return `v.record(${printValidator(validator.key)}, ${printValidator(validator.value)})`;
    case "object": {
      const fields = validator.fields as Readonly<
        Record<string, GenericValidator>
      >;
      return `v.object({${Arr.join(
        Arr.map(
          sortedKeys(fields),
          (key) => `${key}: ${printField(fields[key]!)}`,
        ),
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
          : [`args: ${printValidator(validator.args)}`]),
        ...(validator.returns === undefined
          ? []
          : [`returns: ${printValidator(validator.returns)}`]),
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
