import * as ValidatorCheck from "@confect/core/ValidatorCheck";
import type { GenericValidator } from "convex/values";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
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

const { isPlainObject, printLiteral, printValidator, sortedKeys } =
  ValidatorCheck;
type Problem = ValidatorCheck.Problem;

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
