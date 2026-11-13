import * as Schema from "effect/Schema";
import { stringify } from "@confect/cli/Json";
import * as Result from "effect/Result";
import {
  FunctionSpec,
  GroupSpec,
  MiddlewareSpec,
  type ManifestSection,
} from "@confect/core";
import { describe, expect, it } from "@effect/vitest";
import {
  collect,
  declared,
  refuseSpecSections,
  summarize,
} from "@confect/cli/ManifestSections";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import * as Record from "effect/Record";

const section = {
  owner: "test/tags",
  format: 1,
  describe: ({ middleware }: { middleware: ReadonlyArray<{ key: string }> }) =>
    Arr.map(middleware, ({ key }) => key),
};
const tags = (tagsSection: ManifestSection.Any = section) => [
  { key: "tags", section: tagsSection },
];
const leaf = (spec: GroupSpec.AnyWithProps) => [
  { relativePath: "notes.spec.ts", pathSegments: ["notes"] as const, spec },
];
const list = { name: "list", returns: () => Schema.Void } as const;
const summarized = (
  summarizeTags: NonNullable<ManifestSection.Any["summarize"]>,
) => {
  const modules = [{ relativePath: "billing/log.ts", exports: { level: 1 } }];
  return collect(
    tags({ ...section, summarize: summarizeTags }),
    leaf(GroupSpec.make().addFunction(FunctionSpec.publicQuery(list))),
  ).pipe(
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
        FunctionSpec.publicMutation({
          name: "save",
          returns: () => Schema.Void,
        }).middleware(Function),
      );
    const tree = GroupSpec.addGroupsAt(GroupSpec.make(), { child: group });
    expect(
      Result.getOrThrow(collect(tags(), leaf(tree))).get("tags")?.data,
    ).toEqual({
      format: 1,
      functions: { "notes/child:save": ["group", "function"] },
    });
  });
  it("describes a function from every builder alike", () => {
    const profile = FunctionSpec.extend()({ middleware: [] });
    const group = GroupSpec.make()
      .addFunction(FunctionSpec.publicQuery(list))
      .addFunction(FunctionSpec.internalMutation({ ...list, name: "raw" }))
      .addFunction(profile.publicMutation({ ...list, name: "profiled" }));
    expect(
      Result.getOrThrow(
        collect(
          tags({ ...section, describe: ({ spec }) => spec.name }),
          leaf(group),
        ),
      ).get("tags")?.data,
    ).toEqual({
      format: 1,
      functions: {
        "notes:list": "list",
        "notes:raw": "raw",
        "notes:profiled": "profiled",
      },
    });
  });
  it("collects each section's functions in path order whatever order the leaves load in", () => {
    const group = GroupSpec.make()
      .addFunction(FunctionSpec.publicQuery({ ...list, name: "b" }))
      .addFunction(FunctionSpec.publicQuery({ ...list, name: "a" }));
    const leaves = Arr.map(["Z", "m", "m/n", "b"], (name) => ({
      relativePath: `${name}.spec.ts`,
      pathSegments: pipe(name, Str.split("/")) as [string, ...string[]],
      spec: group,
    }));
    const collected = (ordered: typeof leaves) => {
      const entry = Result.getOrThrow(
        collect(tags({ ...section, describe: ({ path }) => path }), ordered),
      ).get("tags")!;
      return {
        bytes: stringify([entry.data, entry.sources]),
        paths: Record.keys(entry.data.functions),
      };
    };
    const forward = collected(leaves);
    // `/` sorts before `:`, so a nested group's functions precede its parent's.
    expect(forward.paths).toEqual([
      "Z:a",
      "Z:b",
      "b:a",
      "b:b",
      "m/n:a",
      "m/n:b",
      "m:a",
      "m:b",
    ]);
    expect(collected(Arr.reverse(leaves))).toEqual(forward);
    expect(collected([leaves[2]!, leaves[0]!, leaves[3]!, leaves[1]!])).toEqual(
      forward,
    );
  });
  it("keeps every declared section when the backend has no functions", () => {
    const registry = Result.getOrThrow(
      collect([...tags(), { key: "other", section }], []),
    );
    expect(Arr.map([...registry], ([key, { data }]) => [key, data])).toEqual([
      ["tags", { format: 1, functions: {} }],
      ["other", { format: 1, functions: {} }],
    ]);
  });
  it("serializes shared objects without treating them as a cycle", () => {
    const shared = { label: "shared" };
    expect(
      Result.getOrThrow(
        collect(
          tags({
            ...section,
            describe: () => ({ left: shared, right: shared }),
          }),
          leaf(GroupSpec.make().addFunction(FunctionSpec.publicQuery(list))),
        ),
      ).get("tags")?.data,
    ).toEqual({
      format: 1,
      functions: {
        "notes:list": { left: { label: "shared" }, right: { label: "shared" } },
      },
    });
  });
  it("names the spec file and the function a describe refuses", () => {
    expect(
      collect(
        tags({
          ...section,
          describe: () => {
            throw new Error("refused");
          },
        }),
        leaf(GroupSpec.make().addFunction(FunctionSpec.publicQuery(list))),
      ),
    ).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "InvalidDeclarationError",
        declarationPath: "confect/notes.spec.ts",
        reason: 'Manifest section "tags" (notes:list): Error: refused',
      },
    });
  });
  it.each(
    pipe(
      "name env http digest __proto__ constructor prototype",
      Str.split(" "),
    ),
  )("refuses the built-in key %s on App.make", (key) => {
    expect(declared([{ key, section }])).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "InvalidDeclarationError",
        declarationPath: "confect/app.ts",
        reason: `Manifest section "${key}" shadows a built-in key.`,
      },
    });
  });
  it("refuses a key App.make declares twice", () => {
    expect(declared([...tags(), ...tags()])).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "InvalidDeclarationError",
        declarationPath: "confect/app.ts",
        reason: 'Manifest section "tags" is declared twice.',
      },
    });
  });
  it("accepts distinct keys on App.make", () => {
    expect(
      Result.isSuccess(declared([...tags(), { key: "other", section }])),
    ).toBe(true);
  });
  it("refuses a function spec that carries manifest sections and points at App.make", () => {
    const tagged = Object.assign(FunctionSpec.publicQuery(list), {
      manifestSections: tags(),
    });
    const group = GroupSpec.addGroupsAt(
      GroupSpec.make().addFunction(FunctionSpec.publicQuery(list)),
      { child: GroupSpec.make().addFunction(tagged) },
    );
    expect(refuseSpecSections(leaf(group))).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "InvalidDeclarationError",
        declarationPath: "confect/notes.spec.ts",
        reason:
          "notes/child:list carries manifestSections, which codegen no longer reads from a function spec. Declare the backend's manifest sections once, on App.make({ manifestSections }) in confect/app.ts.",
      },
    });
    expect(
      Result.isSuccess(
        refuseSpecSections(
          leaf(GroupSpec.make().addFunction(FunctionSpec.publicQuery(list))),
        ),
      ),
    ).toBe(true);
  });
  it("replaces a section's data with what summarize builds from its modules and descriptions", () => {
    const summary = Result.getOrThrow(
      summarized(({ modules, functions }) => ({
        format: 1,
        levels: Arr.map(modules, ({ exports }) => exports.level),
        functions,
      })),
    ).get("tags");
    expect(summary?.data).toEqual({
      format: 1,
      levels: [1],
      functions: { "notes:list": [] },
    });
  });
  it("hands summarize the spec file that declares each function", () => {
    const notes = GroupSpec.addGroupsAt(
      GroupSpec.make().addFunction(FunctionSpec.publicQuery(list)),
      {
        child: GroupSpec.make().addFunction(
          FunctionSpec.publicMutation({
            name: "save",
            returns: () => Schema.Void,
          }),
        ),
      },
    );
    const leaves = [
      {
        relativePath: "inbox/inbox.spec.ts",
        pathSegments: ["inbox", "inbox"] as const,
        spec: GroupSpec.make().addFunction(FunctionSpec.publicQuery(list)),
      },
      ...leaf(notes),
    ];
    expect(
      Result.getOrThrow(
        collect(
          tags({
            ...section,
            summarize: ({ sources }) => ({ format: 1, sources }),
          }),
          leaves,
        ).pipe(Result.flatMap((registry) => summarize(registry, new Map()))),
      ).get("tags")?.data,
    ).toEqual({
      format: 1,
      sources: {
        "inbox/inbox:list": "inbox/inbox.spec.ts",
        "notes:list": "notes.spec.ts",
        "notes/child:save": "notes.spec.ts",
      },
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
    ...Arr.map(
      [
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
          returned: "an array with its own keys",
          value: Object.assign([1], { keys: 1 }),
        },
        {
          returned: "an array whose methods are its own throwing getters",
          value: Object.defineProperties(
            [1],
            Record.fromEntries(
              Arr.map(
                [
                  "keys",
                  "values",
                  "entries",
                  "forEach",
                  "map",
                  "every",
                  "some",
                  Symbol.iterator,
                ],
                (name) => [
                  name,
                  {
                    get: () => {
                      throw new Error(`${String(name)} getter ran`);
                    },
                  },
                ],
              ),
            ),
          ),
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
          value: Object.defineProperty({}, "toJSON", {
            value: () => ({ n: 1 }),
          }),
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
      ],
      ({ returned, value, at = "" }) => ({
        returned,
        summarizeTags: () => ({ format: 1, at: value }),
        reason: `could not summarize as JSON: Expected JSON data at $["at"]${at}`,
      }),
    ),
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
