import { expect, test } from "bun:test";
import * as Array from "effect/Array";
import * as String from "effect/String";
import { pipe } from "effect/Function";

const root = new URL("..", import.meta.url).pathname;
const contract = "/confect/_generated/component.ts";

const tracked = (pathspec: string) => {
  const files = Bun.spawnSync(["git", "ls-files", "-z", "--", pathspec], {
    cwd: root,
  });
  expect(files.exitCode).toBe(0);
  return Array.filter(
    pipe(files.stdout.toString(), String.split("\0")),
    Boolean,
  );
};

test("tracks no Convex output in a Confect component, so checks run as on a fresh clone", () => {
  const components = Array.map(tracked(`:(glob)**${contract}`), (file) =>
    pipe(file, String.slice(0, -contract.length)),
  );
  expect(components).toEqual([
    "packages/cli/test/fixtures/authored-component",
    "tools/local-backend/fixtures/components/counter",
    "tools/local-backend/fixtures/components/inner",
    "tools/local-backend/fixtures/components/middle",
    "tools/local-backend/fixtures/components/parent",
    "tools/local-backend/fixtures/guard/components/guarded",
  ]);
  for (const component of components) {
    expect(
      Array.filter(
        tracked(component),
        (file) =>
          pipe(file, String.includes("/_generated/")) &&
          !pipe(file, String.startsWith(`${component}/confect/`)),
      ),
    ).toEqual([]);
  }
});
