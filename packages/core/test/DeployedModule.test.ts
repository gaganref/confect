import { DeployedModule } from "@confect/core";
import { describe, expect, it } from "@effect/vitest";

describe("DeployedModule", () => {
  it.each([
    ["notes.ts", true],
    ["nested/notes.js", true],
    ["schema.ts", true],
    ["notes.test.ts", false],
    ["convex.config.ts", false],
    ["_generated/api.ts", false],
    [".hidden.ts", false],
    ["#notes.ts#", false],
    ["with space/notes.ts", false],
    ["notes.json", false],
  ])("admits %s by its name: %s", (file, admitted) => {
    expect(DeployedModule.admitsName(file)).toBe(admitted);
  });

  it("registers a TypeScript file only when a line starts with an import or an export", () => {
    expect(DeployedModule.admits("empty.ts", "const unused = 1;\n")).toBe(
      false,
    );
    expect(DeployedModule.admits("empty.tsx", "const unused = 1;\n")).toBe(
      false,
    );
    expect(DeployedModule.admits("typed.ts", "  export const a = 1;\n")).toBe(
      true,
    );
    expect(
      DeployedModule.admits("late.ts", `const a = 1;\nimport "x";\n`),
    ).toBe(true);
    // The bundler reads no JavaScript file's text.
    expect(DeployedModule.admits("plain.js", "const unused = 1;\n")).toBe(true);
  });

  it("names a schema wherever it sits", () => {
    expect(DeployedModule.isSchema("schema.js")).toBe(true);
    expect(DeployedModule.isSchema("nested/schema.ts")).toBe(true);
    expect(DeployedModule.isSchema("schemas.ts")).toBe(false);
  });
});
