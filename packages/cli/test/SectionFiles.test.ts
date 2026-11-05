import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import { FunctionSpec, GroupSpec, type ManifestSection } from "@confect/core";
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
const leaf = (
  sections: Readonly<Record<string, ManifestSection.ManifestSection>>,
) => {
  const profile = FunctionSpec.extend()({ middleware: [], manifest: sections });
  const spec = GroupSpec.make()
    .addFunction(
      profile.publicQuery({ name: "list", returns: () => Schema.Void }),
    )
    .addFunction(
      profile.publicQuery({ name: "get", returns: () => Schema.Void }),
    );
  return [
    { relativePath: "notes.spec.ts", pathSegments: ["notes"] as const, spec },
  ];
};

describe("SectionFiles", () => {
  it("claims a section's file once however many functions carry it", () => {
    expect(
      Result.getOrThrow(
        claims(leaf({ observe: generating("observe.ts") })),
      ).map(({ key, generate }) => [key, generate.file]),
    ).toEqual([["observe", "observe.ts"]]);
  });

  it("refuses a file two sections claim", () => {
    expect(
      claims(
        leaf({
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
    expect(claims(leaf({ observe: generating(file) }))).toMatchObject({
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
      expect(claims(leaf({ observe: generating(file) }))).toMatchObject({
        _tag: "Failure",
        failure: {
          sectionKey: "observe",
          reason: `claims ${JSON.stringify(file)}; name a .ts file directly inside confect/_generated.`,
        },
      });
    },
  );
});
