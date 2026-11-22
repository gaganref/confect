import { expect, test } from "bun:test";
import * as Array from "effect/Array";
import * as String from "effect/String";
import { pipe } from "effect/Function";

const root = new URL("..", import.meta.url).pathname;
const contract = "/confect/_generated/component.ts";

const tracked = Array.filter(
  pipe(
    Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root }).stdout.toString(),
    String.split("\0"),
  ),
  Boolean,
);

/**
 * The tracked files under a Confect component's `_generated/` folders that
 * Confect does not write. A component is any folder with a tracked contract.
 */
const convexOutput = (files: ReadonlyArray<string>) => {
  const components = Array.map(
    Array.filter(files, String.endsWith(contract)),
    String.slice(0, -contract.length),
  );
  return Array.filter(files, (file) =>
    Array.some(
      components,
      (component) =>
        pipe(file, String.startsWith(`${component}/`)) &&
        pipe(file, String.includes("/_generated/")) &&
        !pipe(file, String.startsWith(`${component}/confect/`)),
    ),
  );
};

const components = [
  "packages/cli/test/fixtures/authored-component",
  "tools/local-backend/fixtures/components/counter",
  "tools/local-backend/fixtures/components/inner",
  "tools/local-backend/fixtures/components/middle",
  "tools/local-backend/fixtures/components/parent",
  "tools/local-backend/fixtures/guard/components/guarded",
];

test("tracks no Convex output in a Confect component, so checks run as on a fresh clone", () => {
  expect(
    Array.map(
      Array.filter(tracked, String.endsWith(contract)),
      String.slice(0, -contract.length),
    ),
  ).toEqual(components);
  expect(convexOutput(tracked)).toEqual([]);
});

test.each(components)("finds Convex output tracked in %s", (component) => {
  const planted = `${component}/convex/_generated/api.ts`;
  expect(convexOutput([...tracked, planted])).toEqual([planted]);
});
