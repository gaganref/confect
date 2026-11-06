import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import {
  FunctionSpec,
  GroupSpec,
  MiddlewareSpec,
  type ManifestSection,
} from "@confect/core";
import { describe, expect, it } from "@effect/vitest";
import { collect, summarize } from "@confect/cli/ManifestSections";

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
const summarized = (
  summarizeTags: NonNullable<ManifestSection.Any["summarize"]>,
) => {
  const p = FunctionSpec.extend()({
    middleware: [],
    manifest: { tags: { ...section, summarize: summarizeTags } },
  });
  const modules = [{ relativePath: "billing/log.ts", exports: { level: 1 } }];
  return collect(leaf(GroupSpec.make().addFunction(p.publicQuery(list)))).pipe(
    Result.flatMap((registry) =>
      summarize(registry, new Map([["tags", modules]])),
    ),
  );
};

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
  it("serializes shared objects without treating them as a cycle", () => {
    const shared = { label: "shared" };
    const p = FunctionSpec.extend()({
      middleware: [],
      manifest: {
        tags: { ...section, describe: () => ({ left: shared, right: shared }) },
      },
    });
    expect(
      Result.getOrThrow(
        collect(leaf(GroupSpec.make().addFunction(p.publicQuery(list)))),
      ).get("tags")?.data,
    ).toEqual({
      format: 1,
      functions: {
        "notes:list": { left: { label: "shared" }, right: { label: "shared" } },
      },
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
  it("replaces a section's data with what summarize builds from its modules and descriptions", () => {
    const tags = Result.getOrThrow(
      summarized(({ modules, functions }) => ({
        format: 1,
        levels: modules.map(({ exports }) => exports.level),
        functions,
      })),
    ).get("tags");
    expect(tags?.data).toEqual({
      format: 1,
      levels: [1],
      functions: { "notes:list": [] },
    });
  });
  it.each([
    {
      returned: "a throw",
      summarizeTags: () => {
        throw new Error("no levels");
      },
      reason: "summarize failed: Error: no levels",
    },
    {
      returned: "a Map",
      summarizeTags: () => ({ format: 1, levels: new Map() }),
      reason: 'could not summarize as JSON: Expected JSON data at $["levels"]',
    },
    ...[
      // oxlint-disable-next-line effecttsgo/global-date -- The refusal is of the raw Date value itself.
      { returned: "a Date", value: new Date(0) },
      {
        returned: "a class instance with toJSON",
        value: new (class Level {
          toJSON() {
            return { n: 1 };
          }
        })(),
      },
      { returned: "a symbol key", value: { [Symbol("s")]: 1 } },
      {
        returned: "an array with toJSON",
        value: Object.assign([1], { toJSON: () => ({ n: 1 }) }),
      },
      {
        returned: "an array with a symbol key",
        value: Object.assign([1], { [Symbol("s")]: 1 }),
      },
      // oxlint-disable-next-line no-sparse-arrays -- The refusal is of the hole itself.
      { returned: "an array with a hole", value: [1, , 2], at: '["1"]' },
      {
        returned: "an array subclass",
        value: new (class Levels extends Array {})(),
      },
      {
        returned: "a hidden toJSON",
        value: Object.defineProperty({}, "toJSON", { value: () => ({ n: 1 }) }),
        at: '["toJSON"]',
      },
      {
        returned: "a hidden property",
        value: Object.defineProperty({}, "n", { value: 1 }),
        at: '["n"]',
      },
      {
        returned: "a getter",
        value: {
          get n() {
            return 1;
          },
        },
        at: '["n"]',
      },
    ].map(({ returned, value, at = "" }) => ({
      returned,
      summarizeTags: () => ({ format: 1, at: value }),
      reason: `could not summarize as JSON: Expected JSON data at $["at"]${at}`,
    })),
    {
      returned: "another format",
      summarizeTags: () => ({ format: 2 }),
      reason: "summarize must return data with format 1.",
    },
    {
      returned: "an array",
      summarizeTags: () => [] as never,
      reason: "summarize must return data with format 1.",
    },
  ])(
    "refuses a summarize that returns $returned",
    ({ summarizeTags, reason }) => {
      expect(summarized(summarizeTags)).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "InvalidManifestSectionError",
          sectionKey: "tags",
          reason,
        },
      });
    },
  );
});
