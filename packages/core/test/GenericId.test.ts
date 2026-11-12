import * as Result from "effect/Result";
import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as GenericId from "@confect/core/GenericId";
import * as IdScope from "@confect/core/IdScope";

describe("GenericId", () => {
  it("preserves the table-specific decoded and encoded types", () => {
    const id = GenericId.GenericId("users");

    expectTypeOf<typeof id.Type>().toEqualTypeOf<
      GenericId.GenericId<"users">
    >();
    expectTypeOf<typeof id.Encoded>().toEqualTypeOf<
      GenericId.GenericId<"users">
    >();
    expectTypeOf<typeof id>().toExtend<
      Schema.Codec<GenericId.GenericId<"users">>
    >();
    expectTypeOf<typeof id.Type>().not.toExtend<GenericId.GenericId<"posts">>();
  });

  it("constructs and round-trips candidate strings without validating their table", () => {
    const id = GenericId.GenericId("users");

    for (const value of ["", "candidate-id"]) {
      const constructed = id.make(value);
      expectTypeOf(constructed).toEqualTypeOf<GenericId.GenericId<"users">>();
      expect(constructed).toBe(value);
      expect(Result.getOrThrow(Schema.decodeUnknownResult(id)(value))).toBe(
        value,
      );
      expect(Result.getOrThrow(Schema.encodeResult(id)(constructed))).toBe(
        value,
      );
    }
    expect(() =>
      Result.getOrThrow(Schema.decodeUnknownResult(id)(42)),
    ).toThrow();
  });

  it("supports checks, annotations, and piping without losing the ID type", () => {
    const base = GenericId.GenericId("users");
    const id = base
      .check(Schema.isMinLength(1))
      .annotate({ title: "User ID" })
      .pipe(Schema.toType);

    expectTypeOf<typeof id.Type>().toEqualTypeOf<
      GenericId.GenericId<"users">
    >();
    expectTypeOf<typeof id.Encoded>().toEqualTypeOf<
      GenericId.GenericId<"users">
    >();
    expect(GenericId.tableName(id.ast)).toEqual(Option.some("users"));
    expect(id.make("candidate-id")).toBe("candidate-id");
    expect(() => id.make("")).toThrow();
    expect(() =>
      Result.getOrThrow(Schema.decodeUnknownResult(id)("")),
    ).toThrow();
    expect(base.make("")).toBe("");
  });

  it("supports ID-keyed records with record checks", () => {
    const counts = Schema.Record(
      GenericId.GenericId("shipmentLineItems"),
      Schema.Finite,
    ).check(Schema.isMinProperties(1));

    expectTypeOf<typeof counts.Type>().toEqualTypeOf<{
      readonly [id in GenericId.GenericId<"shipmentLineItems">]: number;
    }>();
    expectTypeOf<typeof counts.Encoded>().toEqualTypeOf<typeof counts.Type>();
    const value = { "candidate-id": 2 };
    const decoded = Result.getOrThrow(Schema.decodeResult(counts)(value));
    expect(decoded).toEqual(value);
    expect(Result.getOrThrow(Schema.encodeResult(counts)(decoded))).toEqual(
      value,
    );
    expect(() => Result.getOrThrow(Schema.decodeResult(counts)({}))).toThrow();
    expect(() =>
      Result.getOrThrow(
        Schema.decodeUnknownResult(counts)({ "candidate-id": "2" }),
      ),
    ).toThrow();
  });
});

describe("tableName", () => {
  it("returns the table name of the GenericId", () => {
    const expectedTableName = "users" as const;
    const id = GenericId.GenericId(expectedTableName);

    const actualTableName = GenericId.tableName(id.ast);

    expect(actualTableName).toStrictEqual(Option.some(expectedTableName));
  });
});

describe("rebase", () => {
  it("preserves recursive id-free records and nominal class values", () => {
    const from = IdScope.component("recursive");
    const to = IdScope.instance(IdScope.app, "first");
    interface Tree {
      readonly name: string;
      readonly children: ReadonlyArray<Tree>;
    }
    const Tree: Schema.Codec<Tree> = Schema.Struct({
      name: Schema.String,
      children: Schema.Array(Schema.suspend(() => Tree)),
    });
    const tree: Tree = Schema.decodeSync(GenericId.rebase(Tree, from, to))({
      name: "root",
      children: [{ name: "child", children: [] }],
    });
    expect(tree.children[0]?.name).toBe("child");

    interface NodeEncoded {
      readonly name: string;
      readonly children: ReadonlyArray<NodeEncoded>;
    }
    class Node extends Schema.Class<Node>("RecursiveNode")({
      name: Schema.String,
      children: Schema.Array(
        Schema.suspend((): Schema.Codec<Node, NodeEncoded> => Node),
      ),
    }) {
      private readonly marker = "node";
      text() {
        return `${this.marker}:${this.name}`;
      }
    }
    const node: Node = Schema.decodeSync(GenericId.rebase(Node, from, to))({
      name: "root",
      children: [{ name: "child", children: [] }],
    });
    expect(node.children[0]?.text()).toBe("node:child");
  });

  it("rebases IDs in recursive records at every level", () => {
    const from = IdScope.component("recursive-ids");
    const to = IdScope.instance(IdScope.app, "first");
    const Id = GenericId.GenericId("items", from);
    interface Tree {
      readonly id: typeof Id.Type;
      readonly children: ReadonlyArray<Tree>;
    }
    const Tree: Schema.Codec<Tree> = Schema.Struct({
      id: Id,
      children: Schema.Array(Schema.suspend(() => Tree)),
    });
    const rebound = GenericId.rebase(Tree, from, to);
    const value = Schema.decodeUnknownSync(rebound)({
      id: "root",
      children: [{ id: "child", children: [] }],
    });
    const child: GenericId.GenericId<"items", typeof to> =
      value.children[0]!.id;
    expect(child).toBe("child");
    // @ts-expect-error Recursive children no longer belong to the definition scope.
    const definition: typeof Id.Type = child;
    void definition;
  });

  it("preserves exclusive union validation while rebasing IDs", () => {
    const definition = IdScope.component("counter");
    const installation = IdScope.instance(IdScope.app, "first");
    const input = Schema.Union(
      [GenericId.GenericId("items", definition), Schema.Literal("overlap")],
      { mode: "oneOf" },
    );
    const bound = GenericId.rebase(input, definition, installation);

    expect(Schema.is(input)("overlap")).toBe(false);
    expect(Schema.is(bound)("overlap")).toBe(false);
    expect(Schema.decodeUnknownSync(bound)("item")).toBe("item");
    expect(() => Schema.decodeSync(bound)("overlap")).toThrow();
  });
});
