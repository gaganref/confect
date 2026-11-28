import * as IdScope from "@confect/core/IdScope";
import * as ValidatorCheck from "@confect/core/ValidatorCheck";
import { v } from "convex/values";
import * as Schema from "effect/Schema";
import { assert, describe, expect, it } from "@effect/vitest";
import type * as RegisteredConvexFunction from "@confect/server/RegisteredConvexFunction";
import * as SecretSides from "../../src/internal/secretSides";

const marker = "canary-unit-3f8c";

const lookups = SecretSides.databaseLookups({
  // A legacy string normalizes to a modern ID of the same document.
  normalizeId: (_table, id) => (id === "legacy" ? "modern" : id),
  system: { normalizeId: () => null },
});

const definition = SecretSides.define(
  {
    name: "store",
    args: Schema.Struct({ value: Schema.RedactedFromValue(Schema.String) }),
    returns: Schema.Null,
    scope: IdScope.app,
    reservedArgument: undefined,
    lookups: () => lookups,
  },
  () => Promise.resolve(null),
);

const refusalOf = (promise: Promise<unknown>) =>
  promise.then(
    () => expect.unreachable("the call was not refused"),
    (error: unknown) => {
      assert(error instanceof SecretSides.SecretSideRefused);
      return error;
    },
  );

describe("SecretSides.define", () => {
  it.each([0, 2, 3])(
    "refuses %i arguments as Convex's validator does, printing none of them",
    (count) =>
      refusalOf(
        definition.handler(
          {},
          ...Array.from({ length: count }, () => ({ value: marker })),
        ),
      ).then((error) =>
        expect({
          message: error.message,
          data: error.data,
        }).toEqual({
          message: `Expected to receive a single object as the function's argument. Instead received ${count} arguments.\nValidator: v.object({value: v.string()})`,
          data: {
            _tag: SecretSides.refusalTag,
            side: "arguments",
            path: "",
            validator: "v.object({value: v.string()})",
          },
        }),
      ),
  );

  it("takes one argument", () =>
    definition
      .handler({}, { value: marker })
      .then((result) => expect(result).toBeNull()));
});

describe("SecretSides.databaseLookups", () => {
  it("names a table only for an ID normalizeId returns unchanged", () => {
    expect([
      lookups.tableOf("modern", "notes"),
      lookups.tableOf("legacy", "notes"),
      ValidatorCheck.check(v.id("notes"), "legacy", lookups)?.kind,
    ]).toEqual(["notes", undefined, "noMatch"]);
  });
});

describe("RegisteredConvexFunction.ConvexDefinition", () => {
  it("lets a definition hook pass every argument a caller sent", () => {
    const hook: RegisteredConvexFunction.DefinitionHook = (_, registered) => ({
      ...registered,
      handler: (ctx, ...args) => registered.handler(ctx, ...args),
    });
    const seen: Array<number> = [];
    const wrapped = hook("public", {
      handler: (_ctx, ...args) => {
        seen.push(args.length);
        return null;
      },
    });
    wrapped.handler({}, { value: marker }, { extra: true });
    expect(seen).toEqual([2]);
  });
});
