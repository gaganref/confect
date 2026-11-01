import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import { FunctionSpec, GroupSpec, MiddlewareSpec } from "@confect/core";
import { describe, expect, it } from "@effect/vitest";
import { collect } from "@confect/cli/ManifestSections";

const section = {
  owner: "test/tags",
  format: 1,
  describe: ({ middleware }: { middleware: ReadonlyArray<{ key: string }> }) =>
    middleware.map(({ key }) => key),
};
const profile = FunctionSpec.extend()({
  middleware: [],
  manifest: { tags: section },
});
const leaf = (spec: GroupSpec.AnyWithProps) => [
  { relativePath: "notes.spec.ts", pathSegments: ["notes"] as const, spec },
];
const list = { name: "list", returns: () => Schema.Void } as const;

describe("ManifestSections", () => {
  it("describes nested functions with group and function middleware", () => {
    class Group extends MiddlewareSpec.MiddlewareSpec<Group>()("group", {
      functionTypes: { query: false, mutation: true, action: false },
    }) {}
    class Function extends MiddlewareSpec.MiddlewareSpec<Function>()(
      "function",
      { functionTypes: { query: false, mutation: true, action: false } },
    ) {}
    const group = GroupSpec.make()
      .middleware(Group)
      .addFunction(
        profile
          .publicMutation({ name: "save", returns: () => Schema.Void })
          .middleware(Function),
      );
    const tree = GroupSpec.addGroupsAt(GroupSpec.make(), { child: group });
    expect(Result.getOrThrow(collect(leaf(tree))).get("tags")?.data).toEqual({
      format: 1,
      functions: { "notes/child:save": ["group", "function"] },
    });
  });
  it.each("name env http digest __proto__ constructor prototype".split(" "))(
    "refuses %s once",
    (key) => {
      const p = FunctionSpec.extend()({
        middleware: [],
        manifest: { [key]: section },
      });
      const group = GroupSpec.make()
        .addFunction(p.publicQuery(list))
        .addFunction(p.publicQuery({ ...list, name: "other" }));
      expect(collect(leaf(group))).toMatchObject({
        _tag: "Failure",
        failure: {
          declarationPath: "confect/notes.spec.ts",
          reason: `Manifest section "${key}" (notes:list): shadows a built-in key.`,
        },
      });
    },
  );
  it.each([{ owner: "other/tags" }, { format: 2 }])(
    "refuses conflicting definitions %j",
    (difference) => {
      const child = profile.extend()({
        middleware: [],
        manifest: { tags: { ...section, ...difference } },
      });
      expect(
        collect(leaf(GroupSpec.make().addFunction(child.publicQuery(list)))),
      ).toMatchObject({
        _tag: "Failure",
        failure: {
          declarationPath: "confect/notes.spec.ts",
          reason: `Manifest section "tags" (notes:list): conflicts between test/tags (format 1) and ${difference.owner ?? "test/tags"} (format ${difference.format ?? 1}).`,
        },
      });
    },
  );
});
