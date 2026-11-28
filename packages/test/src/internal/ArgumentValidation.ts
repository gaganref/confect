import * as ValidatorCheck from "@confect/core/ValidatorCheck";
import type { GenericValidator } from "convex/values";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import { stringify } from "./Json.js";
import { readFunctionHandle } from "./KernelValues.js";

/**
 * The binary's validation of a function's arguments and of its return, as a
 * handle's caller sees each refused: an `Error` whose message the binary's
 * validator check writes. The check is `@confect/core/ValidatorCheck`'s port of
 * convex-backend `cccbade4`'s `Validator::check_value_internal`; this module
 * ports its `ValidationError` messages and the `Display` of its values and
 * validators. The seeded differential in
 * `packages/server/test/local-backend/validationDifferential.test.ts` compares
 * the two on the local backend. A refusal's text is built only once a value is
 * refused, so a valid value is never printed.
 */

/**
 * The table an ID names in the validating function's namespace, as the binary
 * reads it (`all_tables_number_to_name`): `undefined` when the string is no ID,
 * or its table number names no table there. A system table answers its virtual
 * name, such as `_storage`.
 */
export type TableOf = (id: string) => string | undefined;

const lookups = (tableOf: TableOf): ValidatorCheck.Lookups => ({
  tableOf,
  isFunctionHandle: (value) => readFunctionHandle(value) !== undefined,
});

const { isPlainObject, sortedKeys } = ValidatorCheck;
type Problem = ValidatorCheck.Problem;
type LiteralValue = ValidatorCheck.LiteralValue;

/**
 * The arguments' refusal, or `undefined` when `validator` accepts them.
 */
export const argumentRefusal = (
  validator: GenericValidator,
  args: unknown,
  tableOf: TableOf,
): string | undefined => {
  if (!isPlainObject(args))
    return `The arguments to a Convex function must be an object. Received: ${Predicate.isObject(args) ? "an array or bytes" : String(args as string | number | bigint | boolean | symbol | null | undefined)}`;
  const problem = ValidatorCheck.check(validator, args, lookups(tableOf));
  return problem === undefined
    ? undefined
    : `ArgumentValidationError: ${describe(problem)}\n`;
};

/**
 * The return's refusal, or `undefined` when `validator` accepts it.
 */
export const returnsRefusal = (
  validator: GenericValidator,
  value: unknown,
  tableOf: TableOf,
): string | undefined => {
  const problem = ValidatorCheck.check(validator, value, lookups(tableOf));
  return problem === undefined
    ? undefined
    : `ReturnsValidationError: ${describe(problem)}`;
};

const describe = (problem: Problem): string => {
  const context = problem.path === "" ? "" : `Path: ${problem.path}`;
  switch (problem.kind) {
    case "table":
      return `Found ID "${problem.id}" from table \`${problem.found}\`, which does not match the table name in validator \`v.id("${problem.tableName}")\`.${context}`;
    case "system":
      return `Found ID "${problem.id}" from a system table, which does not match the table name in validator \`v.id("${problem.tableName}")\`.${context}`;
    case "literal":
      return `\`${printValue(problem.value)}\` does not match literal validator \`v.literal(${printLiteral(problem.literal)})\`.${context}`;
    case "missing":
      return `Object is missing the required field \`${problem.field}\`. Consider wrapping the field validator in \`v.optional(...)\` if this is expected.\n${context}\nObject: ${printValue(problem.object)}\nValidator: ${printValidator(problem.validator)}`;
    case "extra":
      return `Object contains extra field \`${problem.field}\` that is not in the validator.\n${context}\nObject: ${printValue(problem.object)}\nValidator: ${printValidator(problem.validator)}`;
    case "noMatch":
      return `Value does not match validator.\n${context}\nValue: ${printValue(problem.value)}\nValidator: ${printValidator(problem.validator)}`;
  }
};

const codePoint = (character: string): number =>
  Option.getOrElse(pipe(character, Str.codePointAt(0)), () => 0);

const assertNever = (validator: never): never => {
  throw new Error(
    `The test kernel cannot check the validator kind of ${String((validator as { readonly kind?: unknown }).kind)}.`,
  );
};

/**
 * A float64 as the binary prints a value's, Rust's `{:?}`: the shortest
 * round-trip digits, `.0` on an integral value, and an exponent below 1e-4 and
 * from 1e16.
 */
const printFloat = (value: number): string => {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const magnitude = Math.abs(value);
  if (magnitude < 1e-4 || magnitude >= 1e16) {
    const [mantissa, exponent = "0"] = pipe(
      value.toExponential(),
      Str.split("e"),
    );
    return `${mantissa}e${Number(exponent)}`;
  }
  const fixed = String(value);
  return pipe(fixed, Str.includes(".")) ? fixed : `${fixed}.0`;
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
 */
const printLiteral = (literal: LiteralValue): string => {
  if (typeof literal === "bigint") return "<bigint>";
  if (typeof literal === "number")
    return Number.isFinite(literal) ? printJsonFloat(literal) : "<number>";
  return stringify(literal);
};

const graphemeExtend = /^\p{Grapheme_Extend}$/u;
const unprintable = /^[\p{Zs}\p{Zl}\p{Zp}\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]$/u;

/**
 * A string as Rust's `{:?}` prints it: quoted, with `\0`, `\t`, `\r`, `\n`,
 * `\\` and `\"` escaped, and any grapheme extender or unprintable character but
 * the space as `\u{hex}`.
 */
const printString = (value: string): string => {
  const escaped = Arr.map(Arr.fromIterable(value), (character) => {
    switch (character) {
      case "\0":
        return "\\0";
      case "\t":
        return "\\t";
      case "\r":
        return "\\r";
      case "\n":
        return "\\n";
      case "\\":
        return "\\\\";
      case '"':
        return '\\"';
      case " ":
        return " ";
      default:
        return graphemeExtend.test(character) || unprintable.test(character)
          ? `\\u{${codePoint(character).toString(16)}}`
          : character;
    }
  });
  return `"${Arr.join(escaped, "")}"`;
};

/**
 * Base64 of `buffer`, built in chunks, so a large buffer never spreads into one
 * call's arguments.
 */
const base64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  const chunks: Array<string> = [];
  for (let start = 0; start < bytes.length; start += 0x8000)
    chunks.push(String.fromCharCode(...bytes.subarray(start, start + 0x8000)));
  return btoa(Arr.join(chunks, ""));
};

/**
 * A Convex value as the binary's `Display` prints it.
 */
const printValue = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "number") return printFloat(value);
  if (typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "string") return printString(value);
  if (value instanceof ArrayBuffer) return `b${printString(base64(value))}`;
  if (Arr.isArray(value))
    return `[${Arr.join(Arr.map(value, printValue), ", ")}]`;
  if (isPlainObject(value))
    return `{${Arr.join(
      Arr.map(
        Arr.filter(sortedKeys(value), (key) => value[key] !== undefined),
        (key) => `${key}: ${printValue(value[key])}`,
      ),
      ", ",
    )}}`;
  return typeof value;
};

const printField = (validator: GenericValidator): string =>
  validator.isOptional === "optional"
    ? `v.optional(${printValidator(validator)})`
    : printValidator(validator);

/**
 * A validator as the binary's `Display` prints it.
 */
const printValidator = (validator: GenericValidator): string => {
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
