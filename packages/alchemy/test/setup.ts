import * as NodePath from "@effect/platform-node/NodePath";
import { rootDir } from "alchemy/Auth/Profile";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";

const path = Effect.runSync(Path.Path.pipe(Effect.provide(NodePath.layer)));

assert.match(
  path.relative(tmpdir(), rootDir()),
  /^confect-alchemy-home-[^/\\]+$/,
  "Alchemy tests must use a dedicated home under the system temporary directory",
);
