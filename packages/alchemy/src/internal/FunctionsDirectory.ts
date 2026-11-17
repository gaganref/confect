import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const ConvexJson = Schema.fromJsonString(
  Schema.Struct({ functions: Schema.optional(Schema.String) }),
);

/**
 * The backend's Convex directory relative to `cwd`, which `convex.json` may
 * move from `convex`.
 *
 * @internal
 */
export const functionsDirectory = Effect.fn("FunctionsDirectory.resolve")(
  function* (cwd: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = path.join(cwd, "convex.json");
    if (!(yield* fs.exists(config))) return "convex";
    const { functions } = yield* fs
      .readFileString(config)
      .pipe(Effect.flatMap(Schema.decodeEffect(ConvexJson)));
    return functions ?? "convex";
  },
);
