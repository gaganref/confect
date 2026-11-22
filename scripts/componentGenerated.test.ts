import { expect, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Order from "effect/Order";
import * as Path from "effect/Path";
import * as String from "effect/String";
import { pipe } from "effect/Function";
import { packedFiles } from "./checkPackContents";

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

const ignoredBy = (file: string) =>
  Bun.spawnSync(["git", "check-ignore", "--verbose", "--no-index", file], {
    cwd: root,
  }).stdout.toString();

test.each(components)(
  "ignores Convex output in %s by the .gitignore component codegen writes",
  (component) => {
    expect(tracked).toContain(`${component}/convex/.gitignore`);
    expect(ignoredBy(`${component}/convex/_generated/api.ts`)).toStartWith(
      `${component}/convex/.gitignore:`,
    );
    expect(ignoredBy(`${component}/convex/api.ts`)).toBe("");
  },
);

const runEffect = <A, E>(
  effect: Effect.Effect<A, E, BunServices.BunServices>,
) => Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

test("packs a Confect component without Convex's output and drops nothing else", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      yield* fs.copy(path.join(root, components[0]), directory, {
        overwrite: true,
      });
      yield* fs.writeFileString(
        path.join(directory, "package.json"),
        '{"name":"counter","version":"0.0.0","files":["confect","convex"]}\n',
      );
      yield* fs.makeDirectory(path.join(directory, "convex", "_generated"));
      const convexFiles = Array.map(
        ["api.ts", "component.ts", "dataModel.ts", "server.ts"],
        (file) => `convex/_generated/${file}`,
      );
      for (const file of convexFiles)
        yield* fs.writeFileString(path.join(directory, file), "export {};\n");
      const packed = yield* packedFiles(directory);
      yield* fs.remove(path.join(directory, "convex", ".gitignore"));
      const unignored = yield* packedFiles(directory);
      expect(packed).toContain("convex/schema.ts");
      expect(Array.sort(unignored, Order.String)).toEqual(
        Array.sort([...packed, ...convexFiles], Order.String),
      );
    }).pipe(Effect.scoped),
  ));
