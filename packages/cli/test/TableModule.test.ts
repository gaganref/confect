import * as NodePath from "@effect/platform-node/NodePath";
import { expect, it } from "@effect/vitest";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ConfectDirectory } from "@confect/cli/ConfectDirectory";
import { discoverTableFiles } from "@confect/cli/TableModule";

const listedAs = (listing: ReadonlyArray<string>) =>
  Layer.mergeAll(
    NodePath.layerPosix,
    Layer.succeed(
      ConfectDirectory,
      ConfectDirectory.of({ get: Effect.succeed("/project/confect") }),
    ),
    FileSystem.layerNoop({
      exists: () => Effect.succeed(true),
      readDirectory: () => Effect.succeed([...listing]),
    }),
  );

// Node's recursive `readdir` order differs across Node versions. `B` before `a`
// tells a code-unit comparison from a locale-aware one.
const sorted = ["B.ts", "a.ts", "b.ts", "nested/c.ts"];
// Also lists a test file and a non-TypeScript file, which discovery leaves out.
const unsorted = [
  "nested/c.ts",
  "a.test.ts",
  "b.ts",
  "notes.md",
  "B.ts",
  "a.ts",
];

it.effect.each([
  { order: "sorted", listing: sorted },
  { order: "reversed", listing: Array.reverse(sorted) },
  { order: "shuffled", listing: unsorted },
] as const)(
  "discovers table files in code-unit order from a $order listing",
  ({ listing }) =>
    Effect.gen(function* () {
      const services = yield* Layer.build(listedAs(listing));
      return yield* discoverTableFiles.pipe(Effect.provideContext(services));
    }).pipe(
      Effect.map((files) =>
        expect(files).toEqual(Array.map(sorted, (file) => `tables/${file}`)),
      ),
    ),
);
