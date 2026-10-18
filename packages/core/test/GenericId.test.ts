import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as GenericId from "@confect/core/GenericId";
import * as IdScope from "@confect/core/IdScope";
import * as Schema from "effect/Schema";

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
