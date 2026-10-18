import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { expect, test } from "bun:test";

const forbidden = [
  ["eng", "lever"].join(""),
  ["ed", "cell"].join(""),
  ["npm", "pkg", "github", "com"].join("."),
  ["ga", "gan"].join(""),
];
const hasOldIdentity = (text: string) => {
  const normalized = text
    .toLowerCase()
    .replace(new RegExp(["\\b", "gaganref", "\\b"].join(""), "g"), "");
  return forbidden.some((token) => normalized.includes(token));
};

test("rejects the previous identity and accepts only the exact fork login", () => {
  for (const token of forbidden) {
    expect(hasOldIdentity(`before ${token.toUpperCase()} after`)).toBe(true);
  }
  expect(hasOldIdentity("@gaganref/confect-core 10.3.1-fork.1")).toBe(false);
  expect(hasOldIdentity("https://github.com/gaganref/confect")).toBe(false);
  expect(hasOldIdentity(["gaganref", "extra"].join(""))).toBe(true);
});

test("tracked text files use the fork identity", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = new URL("..", import.meta.url).pathname;
      const files = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
      expect(files.exitCode).toBe(0);
      const paths = files.stdout.toString().split("\0").filter(Boolean);
      expect(paths).toContain("FORK.md");
      expect(paths).toContain("package.json");
      const violations: string[] = [];
      for (const path of paths) {
        const bytes = yield* fs.readFile(`${root}/${path}`);
        if (bytes.includes(0)) continue;
        for (const [index, line] of new TextDecoder()
          .decode(bytes)
          .split("\n")
          .entries()) {
          if (hasOldIdentity(line)) violations.push(`${path}:${index + 1}`);
        }
      }
      expect(violations).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  ));
