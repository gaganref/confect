import * as Result from "effect/Result";
import type { ManifestSection } from "@confect/core";
import { describe, expect, it } from "@effect/vitest";
import { builtIn, claims } from "@confect/cli/SectionFiles";

const generating = (file: string): ManifestSection.ManifestSection => ({
  owner: "test/observe",
  format: 1,
  describe: () => null,
  generate: {
    file,
    match: () => true,
    render: () => ({ contents: "", errors: [] }),
  },
});
const declared = (
  sections: Readonly<Record<string, ManifestSection.ManifestSection>>,
) => Object.entries(sections).map(([key, section]) => ({ key, section }));

describe("SectionFiles", () => {
  it("claims each declared generating section's file, ordered by file", () => {
    expect(
      Result.getOrThrow(
        claims(
          declared({
            trace: generating("trace.ts"),
            tags: { owner: "test/tags", format: 1, describe: () => null },
            observe: generating("observe.ts"),
          }),
        ),
      ).map(({ key, generate }) => [key, generate.file]),
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

  it.each([...builtIn])("refuses the built-in file %s", (file) => {
    expect(claims(declared({ observe: generating(file) }))).toMatchObject({
      _tag: "Failure",
      failure: {
        sectionKey: "observe",
        reason: `claims confect/_generated/${file}, which codegen writes itself.`,
      },
    });
  });

  it.each(["../observe.ts", "nested/observe.ts", "observe.js", ".ts"])(
    "refuses %s as a file name",
    (file) => {
      expect(claims(declared({ observe: generating(file) }))).toMatchObject({
        _tag: "Failure",
        failure: {
          sectionKey: "observe",
          reason: `claims ${JSON.stringify(file)}; name a .ts file directly inside confect/_generated.`,
        },
      });
    },
  );
});
