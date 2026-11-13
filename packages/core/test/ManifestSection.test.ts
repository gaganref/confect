import { App, Env, FunctionSpec, type ManifestSection } from "@confect/core";
import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import * as String from "effect/String";
import { pipe } from "effect/Function";

type Names = { readonly format: 2; readonly names: ReadonlyArray<string> };
type Unformatted = Omit<Names, "format">;

const env = Env.make("host", {});

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
    App.make({ env, manifestSections: [{ key: "names", section: names }] });
  });

  it("hands verify's check the matched modules, the mounts and the target", () => {
    const section: ManifestSection.Any = {
      owner: "test/doors",
      format: 1,
      describe: () => null,
      generate: {
        file: "doors.ts",
        match: () => false,
        render: () => ({ contents: "", errors: [] }),
        verify: {
          match: (relativePath) =>
            pipe(relativePath, String.endsWith("door.ts")),
          check: (input) => {
            expectTypeOf(input).toEqualTypeOf<ManifestSection.VerifyInput>();
            return input.mounts.map(({ name }) => name);
          },
        },
      },
    };
    App.make({ env, manifestSections: [{ key: "doors", section }] });
  });

  it("refuses a data type without a format", () => {
    expectTypeOf<
      // @ts-expect-error—a section's data carries its format
      ManifestSection.ManifestSection<string, Unformatted>
    >().toBeObject();
  });

  it("refuses a section declared on a profile instead of App.make", () => {
    const names: ManifestSection.Any = {
      owner: "test/names",
      format: 1,
      describe: () => null,
    };
    expect(() =>
      // @ts-expect-error—a backend declares its sections on App.make
      FunctionSpec.extend()({ middleware: [], manifest: { names } }),
    ).toThrow(/manifest/);
    expectTypeOf<
      "manifestSections" extends keyof FunctionSpec.AnyWithProps ? true : false
    >().toEqualTypeOf<false>();
  });
});
