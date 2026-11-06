import { FunctionSpec, type ManifestSection } from "@confect/core";
import { describe, expectTypeOf, it } from "@effect/vitest";

type Names = { readonly format: 2; readonly names: ReadonlyArray<string> };
type Unformatted = Omit<Names, "format">;

describe("ManifestSection", () => {
  it("hands check the data summarize returns", () => {
    const names: ManifestSection.ManifestSection<string, Names> = {
      owner: "test/names",
      format: 2,
      describe: ({ path }) => path,
      summarize: ({ functions }) => ({
        format: 2,
        names: Object.values(functions),
      }),
      check: (next) => {
        expectTypeOf(next).toEqualTypeOf<Names>();
        return { errors: [], notes: [] };
      },
    };
    FunctionSpec.extend()({ middleware: [], manifest: { names } });
  });

  it("refuses a data type without a format", () => {
    expectTypeOf<
      // @ts-expect-error—a section's data carries its format
      ManifestSection.ManifestSection<string, Unformatted>
    >().toBeObject();
  });
});
