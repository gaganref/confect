import { CommitTsPlaceholder, type GenericValidator } from "convex/values";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { stringify } from "./Json.js";
import { readFunctionHandle, tableNameFromId } from "./KernelValues.js";

/**
 * The binary's validation of a function's arguments and of its return, as a
 * handle's caller sees each refused: an `Error` whose message the binary's
 * validator check writes (local backend `precompiled-2026-10-28-cccbade`,
 * probed by `packages/server/test/local-backend/callbackArgs.test.ts`). Present
 * fields are checked first, in key order and recursively, then missing required
 * fields, then extra ones, and the first problem is the one reported. A
 * refusal's text is built only once a value is refused, so a valid value is
 * never printed.
 */

/**
 * The arguments' refusal, or `undefined` when `validator` accepts them.
 */
export const argumentRefusal = (
  validator: GenericValidator,
  args: unknown,
): string | undefined => {
  if (!isPlainObject(args))
    return `The arguments to a Convex function must be an object. Received: ${Predicate.isObject(args) ? "an array or bytes" : String(args as string | number | bigint | boolean | symbol | null | undefined)}`;
  const problem = check(validator, args, "");
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
): string | undefined => {
  const problem = check(validator, value, "");
  return problem === undefined
    ? undefined
    : `ReturnsValidationError: ${describe(problem)}`;
};

/**
 * What failed and where. `shown` prints the refused value only when a refusal
 * is written.
 */
type Problem =
  | {
      readonly kind: "mismatch" | "missing" | "extra";
      readonly headline: string;
      readonly path: string;
      readonly shown: () => string;
      readonly validator: GenericValidator;
    }
  | {
      readonly kind: "table";
      readonly id: string;
      readonly table: string;
      readonly path: string;
      readonly validator: GenericValidator;
    };

const describe = (problem: Problem): string =>
  problem.kind === "table"
    ? `Found ID ${stringify(problem.id)} from table \`${problem.table}\`, which does not match the table name in validator \`${printValidator(problem.validator)}\`.${problem.path === "" ? "" : `Path: ${problem.path}`}`
    : `${problem.headline}\n${problem.path === "" ? "" : `Path: ${problem.path}`}\n${problem.shown()}\nValidator: ${printValidator(problem.validator)}`;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Predicate.isObject(value) &&
  !Arr.isArray(value) &&
  !(value instanceof ArrayBuffer);

const mismatch = (
  path: string,
  value: unknown,
  validator: GenericValidator,
): Problem => ({
  kind: "mismatch",
  headline: "Value does not match validator.",
  path,
  shown: () => `Value: ${printValue(value)}`,
  validator,
});

const accepts =
  (holds: boolean) =>
  (path: string, value: unknown, validator: GenericValidator) =>
    holds ? undefined : mismatch(path, value, validator);

const sortedKeys = (record: Readonly<Record<string, unknown>>) =>
  Arr.sort(Rec.keys(record), Order.String);

const assertNever = (validator: never): never => {
  throw new Error(
    `The test kernel cannot check the validator kind of ${String((validator as { readonly kind?: unknown }).kind)}.`,
  );
};

/**
 * The first problem with `value` under `validator`, one case per validator kind
 * of convex 1.49's `Validator` union, so a kind added later fails typecheck
 * here rather than passing unchecked.
 */
const check = (
  validator: GenericValidator,
  value: unknown,
  path: string,
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
      // The binary accepts a string it parses as a handle; the kernel's
      // handles are its own format.
      return accepts(
        typeof value === "string" && readFunctionHandle(value) !== undefined,
      )(path, value, validator);
    case "id": {
      const table = typeof value === "string" ? tableNameFromId(value) : null;
      if (table === null) return mismatch(path, value, validator);
      return table === validator.tableName
        ? undefined
        : { kind: "table", id: value as string, table, path, validator };
    }
    case "literal":
      return accepts(value === validator.value)(path, value, validator);
    case "union":
      return accepts(
        Arr.some(
          validator.members,
          (member) => check(member, value, path) === undefined,
        ),
      )(path, value, validator);
    case "array": {
      if (!Arr.isArray(value)) return mismatch(path, value, validator);
      for (const [index, element] of value.entries()) {
        const problem = check(validator.element, element, `${path}[${index}]`);
        if (problem !== undefined) return problem;
      }
      return undefined;
    }
    case "record": {
      if (!isPlainObject(value)) return mismatch(path, value, validator);
      for (const key of sortedKeys(value)) {
        const keyProblem = check(validator.key, key, `${path}.keys()`);
        if (keyProblem !== undefined) return keyProblem;
        const valueProblem = check(
          validator.value,
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
      return assertNever(validator);
  }
};

const checkObject = (
  validator: Extract<GenericValidator, { readonly kind: "object" }>,
  value: unknown,
  path: string,
): Problem | undefined => {
  if (!isPlainObject(value)) return mismatch(path, value, validator);
  const fields = validator.fields as Readonly<Record<string, GenericValidator>>;
  for (const key of sortedKeys(fields)) {
    if (value[key] === undefined) continue;
    const problem = check(fields[key]!, value[key], `${path}.${key}`);
    if (problem !== undefined) return problem;
  }
  const shown = () => `Object: ${printValue(value)}`;
  const missing = Arr.findFirst(
    sortedKeys(fields),
    (key) => fields[key]!.isOptional !== "optional" && value[key] === undefined,
  );
  if (missing._tag === "Some")
    return {
      kind: "missing",
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
      kind: "extra",
      headline: `Object contains extra field \`${extra.value}\` that is not in the validator.`,
      path,
      shown,
      validator,
    };
  return undefined;
};

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

const printField = (validator: GenericValidator): string =>
  validator.isOptional === "optional"
    ? `v.optional(${printValidator(validator)})`
    : printValidator(validator);

const printValidator = (validator: GenericValidator): string => {
  switch (validator.kind) {
    case "id":
      return `v.id(${stringify(validator.tableName)})`;
    case "literal":
      return `v.literal(${printValue(validator.value)})`;
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
    case "any":
    case "null":
    case "float64":
    case "int64":
    case "commitTs":
    case "boolean":
    case "string":
    case "bytes":
    case "function":
      return `v.${validator.kind}()`;
    default:
      return assertNever(validator);
  }
};
