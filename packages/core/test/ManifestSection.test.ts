import { App, Env, FunctionSpec, type ManifestSection } from "@confect/core";
import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import * as String from "effect/String";
import { pipe } from "effect/Function";
import * as Array from "effect/Array";
import * as Record from "effect/Record";

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
        names: Record.values(functions),
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
            return Array.map(input.mounts, ({ name }) => name);
          },
        },
      },
    };
    App.make({ env, manifestSections: [{ key: "doors", section }] });
  });

  it("hands render and verify's check the same four deployment kinds", () => {
    expectTypeOf<ManifestSection.GenerateInput["deployment"]>().toEqualTypeOf<
      "local" | "cloud" | "self-hosted" | "unknown"
    >();
    expectTypeOf<ManifestSection.VerifyInput["deployment"]>().toEqualTypeOf<
      ManifestSection.GenerateInput["deployment"]
    >();
  });

  it("hands render the declared section keys as a readonly list", () => {
    expectTypeOf<ManifestSection.GenerateInput["sections"]>().toEqualTypeOf<
      ReadonlyArray<string>
    >();
    const section: ManifestSection.Any = {
      owner: "test/authz",
      format: 1,
      describe: () => null,
      generate: {
        file: "authz.ts",
        match: () => false,
        render: (input) => {
          // @ts-expect-error—render cannot replace the keys
          input.sections = [];
          // @ts-expect-error—render cannot change the list of keys
          input.sections.push("tenancyRecord");
          return {
            contents: input.sections.includes("tenancyRecord")
              ? 'import { tenancy } from "./tenancyRecord.js";\n'
              : "",
            errors: [],
          };
        },
      },
    };
    App.make({ env, manifestSections: [{ key: "authz", section }] });
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
