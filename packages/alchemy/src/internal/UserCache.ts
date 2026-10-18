import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/**
 * The user's cache directory, as the Convex CLI resolves it: `~/.cache` on
 * POSIX and `%LOCALAPPDATA%` on Windows. Shared by every checkout on the
 * machine, so binaries are downloaded once and push locks are seen by every
 * stack. None when no absolute directory can be derived.
 */
export const userCache = Effect.gen(function* () {
  const path = yield* Path.Path;
  const { HOME, LOCALAPPDATA, USERPROFILE } = yield* Config.all({
    HOME: Config.String("HOME").pipe(Config.withDefault("")),
    LOCALAPPDATA: Config.String("LOCALAPPDATA").pipe(Config.withDefault("")),
    USERPROFILE: Config.String("USERPROFILE").pipe(Config.withDefault("")),
  });
  const root =
    process.platform === "win32"
      ? LOCALAPPDATA ||
        (USERPROFILE && path.join(USERPROFILE, "AppData", "Local"))
      : HOME && path.join(HOME, ".cache");
  return root && path.isAbsolute(root) ? Option.some(root) : Option.none();
});
