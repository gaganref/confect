import { ValidatorCheck } from "@confect/core";
import { v } from "convex/values";
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
