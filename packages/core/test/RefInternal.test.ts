import { describe, expect, expectTypeOf, test } from "@effect/vitest";
import { Ref as BarrelRef } from "@confect/core";
import * as Core from "@confect/core";
import * as FunctionSpec from "@confect/core/FunctionSpec";
import * as Ref from "@confect/core/Ref";
import { getFunctionReference } from "@confect/core/RefInternal";
import { getFunctionAddress, makeFunctionReference } from "convex/server";
import type { FunctionReference } from "convex/server";
import * as Schema from "effect/Schema";

// @ts-expect-error The barrel's Ref no longer exposes the converter.
export type BarrelConverter = typeof BarrelRef.getFunctionReference;
// @ts-expect-error The Ref subpath no longer exposes the converter.
export type RefConverter = typeof Ref.getFunctionReference;
// @ts-expect-error RefInternal is available only as a subpath.
export type InternalNamespace = typeof Core.RefInternal;

describe("getFunctionReference", () => {
  const ref = Ref.make(
    "notes",
    FunctionSpec.publicQuery({
      name: "list",
      returns: () => Schema.Void,
    }),
  );

  test("is available only through its own subpath", () => {
    expect(BarrelRef).not.toHaveProperty("getFunctionReference");
  });

  test("keeps RefInternal out of the package barrel", () => {
    expect(Core).not.toHaveProperty("RefInternal");
  });

  test("preserves the function address, kind, and visibility", () => {
    const reference = getFunctionReference(ref);
    expectTypeOf(reference).toEqualTypeOf<
      FunctionReference<"query", "public">
    >();
    expect(getFunctionAddress(reference)).toEqual({ name: "notes:list" });
  });

  test("reuses references for the same function name", () => {
    const equivalent = Ref.make(
      "notes",
      FunctionSpec.publicQuery({ name: "list", returns: () => Schema.Void }),
    );
    expect(getFunctionReference(equivalent)).toBe(getFunctionReference(ref));
  });

  test("distinct function names produce distinct references", () => {
    const other = Ref.make(
      "notes",
      FunctionSpec.publicQuery({ name: "get", returns: () => Schema.Void }),
    );
    expect(getFunctionReference(ref)).not.toBe(getFunctionReference(other));
  });

  test("preserves a supplied native reference", () => {
    const native = makeFunctionReference<"mutation">("counter:add");
    getFunctionReference(
      Ref.make(
        "counter",
        FunctionSpec.publicMutation({
          name: "add",
          returns: () => Schema.Void,
        }),
      ),
    );
    expect(getFunctionReference(Ref.fromFunctionReference(native))).toBe(
      native,
    );
  });
});
