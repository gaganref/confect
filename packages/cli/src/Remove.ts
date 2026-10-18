import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";
import { RemoveBusyError } from "./CodegenError";

const MAX_ATTEMPTS = 4;

export const remove = Effect.fn("Remove.remove")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(path, { recursive: true, force: true }).pipe(
    Effect.retry({
      while: (error) => error.reason._tag === "Busy",
      times: MAX_ATTEMPTS - 1,
      schedule: Schedule.exponential("25 millis"),
    }),
    Effect.mapError((error) =>
      error.reason._tag === "Busy"
        ? new RemoveBusyError({ path, attempts: MAX_ATTEMPTS, cause: error })
        : error,
    ),
  );
});
