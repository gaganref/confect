import { jsonToConvex, type JSONValue } from "convex/values";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { stringify } from "./Json.js";
import type { ObjectFieldType, ValidatorJSON } from "./KernelValues.js";

/**
 * The binary's refusal of a function's arguments, as the caller of a function
 * handle receives it: an `Error` whose message the binary's validator check
 * writes (local backend `precompiled-2026-10-28-cccbade`, probed by
 * `packages/server/test/local-backend/callbackArgs.test.ts`). Present fields
 * are checked first, in key order and recursively, then missing required
 * fields, then extra ones. The first problem is the one reported.
 */
export const refusal = (
  validator: ValidatorJSON,
  args: unknown,
): string | undefined => {
  if (!isPlainObject(args))
    return `The arguments to a Convex function must be an object. Received: ${String(args)}`;
  const problem = check(validator, args, "");
  return problem === undefined
    ? undefined
    : `ArgumentValidationError: ${problem.headline}\n${problem.path === "" ? "" : `Path: ${problem.path}`}\n${problem.shown}\nValidator: ${printValidator(problem.validator)}\n`;
};

interface Problem {
  readonly headline: string;
  readonly path: string;
  readonly shown: string;
  readonly validator: ValidatorJSON;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Predicate.isObject(value) &&
  !Arr.isArray(value) &&
  !(value instanceof ArrayBuffer);

const mismatch = (
  path: string,
  value: unknown,
  validator: ValidatorJSON,
): Problem => ({
  headline: "Value does not match validator.",
  path,
  shown: `Value: ${printValue(value)}`,
  validator,
});

const sortedKeys = (record: Readonly<Record<string, unknown>>) =>
  Arr.sort(Rec.keys(record), Order.String);

const check = (
  validator: ValidatorJSON,
  value: unknown,
  path: string,
): Problem | undefined => {
  switch (validator.type) {
    case "any":
      return undefined;
    case "null":
      return value === null ? undefined : mismatch(path, value, validator);
    case "number":
      return typeof value === "number"
        ? undefined
        : mismatch(path, value, validator);
    case "bigint":
      return typeof value === "bigint"
        ? undefined
        : mismatch(path, value, validator);
    case "boolean":
      return typeof value === "boolean"
        ? undefined
        : mismatch(path, value, validator);
    case "string":
    case "id":
      return typeof value === "string"
        ? undefined
        : mismatch(path, value, validator);
    case "bytes":
      return value instanceof ArrayBuffer
        ? undefined
        : mismatch(path, value, validator);
    case "literal":
      return literalMatches(validator.value, value)
        ? undefined
        : mismatch(path, value, validator);
    case "union":
      return Arr.some(
        validator.value,
        (member) => check(member, value, path) === undefined,
      )
        ? undefined
        : mismatch(path, value, validator);
    case "array": {
      if (!Arr.isArray(value)) return mismatch(path, value, validator);
      for (const [index, element] of value.entries()) {
        const problem = check(validator.value, element, `${path}[${index}]`);
        if (problem !== undefined) return problem;
      }
      return undefined;
    }
    case "record": {
      if (!isPlainObject(value)) return mismatch(path, value, validator);
      for (const key of sortedKeys(value)) {
        const keyProblem = check(validator.keys, key, `${path}.keys()`);
        if (keyProblem !== undefined) return keyProblem;
        const valueProblem = check(
          validator.values.fieldType,
          value[key],
          `${path}.values()`,
        );
        if (valueProblem !== undefined) return valueProblem;
      }
      return undefined;
    }
    case "object":
      return checkObject(validator, value, path);
    default:
      return undefined;
  }
};

const checkObject = (
  validator: Extract<ValidatorJSON, { type: "object" }>,
  value: unknown,
  path: string,
): Problem | undefined => {
  if (!isPlainObject(value)) return mismatch(path, value, validator);
  const fields = validator.value;
  for (const key of sortedKeys(fields)) {
    if (value[key] === undefined) continue;
    const problem = check(fields[key]!.fieldType, value[key], `${path}.${key}`);
    if (problem !== undefined) return problem;
  }
  const shown = `Object: ${printValue(value)}`;
  const missing = Arr.findFirst(
    sortedKeys(fields),
    (key) => !fields[key]!.optional && value[key] === undefined,
  );
  if (missing._tag === "Some")
    return {
      headline: `Object is missing the required field \`${missing.value}\`. Consider wrapping the field validator in \`v.optional(...)\` if this is expected.`,
      path,
      shown,
      validator,
    };
  const extra = Arr.findFirst(
    sortedKeys(value),
    (key) => value[key] !== undefined && !Rec.has(fields, key),
  );
  if (extra._tag === "Some")
    return {
      headline: `Object contains extra field \`${extra.value}\` that is not in the validator.`,
      path,
      shown,
      validator,
    };
  return undefined;
};

const literalMatches = (literal: unknown, value: unknown) =>
  literalOf(literal) === value;

/**
 * A literal from validator JSON, which carries an int64 as Convex JSON.
 */
const literalOf = (literal: unknown): unknown =>
  jsonToConvex(literal as JSONValue);

/**
 * A float64 as the binary prints it, Rust's `{:?}`: the shortest round-trip
 * digits, `.0` on an integral value, and an exponent below 1e-4 and from 1e16.
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

const base64 = (buffer: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buffer)));

const printValue = (value: unknown): string => {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "number") return printFloat(value);
  if (typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "string") return stringify(value);
  if (value instanceof ArrayBuffer) return `b${stringify(base64(value))}`;
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

const printField = ({ fieldType, optional }: ObjectFieldType): string =>
  optional
    ? `v.optional(${printValidator(fieldType)})`
    : printValidator(fieldType);

const printValidator = (validator: ValidatorJSON): string => {
  switch (validator.type) {
    case "number":
      return "v.float64()";
    case "bigint":
      return "v.int64()";
    case "id":
      return `v.id(${stringify(validator.tableName)})`;
    case "literal":
      return `v.literal(${printValue(literalOf(validator.value))})`;
    case "array":
      return `v.array(${printValidator(validator.value)})`;
    case "union":
      return `v.union(${Arr.join(Arr.map(validator.value, printValidator), ", ")})`;
    case "record":
      return `v.record(${printValidator(validator.keys)}, ${printField(validator.values)})`;
    case "object":
      return `v.object({${Arr.join(
        Arr.map(
          sortedKeys(validator.value),
          (key) => `${key}: ${printField(validator.value[key]!)}`,
        ),
        ", ",
      )}})`;
    default:
      return `v.${validator.type}()`;
  }
};
