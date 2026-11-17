import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { rootDir } from "alchemy/Auth/Profile";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { afterAll, vi } from "vitest";

const path = Effect.runSync(Path.Path.pipe(Effect.provide(NodePath.layer)));
const fs = Effect.runSync(
  FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer)),
);
const home = await Effect.runPromise(
  fs.makeTempDirectory({ prefix: "confect-alchemy-home-" }),
);
vi.stubEnv("ALCHEMY_HOME", home);
afterAll(() => {
  vi.unstubAllEnvs();
  return Effect.runPromise(fs.remove(home, { recursive: true }));
});

assert.match(
  path.relative(tmpdir(), rootDir()),
  /^confect-alchemy-home-[^/\\]+$/,
  "Alchemy tests must use a dedicated home under the system temporary directory",
);
