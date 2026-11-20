import * as Result from "effect/Result";
import { quote } from "@confect/cli/Json";
import type { ManifestSection } from "@confect/core";
import { describe, expect, it } from "@effect/vitest";
import { builtIn, claims } from "@confect/cli/SectionFiles";
import * as Array from "effect/Array";
import * as Rec from "effect/Record";

const generating = (
  file: string,
  options: Pick<
    ManifestSection.Generate,
    "importedByFunctions" | "wrapsCrons"
  > = {},
): ManifestSection.ManifestSection => ({
  owner: "test/observe",
  format: 1,
  describe: () => null,
  generate: {
    file,
    match: () => true,
    render: () => ({ contents: "", errors: [] }),
    ...options,
  },
});
const declared = (
  sections: Readonly<Record<string, ManifestSection.ManifestSection>>,
) => Array.map(Rec.toEntries(sections), ([key, section]) => ({ key, section }));

describe("SectionFiles", () => {
  it("claims each declared generating section's file, ordered by file", () => {
    expect(
      Array.map(
        Result.getOrThrow(
          claims(
            declared({
              trace: generating("trace.ts"),
              tags: { owner: "test/tags", format: 1, describe: () => null },
              observe: generating("observe.ts"),
            }),
          ),
        ),
        ({ key, generate }) => [key, generate.file],
      ),
    ).toEqual([
      ["observe", "observe.ts"],
      ["trace", "trace.ts"],
    ]);
  });

  it("refuses a file two sections claim", () => {
    expect(
      claims(
        declared({
          observe: generating("observe.ts"),
          trace: generating("observe.ts"),
        }),
      ),
    ).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "InvalidManifestSectionError",
        sectionKey: "trace",
        reason:
          'claims confect/_generated/observe.ts, which the manifest section "observe" also claims.',
      },
    });
  });

  it("refuses routes.ts, which codegen writes for route specs", () => {
    expect(
      claims(declared({ observe: generating("routes.ts") })),
    ).toMatchObject({
      _tag: "Failure",
      failure: {
        sectionKey: "observe",
        reason:
          "claims confect/_generated/routes.ts, which codegen writes itself.",
      },
    });
  });

  it.each([...builtIn])("refuses the built-in file %s", (file) => {
    expect(claims(declared({ observe: generating(file) }))).toMatchObject({
      _tag: "Failure",
      failure: {
        sectionKey: "observe",
        reason: `claims confect/_generated/${file}, which codegen writes itself.`,
      },
    });
  });

  it("claims .json and .md files, which registered functions may leave out explicitly", () => {
    expect(
      Array.map(
        Result.getOrThrow(
          claims(
            declared({
              matrix: generating("role-matrix.md"),
              declarations: generating("declarations.json", {
                importedByFunctions: false,
                wrapsCrons: false,
              }),
            }),
          ),
        ),
        ({ key, generate }) => [key, generate.file],
      ),
    ).toEqual([
      ["declarations", "declarations.json"],
      ["matrix", "role-matrix.md"],
    ]);
  });

  it.each([
    "sectionInputs.json",
    "verifyInputs.json",
    "openapi.json",
    "sectionFiles.json",
  ])("refuses %s, a .json file codegen writes itself", (file) => {
    expect(claims(declared({ observe: generating(file) }))).toMatchObject({
      _tag: "Failure",
      failure: {
        sectionKey: "observe",
        reason: `claims confect/_generated/${file}, which codegen writes itself.`,
      },
    });
  });

  it.each([
    ["role-matrix.md", { importedByFunctions: true }, "importedByFunctions"],
    ["declarations.json", { wrapsCrons: true }, "wrapsCrons"],
  ] as const)(
    "refuses %s with %o, since only a .ts file is imported",
    (file, options, option) => {
      expect(
        claims(declared({ observe: generating(file, options) })),
      ).toMatchObject({
        _tag: "Failure",
        failure: {
          sectionKey: "observe",
          reason: `sets ${option} on confect/_generated/${file}, but only a .ts file is imported.`,
        },
      });
    },
  );

  it.each([
    "../observe.ts",
    "nested/observe.ts",
    "observe.js",
    ".ts",
    "nested/observe.json",
    "observe.txt",
    ".md",
  ])("refuses %s as a file name", (file) => {
    expect(claims(declared({ observe: generating(file) }))).toMatchObject({
      _tag: "Failure",
      failure: {
        sectionKey: "observe",
        reason: `claims ${quote(file)}; name a .ts, .json or .md file directly inside confect/_generated.`,
      },
    });
  });
});
