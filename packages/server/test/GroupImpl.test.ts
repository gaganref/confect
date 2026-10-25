import { FunctionSpec, GroupSpec, MiddlewareSpec } from "@confect/core";
import {
  FunctionImpl,
  GroupImpl,
  MiddlewareImpl,
  RegisteredFunctions,
} from "@confect/server";
import { expect, it } from "@effect/vitest";
import { internalQueryGeneric } from "convex/server";
import * as Effect from "effect/Effect";
import * as Array from "effect/Array";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import databaseSchema from "./mock-backend/fixtures/confect/_generated/schema";

class Required extends MiddlewareSpec.MiddlewareSpec<Required>()("Required", {
  functionTypes: { query: true, mutation: true, action: true },
}) {}

const covered = FunctionSpec.publicQuery({
  name: "covered",
  returns: () => Schema.String,
}).middleware(Required);
const first = FunctionSpec.publicQuery({
  name: "first",
  returns: () => Schema.String,
});
const second = FunctionSpec.internalQuery({
  name: "second",
  returns: () => Schema.String,
});

const build = (uncovered: ReadonlyArray<"first" | "second">) => {
  const group = GroupSpec.make()
    .addFunction(covered)
    .addFunction(
      uncovered.includes("first") ? first : first.middleware(Required),
    )
    .addFunction(
      uncovered.includes("second") ? second : second.middleware(Required),
    );
  const layer = GroupImpl.make(databaseSchema, group).pipe(
    Layer.provide(
      Array.map(["covered", "first", "second"] as const, (name) =>
        FunctionImpl.make(databaseSchema, group, name, () =>
          Effect.succeed("ok"),
        ),
      ),
    ),
    Layer.provide(
      MiddlewareImpl.make(databaseSchema, Required, (effect) => effect),
    ),
    GroupImpl.finalize,
    GroupImpl.finalize({ required: [Required] }),
  );
  return RegisteredFunctions.buildForGroup<typeof group>(databaseSchema, layer);
};

it.each([
  {
    uncovered: ["first"],
    message: 'GroupImpl.finalize: first requires middleware "Required"',
  },
  {
    uncovered: ["first", "second"],
    message:
      'GroupImpl.finalize: first requires middleware "Required"\nsecond requires middleware "Required"',
  },
] as const)(
  "names uncovered functions when the layer builds (%s)",
  ({ uncovered, message }) => {
    expect(() => build(uncovered)).toThrowError(message);
  },
);

it("builds when every registered function carries required middleware", () => {
  expect(Object.keys(build([])).toSorted()).toEqual([
    "covered",
    "first",
    "second",
  ]);
});

it("refuses raw internal Convex functions that cannot run required middleware", () => {
  const raw = internalQueryGeneric(() => "raw");
  const group = GroupSpec.make().addFunction(
    FunctionSpec.convexInternalQuery<typeof raw>()("raw"),
  );
  const layer = GroupImpl.make(databaseSchema, group).pipe(
    Layer.provide(FunctionImpl.make(databaseSchema, group, "raw", raw)),
    GroupImpl.finalize({ required: [Required] }),
  );
  expect(() =>
    RegisteredFunctions.buildForGroup<typeof group>(databaseSchema, layer),
  ).toThrowError('raw requires middleware "Required"');
});
