// Derived from convex-test 0.0.65 (index.ts), Copyright Convex, Inc.,
// licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). The value, filter, range,
// validator and argument rules are kept as convex-test states them, so the
// kernel answers a function the way convex-test does. The storage, attempts
// and execution around them are the kernel's own.

import * as Option from "effect/Option";
import type { GenericDocument } from "convex/server";
import {
  CommitTsPlaceholder,
  type GenericId,
  type JSONValue,
  type Value,
  compareValues,
  convexToJson,
  jsonToConvex,
} from "convex/values";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Json from "./Json.js";

/**
 * A function address inside one test backend: its component and its
 * `module:export` path.
 */
export type FunctionPath = {
  readonly componentPath: string;
  readonly udfPath: string;
};

export type FilterJson =
  | { $eq: [FilterJson, FilterJson] }
  | { $field: string }
  | JSONValue;

export type QueryOperator = { filter: FilterJson } | { limit: number };
export type Source =
  | { type: "FullTableScan"; tableName: string; order: "asc" | "desc" | null }
  | {
      type: "IndexRange";
      indexName: string;
      range: ReadonlyArray<SerializedRangeExpression>;
      order: "asc" | "desc" | null;
    }
  | {
      type: "Search";
      indexName: string;
      filters: ReadonlyArray<SerializedSearchFilter>;
    };

export type SerializedQuery = {
  source: Source;
  operators: Array<QueryOperator>;
};

export type SerializedRangeExpression = {
  type: "Eq" | "Gt" | "Gte" | "Lt" | "Lte";
  fieldPath: string;
  value: JSONValue;
};

export type SerializedSearchFilter =
  | {
      type: "Search";
      fieldPath: string;
      value: string;
    }
  | {
      type: "Eq";
      fieldPath: string;
      value: JSONValue;
    };

export type StoredDocument = GenericDocument & {
  _id: DocumentId;
  _creationTime: number;
};

export type Index = {
  indexDescriptor: string;
  fields: string[];
};

export type TableName = string;

export type DocumentId = GenericId<TableName>;

export function tableNameFromId(id: string) {
  const match = pipe(id, Str.match(/^[0-9]+/), Option.getOrNull);
  if (match === null || match[0].length === id.length) {
    return null;
  }
  return pipe(id, Str.slice(match[0].length));
}
/**
 * How a thrown `ConvexError`'s data reaches the code a call answers. Convex's
 * `serializeConvexErrorData` leaves it a JSON string as it leaves the function
 * that threw it (`convex` `src/server/impl/registration_impl.ts:112-127`).
 *
 * - `"json"`: Convex JSON, for a calling function's syscall. The binary parses
 *   the string to a Convex value and hands the calling function's rejected
 *   syscall its Convex JSON (convex-backend `cccbade4`,
 *   `crates/isolate/src/error.rs:164-181`,
 *   `crates/isolate/src/helpers.rs:175-208`,
 *   `crates/isolate/src/environment/helpers/promise.rs:77-88`). The caller's
 *   `performAsyncSyscall` decodes it once
 *   (`src/server/impl/syscall.ts:46-51`).
 * - `"value"`: a Convex value, for the test and for a call the kernel answers
 *   without a syscall.
 */
export type ConvexErrorDataEncoding = "json" | "value";

/**
 * `thrown` with a `ConvexError`'s serialized data in `encoding`. Data that is
 * not a serialized JSON string stays as it is.
 */
export function receiveConvexErrorData(
  thrown: unknown,
  encoding: ConvexErrorDataEncoding,
) {
  if (
    typeof thrown === "object" &&
    thrown !== null &&
    Symbol.for("ConvexError") in thrown &&
    typeof (thrown as { data: unknown }).data === "string"
  ) {
    try {
      const json: JSONValue = Json.parse((thrown as { data: string }).data);
      (thrown as { data: unknown }).data =
        encoding === "json" ? json : jsonToConvex(json);
    } catch {
      // Data wasn't a serialized JSON string — leave it untouched.
    }
  }
  return thrown;
}

export function isSimpleObject(value: unknown) {
  const isObject = typeof value === "object";
  const prototype = Object.getPrototypeOf(value);
  const isSimple =
    prototype === null ||
    prototype === Object.prototype ||
    // Objects generated from other contexts (e.g. across Node.js `vm` modules) will not satisfy the previous
    // conditions but are still simple objects.
    prototype?.constructor?.name === "Object";
  return isObject && isSimple;
}

// Commit timestamp placeholders are resolved to `i64::MAX` before commit.
export const MAX_COMMIT_TS = 2n ** 63n - 1n;

export function hasPendingValues(value: Value): boolean {
  if (value instanceof CommitTsPlaceholder) {
    return true;
  }
  if (Arr.isArray(value)) {
    return Arr.some(value, hasPendingValues);
  }
  if (value !== null && value !== undefined && isSimpleObject(value)) {
    return Arr.some(
      Rec.values(value as Record<string, Value>),
      hasPendingValues,
    );
  }
  return false;
}

// The value as the transaction sees it before committing.
export function resolvePendingValues(value: Value): Value {
  return substituteCommitTs(value, MAX_COMMIT_TS);
}

// The value as it is committed.
export function resolveCommittedValues<T extends Value>(
  value: T,
  commitTs: bigint,
): T {
  return substituteCommitTs(value, commitTs);
}

export function substituteCommitTs<T extends Value>(
  value: T,
  commitTs: bigint,
): T {
  if (!hasPendingValues(value)) {
    return value;
  }
  if (value instanceof CommitTsPlaceholder) {
    return commitTs as T;
  }
  if (Arr.isArray(value)) {
    return Arr.map(value as ReadonlyArray<Value>, (v) =>
      substituteCommitTs(v, commitTs),
    ) as T;
  }
  return Rec.fromEntries(
    Arr.map(Rec.toEntries(value as object), ([k, v]) => [
      k,
      substituteCommitTs(v, commitTs),
    ]),
  ) as T;
}

export function evaluateFieldPath(fieldPath: string, document: any) {
  const pathParts = pipe(fieldPath, Str.split("."));
  let result: Value | undefined = document;
  for (const p of pathParts) {
    result =
      result !== undefined && result !== null && isSimpleObject(result)
        ? (result as any)[p]
        : undefined;
  }
  return result === undefined ? undefined : resolvePendingValues(result);
}

export function evaluateFilter(
  document: GenericDocument,
  filter: any,
): Value | undefined {
  if (filter.$eq !== undefined) {
    return (
      compareValues(
        evaluateFilter(document, filter.$eq[0]),
        evaluateFilter(document, filter.$eq[1]),
      ) === 0
    );
  }
  if (filter.$neq !== undefined) {
    return (
      compareValues(
        evaluateFilter(document, filter.$neq[0]),
        evaluateFilter(document, filter.$neq[1]),
      ) !== 0
    );
  }
  if (filter.$and !== undefined) {
    return filter.$and.every((child: any) => evaluateFilter(document, child));
  }
  if (filter.$or !== undefined) {
    return filter.$or.some((child: any) => evaluateFilter(document, child));
  }
  if (filter.$not !== undefined) {
    const negated = Boolean(evaluateFilter(document, filter.$not));
    return !negated;
  }
  if (filter.$gt !== undefined) {
    return (
      evaluateFilter(document, filter.$gt[0])! >
      evaluateFilter(document, filter.$gt[1])!
    );
  }
  if (filter.$gte !== undefined) {
    return (
      evaluateFilter(document, filter.$gte[0])! >=
      evaluateFilter(document, filter.$gte[1])!
    );
  }
  if (filter.$lt !== undefined) {
    return (
      evaluateFilter(document, filter.$lt[0])! <
      evaluateFilter(document, filter.$lt[1])!
    );
  }
  if (filter.$lte !== undefined) {
    return (
      evaluateFilter(document, filter.$lte[0])! <=
      evaluateFilter(document, filter.$lte[1])!
    );
  }
  if (filter.$add !== undefined) {
    return (
      (evaluateFilter(document, filter.$add[0]) as number) +
      (evaluateFilter(document, filter.$add[1]) as number)
    );
  }
  if (filter.$sub !== undefined) {
    return (
      (evaluateFilter(document, filter.$sub[0]) as number) -
      (evaluateFilter(document, filter.$sub[1]) as number)
    );
  }
  if (filter.$mul !== undefined) {
    return (
      (evaluateFilter(document, filter.$mul[0]) as number) *
      (evaluateFilter(document, filter.$mul[1]) as number)
    );
  }
  if (filter.$div !== undefined) {
    return (
      (evaluateFilter(document, filter.$div[0]) as number) /
      (evaluateFilter(document, filter.$div[1]) as number)
    );
  }
  if (filter.$mod !== undefined) {
    return (
      (evaluateFilter(document, filter.$mod[0]) as number) %
      (evaluateFilter(document, filter.$mod[1]) as number)
    );
  }
  if (filter.$field !== undefined) {
    return evaluateFieldPath(filter.$field, document);
  }
  if (filter.$literal !== undefined) {
    return evaluateQueryValue(filter.$literal);
  }
  throw new Error(`not implemented: ${Json.stringify(filter)}`);
}

export function evaluateRangeFilter(
  document: GenericDocument,
  expr: SerializedRangeExpression,
) {
  const result = evaluateFieldPath(expr.fieldPath, document);
  const value = evaluateQueryValue(expr.value);
  switch (expr.type) {
    case "Eq":
      return compareValues(result, value) === 0;
    case "Gt":
      return compareValues(result, value) > 0;
    case "Gte":
      return compareValues(result, value) >= 0;
    case "Lt":
      return compareValues(result, value) < 0;
    case "Lte":
      return compareValues(result, value) <= 0;
  }
}

// A value used as a written field.
export function evaluateValue(value: JSONValue) {
  if (typeof value === "object" && value !== null && "$undefined" in value) {
    return undefined;
  }
  return jsonToConvex(value);
}

// A value used as a query bound or literal.
export function evaluateQueryValue(value: JSONValue) {
  const evaluatedValue = evaluateValue(value);
  return evaluatedValue === undefined
    ? undefined
    : resolvePendingValues(evaluatedValue);
}

// An index range expression is always a chained list of:
//
// 0 or more equality expressions defined with .eq.
// [Optionally] A lower bound expression defined with .gt or .gte.
// [Optionally] An upper bound expression defined with .lt or .lte.
export function validateIndexRangeExpression(
  source: Source & { type: "IndexRange" },
  fields: string[],
) {
  let fieldIndex = 0;
  let state: "eq" | "gt" | "lt" | "done" = "eq";
  for (const [filterIndex, filter] of source.range.entries()) {
    if (state === "done") {
      throw new Error(
        `Incorrect operator used in \`withIndex\`, cannot chain ` +
          `more operators after both \`.gt\` and \`.lt\` were already used, ` +
          `got \`${printIndexOperator(filter)}\`.`,
      );
    }

    const filterType: "eq" | "gt" | "lt" =
      filter.type == "Gt" || filter.type == "Gte"
        ? "gt"
        : filter.type == "Lt" || filter.type == "Lte"
          ? "lt"
          : "eq";

    switch (`${state}|${filterType}`) {
      // Allow to operate on the current indexed field
      case "eq|eq":
      case "eq|gt":
      case "eq|lt":
        if (filter.fieldPath === fields[fieldIndex]) {
          fieldIndex += 1;
          state = filterType;
          continue;
        }
        throw new Error(
          `Incorrect field used in \`withIndex\`, ` +
            `expected "${fields[fieldIndex]}", got "${filter.fieldPath}"`,
        );

      // Allow to operate on the previous field (gt and lt must operate on same field)
      case "lt|gt":
      case "gt|lt":
        if (fieldIndex > 0 && filter.fieldPath === fields[fieldIndex - 1]) {
          state = "done";
          continue;
        }
        throw new Error(
          `Incorrect field used in \`withIndex\`, ` +
            `\`.gt\` and \`.lt\` must operate on the same field, ` +
            `expected "${fields[fieldIndex - 1]}", got "${filter.fieldPath}"`,
        );

      default:
        throw new Error(
          `Incorrect operator used in \`withIndex\`, ` +
            `cannot chain \`.${pipe(filter.type, Str.toLowerCase)}()\` ` +
            `after \`.${pipe(source.range[filterIndex - 1].type, Str.toLowerCase)}()\``,
        );
    }
  }
}

export function printIndexOperator(filter: SerializedRangeExpression) {
  return `.${pipe(filter.type, Str.toLowerCase)}(${filter.fieldPath}, ${Json.stringify(filter.value)})`;
}

export function validateFieldNames(validator: ValidatorJSON) {
  if (validator.type === "object") {
    Arr.forEach(Rec.keys(validator.value), (fieldName) => {
      if (!isValidIdentifier(fieldName)) {
        throw new Error(
          `Field names must be valid identifiers, got "${fieldName}"`,
        );
      }
    });
  }

  if (validator.type === "union") {
    Arr.forEach(validator.value, validateFieldNames);
  }
}

export function isValidIdentifier(name: string) {
  return /(^_(id|creationTime)$)|^[a-zA-Z][a-zA-Z0-9_]*$/.test(name);
}

export type ObjectFieldType = { fieldType: ValidatorJSON; optional: boolean };

export type ValidatorJSON =
  | {
      type: "null";
    }
  | { type: "number" }
  | { type: "bigint" }
  | { type: "commitTs" }
  | { type: "boolean" }
  | { type: "string" }
  | { type: "bytes" }
  | { type: "any" }
  | {
      type: "literal";
      value: JSONValue;
    }
  | { type: "id"; tableName: string }
  | { type: "array"; value: ValidatorJSON }
  | { type: "object"; value: Record<string, ObjectFieldType> }
  | { type: "record"; keys: ValidatorJSON; values: ObjectFieldType }
  | {
      type: "function";
      fnType?: string;
      args?: ValidatorJSON;
      returns?: ValidatorJSON;
    }
  | { type: "union"; value: ValidatorJSON[] };

export function validateValidator(validator: ValidatorJSON, value: any) {
  switch (validator.type) {
    case "null": {
      if (value !== null) {
        throw new Error(`Validator error: Expected \`null\`, got \`${value}\``);
      }
      return;
    }
    case "number": {
      if (typeof value !== "number") {
        throw new Error(
          `Validator error: Expected \`number\`, got \`${value}\``,
        );
      }
      return;
    }
    case "bigint": {
      if (typeof value !== "bigint") {
        throw new Error(
          `Validator error: Expected \`bigint\`, got \`${value}\``,
        );
      }
      return;
    }
    case "commitTs": {
      if (
        typeof value !== "bigint" &&
        !(value instanceof CommitTsPlaceholder)
      ) {
        throw new Error(
          `Validator error: Expected \`v.commitTs()\`, got \`${value}\``,
        );
      }
      return;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        throw new Error(
          `Validator error: Expected \`boolean\`, got \`${value}\``,
        );
      }
      return;
    }
    case "string": {
      if (typeof value !== "string") {
        throw new Error(
          `Validator error: Expected \`string\`, got \`${value}\``,
        );
      }
      return;
    }
    case "bytes": {
      if (!(value instanceof ArrayBuffer)) {
        throw new Error(
          `Validator error: Expected \`ArrayBuffer\`, got \`${value}\``,
        );
      }
      return;
    }
    case "any": {
      return;
    }
    case "literal": {
      if (value !== validator.value) {
        throw new Error(
          `Validator error: Expected \`${
            validator.value as any
          }\`, got \`${value}\``,
        );
      }
      return;
    }
    case "id": {
      if (typeof value !== "string") {
        throw new Error(
          `Validator error: Expected \`string\`, got \`${value}\``,
        );
      }
      if (tableNameFromId(value) !== validator.tableName) {
        throw new Error(
          `Validator error: Expected ID for table "${validator.tableName}", got \`${value}\``,
        );
      }
      return;
    }
    case "array": {
      if (!Arr.isArray(value)) {
        throw new Error(
          `Validator error: Expected \`Array\`, got \`${value}\``,
        );
      }
      for (const v of value) {
        validateValidator(validator.value, v);
      }
      return;
    }
    case "union": {
      let isValid = false;
      for (const v of validator.value) {
        try {
          validateValidator(v, value);
          isValid = true;
          break;
        } catch {
          // Ignore
        }
      }
      if (!isValid) {
        throw new Error(
          `Validator error: Expected one of ${pipe(
            validator.value,
            Arr.map((v) => v.type),
            Arr.join(", "),
          )}, got \`${Json.stringify(convexToJson(value))}\``,
        );
      }
      return;
    }
    case "object": {
      if (typeof value !== "object") {
        throw new Error(
          `Validator error: Expected \`object\`, got \`${value}\``,
        );
      }
      if (!isSimpleObject(value)) {
        throw new Error(
          `Validator error: Expected a plain old JavaScript \`object\`, got \`${value}\``,
        );
      }
      for (const [k, { fieldType, optional }] of Rec.toEntries(
        validator.value,
      )) {
        if (value[k] === undefined) {
          if (!optional) {
            throw new Error(
              `Validator error: Missing required field \`${k}\` in object`,
            );
          }
        } else {
          validateValidator(fieldType, value[k]);
        }
      }
      for (const k of Rec.keys(value)) {
        if (validator.value[k] === undefined) {
          throw new Error(
            `Validator error: Unexpected field \`${k}\` in object`,
          );
        }
      }
      return;
    }
    case "function": {
      // The pinned binary, `precompiled-2026-10-28-cccbade`, accepts a string
      // that parses as a function handle
      // (`common/src/schemas/validator.rs:156-164`), and its parser requires a
      // document id after the prefix
      // (`common/src/bootstrap_model/components/handles.rs:100-112`). The
      // kernel mints convex-test's handle format instead, so it accepts a
      // string that parses as that format.
      if (
        typeof value !== "string" ||
        readFunctionHandle(value) === undefined
      ) {
        throw new Error(
          `Validator error: Expected a function handle, got \`${value}\``,
        );
      }
      return;
    }
    case "record": {
      if (
        value === null ||
        typeof value !== "object" ||
        !isSimpleObject(value)
      ) {
        throw new Error(
          `Validator error: Expected a plain old JavaScript \`object\` for a record, got \`${value}\``,
        );
      }
      for (const [k, fieldValue] of Rec.toEntries(value)) {
        validateValidator(validator.keys, k);
        if (fieldValue !== undefined) {
          validateValidator(validator.values.fieldType, fieldValue);
        }
      }
      return;
    }
    default: {
      const unknown: never = validator;
      throw new Error(
        `The test kernel cannot check a validator of type \`${(unknown as { type: string }).type}\`.`,
      );
    }
  }
}

export const JWT_CLAIM_BY_IDENTITY_ATTRIBUTE: Record<string, string> = {
  subject: "sub",
  issuer: "iss",
  name: "name",
  givenName: "given_name",
  familyName: "family_name",
  nickname: "nickname",
  preferredUsername: "preferred_username",
  profileUrl: "profile",
  pictureUrl: "picture",
  email: "email",
  emailVerified: "email_verified",
  gender: "gender",
  birthday: "birthdate",
  timezone: "zoneinfo",
  language: "locale",
  phoneNumber: "phone_number",
  phoneNumberVerified: "phone_number_verified",
  address: "address",
  updatedAt: "updated_at",
};

export function base64UrlEncode(value: string) {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

export function base64UrlEncodeBytes(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return pipe(
    btoa(binary),
    Str.replace(/\+/g, "-"),
    Str.replace(/\//g, "_"),
    Str.replace(/=+$/, ""),
  );
}

// Builds the token `withIdentity` pretends the request was authenticated with.
// Real tokens are signed by an identity provider; this one is unsecured
// (`"alg": "none"`, empty signature).
export function createTestJwt(identity: Record<string, any>) {
  const claims: Record<string, any> = Object.create(null);
  for (const [attribute, value] of Rec.toEntries(identity)) {
    if (value === undefined || attribute === "tokenIdentifier") {
      continue;
    }
    // Custom claims are used as is, known attributes use their claim name.
    const claimName = Rec.has(JWT_CLAIM_BY_IDENTITY_ATTRIBUTE, attribute)
      ? JWT_CLAIM_BY_IDENTITY_ATTRIBUTE[attribute]
      : attribute;
    claims[claimName] = value;
  }
  // The identity provider always determines who the user is.
  claims.iss = identity.issuer;
  claims.sub = identity.subject;
  const header = base64UrlEncode(Json.stringify({ alg: "none", typ: "JWT" }));
  const payload = base64UrlEncode(Json.stringify(claims));
  return `${header}.${payload}.`;
}

export function parseArgs(
  args: Record<string, Value> | undefined,
): Record<string, Value> {
  if (args === undefined) {
    return {};
  }
  if (!isSimpleObject(args)) {
    throw new Error(
      `The arguments to a Convex function must be an object. Received: ${
        args as any
      }`,
    );
  }
  return args;
}

export function validateFunctionArgs(
  argsValidator: ValidatorJSON,
  args: any,
  functionPath: FunctionPath,
  allowPendingValues: boolean,
) {
  if (!allowPendingValues && hasPendingValues(args)) {
    throw new Error(
      `Invalid arguments for "${functionPath.udfPath}": an unresolved ` +
        `placeholder value can only be passed to a query or mutation ` +
        `called from a mutation`,
    );
  }
  validateValidator(argsValidator, resolvePendingValues(args));
}

export function validateReturnValue(
  returnsValidator: ValidatorJSON | null,
  result: any,
  functionType: "query" | "mutation" | "action",
  functionPath: FunctionPath,
) {
  if (returnsValidator !== null) {
    try {
      validateValidator(returnsValidator, resolvePendingValues(result));
    } catch (e) {
      throw new Error(
        `Return value validation failed for ${functionType} "${functionPath.udfPath}":\n${(e as Error).message}`,
        { cause: e },
      );
    }
  }
}

const FUNCTION_HANDLE_PREFIX = "function://";

export function createFunctionHandle(functionPath: FunctionPath) {
  return `${FUNCTION_HANDLE_PREFIX}${functionPath.componentPath};${functionPath.udfPath}`;
}

/**
 * The function a handle the kernel minted names, or `undefined` for a string
 * that is not `function://<componentPath>;<udfPath>` with a function path.
 */
function readFunctionHandle(handle: string): FunctionPath | undefined {
  if (!pipe(handle, Str.startsWith(FUNCTION_HANDLE_PREFIX))) return undefined;
  const parts = pipe(
    handle,
    Str.slice(FUNCTION_HANDLE_PREFIX.length),
    Str.split(";"),
  );
  if (parts.length !== 2 || parts[1] === "") return undefined;
  return { componentPath: parts[0]!, udfPath: parts[1]! };
}

export function parseFunctionHandle(handle: string): FunctionPath {
  const functionPath = readFunctionHandle(handle);
  if (functionPath === undefined) {
    throw new Error(`Invalid function handle \`${handle}\``);
  }
  return functionPath;
}
export function simpleHash(string: string) {
  let hash = 0;
  for (let i = 0; i < string.length; i++) {
    const char = pipe(string, Str.charCodeAt(i), Option.getOrThrow);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash;
}
