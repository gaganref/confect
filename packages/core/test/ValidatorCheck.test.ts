import { ValidatorCheck } from "@confect/core";
import { CommitTsPlaceholder, type GenericValidator, v } from "convex/values";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { describe, expect, it } from "@effect/vitest";

const owner = v.object({ table: v.string(), field: v.string() });
const opened = v.array(
  v.union(
    v.object({ kind: v.literal("missing"), owner }),
    v.object({ kind: v.literal("opened"), owner, row: v.id("ledger") }),
  ),
);

/**
 * A backend that knows `ledger:1` and `_storage:1`, and asks for each ID's
 * table by name.
 */
const asked: Array<readonly [string, string]> = [];
const lookups: ValidatorCheck.Lookups = {
  tableOf: (id, expected) => {
    asked.push([id, expected]);
    return { "ledger:1": "ledger", "_storage:1": "_storage" }[id];
  },
  isFunctionHandle: (value) => value === "handle:1",
};

const ownerValue = { table: "students", field: "aadhaar" };

describe("ValidatorCheck.check", () => {
  it("accepts a value the validator accepts, and asks for an ID by the table it names", () => {
    asked.length = 0;
    expect(
      ValidatorCheck.check(
        opened,
        [
          { kind: "opened", owner: ownerValue, row: "ledger:1" },
          { kind: "missing", owner: ownerValue },
        ],
        lookups,
      ),
    ).toBeUndefined();
    expect(asked).toEqual([["ledger:1", "ledger"]]);
  });

  it("reports a union's mismatch at the union, as the binary does", () => {
    expect(
      ValidatorCheck.check(
        opened,
        [{ kind: "opened", owner: ownerValue, row: "_storage:1" }],
        lookups,
      ),
    ).toMatchObject({ kind: "noMatch", path: "[0]" });
  });

  it("names a system table an ID came from, and a table of another name", () => {
    expect(
      ValidatorCheck.check(v.id("ledger"), "_storage:1", lookups),
    ).toMatchObject({
      kind: "system",
      tableName: "ledger",
    });
    expect(
      ValidatorCheck.check(v.id("entries"), "ledger:1", lookups),
    ).toMatchObject({
      kind: "table",
      found: "ledger",
      tableName: "entries",
    });
    expect(
      ValidatorCheck.check(v.id("ledger"), "nothing", lookups),
    ).toMatchObject({
      kind: "noMatch",
    });
  });

  it("finds a missing field before an extra one, each at its object", () => {
    expect(
      ValidatorCheck.check(
        v.object({ owner }),
        { owner: { table: "t", note: "x" } },
        lookups,
      ),
    ).toMatchObject({ kind: "missing", path: ".owner", field: "field" });
    expect(
      ValidatorCheck.check(
        v.object({ owner }),
        { owner: { ...ownerValue, note: "x" } },
        lookups,
      ),
    ).toMatchObject({ kind: "extra", path: ".owner", field: "note" });
  });

  it("checks a function handle by the backend's own format", () => {
    expect(
      ValidatorCheck.check(v.function(), "handle:1", lookups),
    ).toBeUndefined();
    expect(
      ValidatorCheck.check(v.function(), "handle:2", lookups),
    ).toMatchObject({
      kind: "noMatch",
    });
  });
});

describe("ValidatorCheck.check, as the binary reads a value", () => {
  const plain = { tableOf: () => undefined, isFunctionHandle: () => false };

  it("reads only own properties", () => {
    const toStringOptional = v.object({
      toString: v.optional(v.string()),
      value: v.string(),
    });
    expect(
      ValidatorCheck.check(toStringOptional, { value: "x" }, plain),
    ).toBeUndefined();
    expect(
      ValidatorCheck.check(
        v.object({ constructor: v.any(), value: v.string() }),
        { value: "x" },
        plain,
      ),
    ).toMatchObject({ kind: "missing", field: "constructor" });
  });

  it("drops a record's undefined values before it checks them", () => {
    expect(
      ValidatorCheck.check(
        v.record(v.string(), v.string()),
        { a: undefined, b: "x" },
        plain,
      ),
    ).toBeUndefined();
  });

  it("checks a pending commit timestamp as the largest int64 in every kind", () => {
    const pending = new CommitTsPlaceholder();
    const verdict = (validator: GenericValidator) =>
      ValidatorCheck.check(validator, pending, plain) === undefined;
    expect({
      int64: verdict(v.int64()),
      commitTs: verdict(v.commitTs()),
      any: verdict(v.any()),
      max: verdict(v.literal(9223372036854775807n)),
      other: verdict(v.literal(0n)),
      float64: verdict(v.float64()),
      nested:
        ValidatorCheck.check(
          v.object({ at: v.array(v.int64()) }),
          { at: [pending] },
          plain,
        ) === undefined,
    }).toEqual({
      int64: true,
      commitTs: true,
      any: true,
      max: true,
      other: false,
      float64: false,
      nested: true,
    });
  });

  it("takes as an object only what convex's isSimpleObject does", () => {
    class Instance {
      readonly value = "x";
    }
    expect(
      Arr.map(
        [
          {},
          Object.create(null),
          // oxlint-disable-next-line effecttsgo/global-date -- A Date is the class instance convex refuses as an object.
          new Date(),
          new Map(),
          new Set(),
          new Instance(),
          new Uint8Array(1),
          [],
        ],
        ValidatorCheck.isPlainObject,
      ),
    ).toEqual([true, true, false, false, false, false, false, false]);
  });
});

describe("ValidatorCheck.printValidator", () => {
  it("prints every literal as <secret> when literals are masked", () => {
    const validator = v.object({
      kind: v.literal("canary-literal-1d9f"),
      maybe: v.optional(v.literal("canary-literal-2a71")),
      list: v.array(v.union(v.literal(1), v.literal(true))),
      map: v.record(v.string(), v.literal(5n)),
    });
    expect(ValidatorCheck.printValidator(validator, "masked")).toBe(
      "v.object({kind: v.literal(<secret>), list: v.array(v.union(v.literal(<secret>), v.literal(<secret>))), map: v.record(v.string(), v.literal(<secret>)), maybe: v.optional(v.literal(<secret>))})",
    );
    expect(ValidatorCheck.printValidator(validator)).toContain(
      'v.literal("canary-literal-1d9f")',
    );
  });
});

describe("ValidatorCheck.declarationProblem", () => {
  it.each([
    [
      "a-b",
      "Identifier a-b has invalid character '-': Identifiers can only contain alphanumeric characters or underscores",
    ],
    [
      "x y",
      "Identifier x y has invalid character ' ': Identifiers can only contain alphanumeric characters or underscores",
    ],
    ["$x", "Field name $x starts with '$', which is reserved."],
    [
      "é",
      "Field name é has invalid character 'é': Field names can only contain non-control ASCII characters",
    ],
    ["", "Identifier cannot be empty"],
    [
      "1a",
      "Invalid first character '1' in 1a: Identifiers must start with an alphabetic character or underscore",
    ],
    [Str.repeat(65)("a"), "Identifier is too long (65 > maximum 64)"],
  ])("refuses the field %j as the binary's push does", (name, problem) => {
    expect(
      ValidatorCheck.declarationProblem(
        v.array(v.object({ [name]: v.string() })),
      ),
    ).toBe(problem);
  });

  it("names each object field a nested problem sits under, as the binary does", () => {
    expect(
      ValidatorCheck.declarationProblem(
        v.object({
          outer: v.array(
            v.object({
              inner: v.union(v.object({ "a-b": v.string() }), v.null()),
            }),
          ),
        }),
      ),
    ).toBe(
      "Invalid validator for key `outer`: Invalid validator for key `inner`: Identifier a-b has invalid character '-': Identifiers can only contain alphanumeric characters or underscores",
    );
  });

  it.each(["_x", "_id", "A_9", Str.repeat(64)("a")])(
    "takes the field %j",
    (name) => {
      expect(
        ValidatorCheck.declarationProblem(v.object({ [name]: v.string() })),
      ).toBeUndefined();
    },
  );
});
