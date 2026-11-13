import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { expect, test } from "bun:test";
import * as String from "effect/String";
import { pipe } from "effect/Function";
import * as Array from "effect/Array";

const forbidden = [
  Array.join(["eng", "lever"], ""),
  Array.join(["ed", "cell"], ""),
  Array.join(["npm", "pkg", "github", "com"], "."),
  Array.join(["ga", "gan"], ""),
];
const hasOldIdentity = (text: string) => {
  const normalized = pipe(
    text,
    String.toLowerCase,
    String.replace(
      new RegExp(Array.join(["\\b", "gaganref", "\\b"], ""), "g"),
      "",
    ),
  );
  return Array.some(forbidden, (token) =>
    pipe(normalized, String.includes(token)),
  );
};

test("rejects the previous identity and accepts only the exact fork login", () => {
  for (const token of forbidden) {
    expect(
      hasOldIdentity(`before ${pipe(token, String.toUpperCase)} after`),
    ).toBe(true);
  }
  expect(hasOldIdentity("@gaganref/confect-core 10.3.1-fork.1")).toBe(false);
  expect(hasOldIdentity("https://github.com/gaganref/confect")).toBe(false);
  expect(hasOldIdentity(Array.join(["gaganref", "extra"], ""))).toBe(true);
});

test("tracked text files use the fork identity", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = new URL("..", import.meta.url).pathname;
      const files = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
      expect(files.exitCode).toBe(0);
      const paths = Array.filter(
        pipe(files.stdout.toString(), String.split("\0")),
        Boolean,
      );
      expect(paths).toContain("FORK.md");
      expect(paths).toContain("package.json");
      const violations: string[] = [];
      for (const path of paths) {
        const bytes = yield* fs.readFile(`${root}/${path}`);
        if (bytes.includes(0)) continue;
        for (const [index, line] of pipe(
          new TextDecoder().decode(bytes),
          String.split("\n"),
        ).entries()) {
          if (hasOldIdentity(line)) violations.push(`${path}:${index + 1}`);
        }
      }
      expect(violations).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  ));
