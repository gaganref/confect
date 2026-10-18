import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { ComponentNodeGroupError, logCodegenError } from "./CodegenError";
import { ConfectDirectory } from "./ConfectDirectory";
import { CONVEX_CONFIG_FILENAME } from "./ConvexConfig";
import { ConvexDirectory } from "./ConvexDirectory";
import { logFileRemoved, logWarn } from "./log";
import { remove } from "./Remove";

const isNodeGroupRejection = Schema.is(ComponentNodeGroupError);

/**
 * Keep a component's previous generated output when generation rejects a Node
 * group. Specs can import bootstrap output, so generation writes it before
 * their runtimes are known. `duringRestore` pauses whatever watches the output
 * while it is replaced.
 */
export const preserveComponentOutput = <A, E, R>(
  generation: Effect.Effect<A, E, R>,
  duringRestore: Effect.Effect<void, never, Scope.Scope> = Effect.void,
) =>
  Effect.gen(function* () {
    if ((yield* ConvexDirectory.target).kind === "app")
      return yield* generation;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const backupDirectory = yield* fs.makeTempDirectoryScoped();
    const configPath = path.join(
      yield* ConvexDirectory.get,
      CONVEX_CONFIG_FILENAME,
    );
    const snapshots = yield* Effect.forEach(
      [path.join(yield* ConfectDirectory.get, "_generated"), configPath],
      Effect.fnUntraced(function* (original, index) {
        const backup = path.join(backupDirectory, String(index));
        const existed = yield* fs.exists(original);
        if (existed) yield* fs.copy(original, backup);
        return { original, backup, existed };
      }),
    );
    const restore = (rejection: ComponentNodeGroupError) =>
      Effect.gen(function* () {
        yield* duringRestore;
        yield* Effect.forEach(snapshots, ({ original, backup, existed }) =>
          Effect.gen(function* () {
            if (
              existed &&
              original === configPath &&
              (yield* fs.exists(original)) &&
              (yield* fs.readFileString(original)) ===
                (yield* fs.readFileString(backup))
            ) {
              return;
            }
            if (yield* fs.exists(original)) {
              yield* remove(original);
            }
            if (existed) yield* fs.copy(backup, original);
            else yield* logFileRemoved(original);
          }),
        );
        yield* logWarn(
          "Restored generated output after rejecting the Node group.",
        );
      }).pipe(
        Effect.scoped,
        Effect.tapError(() => logCodegenError(rejection)),
      );
    return yield* generation.pipe(
      Effect.tapError((error) =>
        isNodeGroupRejection(error) ? restore(error) : Effect.void,
      ),
    );
  }).pipe(Effect.scoped);
