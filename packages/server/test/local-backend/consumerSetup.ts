import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import { setupForFixture } from "../setup";

const prepare = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner;
  const root = path.resolve(import.meta.dirname, "../../../..");
  const destination = path.join(import.meta.dirname, ".consumer");
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make(
      "bun",
      [
        path.join(root, "scripts/forkConsumer.ts"),
        destination,
        "10.3.1-fork.0",
      ],
      { stdout: "inherit", stderr: "inherit" },
    ),
  );
  if (exitCode !== 0)
    return yield* Effect.die(new Error("Consumer fixture preparation failed"));
  yield* fs.writeFileString(
    path.join(destination, "package.json"),
    yield* fs.readFileString(
      path.join(import.meta.dirname, "fixtures/package.json"),
    ),
  );
  if (!(yield* fs.exists(path.join(destination, "node_modules")))) {
    yield* fs.symlink(
      path.join(import.meta.dirname, "fixtures/node_modules"),
      path.join(destination, "node_modules"),
    );
  }
});

export const setup = () =>
  Effect.runPromise(
    prepare.pipe(
      Effect.andThen(() =>
        Effect.promise(
          setupForFixture(import.meta.dirname, ".consumer", [
            "components/counter/convex",
          ]),
        ),
      ),
      Effect.provide(NodeServices.layer),
    ),
  );
