import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * The pid of a process that has already exited.
 */
export const deadPid = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner.spawn(
    ChildProcess.make(process.execPath, ["-e", ""], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }),
  );
  yield* handle.exitCode;
  return Number(handle.pid);
}).pipe(Effect.scoped);
