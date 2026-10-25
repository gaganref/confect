import { stripVTControlCharacters } from "node:util";
import { expect, it } from "@effect/vitest";
import {
  isCodegenError,
  renderCodegenError,
  UnownedConvexEntrypointError,
} from "@confect/cli/CodegenError";
import { SnapshotError } from "@confect/cli/SnapshotError";

it("recognizes and renders structured snapshot failures without dumping their cause", () => {
  const error = new SnapshotError({
    reason: "NoncanonicalPath",
    relativePath: "notes.spec.ts",
    pathSegments: ["other"],
    cause: { detail: "unrendered-cause" },
  });
  expect(isCodegenError(error)).toBe(true);
  const rendered = renderCodegenError(error);
  expect(rendered).toContain(
    "Invalid generation metadata (NoncanonicalPath) for notes.spec.ts at other.",
  );
  expect(rendered).not.toContain("unrendered-cause");
});

it("renders malformed snapshot input without inventing a source location", () => {
  const error = new SnapshotError({
    reason: "InvalidShape",
    relativePath: "",
    pathSegments: [],
  });
  const rendered = renderCodegenError(error);
  expect(rendered).toContain("Invalid generation metadata (InvalidShape).");
  expect(rendered).not.toContain(" for ");
  expect(rendered).not.toContain(" at ");
});

it("renders every refused path with recovery instructions", () => {
  const rendered = renderCodegenError(
    new UnownedConvexEntrypointError({
      filePaths: ["convex/one.ts", "convex/two.ts"],
    }),
  );
  const plain = stripVTControlCharacters(rendered);
  expect(plain).toContain("convex/one.ts");
  expect(plain).toContain("convex/two.ts");
  expect(rendered).toContain("were not written by confect codegen.");
  expect(rendered).toContain("put authored code outside convex/.");
  expect(rendered).toContain("delete it and run codegen again.");
});
