import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import { setupForFixture } from "./setupForFixture";

const prepare = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner;
  const root = path.resolve(import.meta.dirname, "../../..");
  const destination = path.resolve(import.meta.dirname, "../.consumer");
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make(
      "bun",
      [
        path.join(root, "scripts/forkConsumer.ts"),
        destination,
        "10.6.0-fork.0",
      ],
      { stdout: "inherit", stderr: "inherit" },
    ),
  );
  if (exitCode !== 0)
    return yield* Effect.die(new Error("Consumer fixture preparation failed"));
  yield* fs.writeFileString(
    path.join(destination, "package.json"),
    yield* fs.readFileString(
      path.resolve(import.meta.dirname, "../fixtures/package.json"),
    ),
  );
  // Reuse the fixture's installed packages and the consumer's linked kit.
  const installed = path.resolve(
    import.meta.dirname,
    "../fixtures/node_modules",
  );
  const modules = path.join(destination, "node_modules");
  yield* fs.remove(modules, { recursive: true, force: true });
  yield* fs.makeDirectory(modules);
  for (const entry of yield* fs.readDirectory(installed)) {
    yield* fs.symlink(path.join(installed, entry), path.join(modules, entry));
  }
  yield* fs.symlink(
    path.join(destination, "kits/counter-kit"),
    path.join(modules, "counter-kit"),
  );
});

export const setup = () =>
  Effect.runPromise(
    prepare.pipe(
      Effect.andThen(() =>
        Effect.promise(
          setupForFixture(import.meta.dirname, "../.consumer", [
            "components/counter/convex",
          ]),
        ),
      ),
      Effect.provide(NodeServices.layer),
    ),
  );
