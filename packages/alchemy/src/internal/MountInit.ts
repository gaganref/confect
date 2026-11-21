import * as MountSteps from "@confect/core/MountSteps";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { ConvexClient, ConvexFunctionError } from "../ConvexClient.js";
import { functionsDirectory } from "./FunctionsDirectory.js";
import * as Redaction from "./Redaction.js";

export class MountInitFailed extends Schema.TaggedError<
  MountInitFailed,
  { readonly brand: unique symbol }
>()("MountInitFailed", { mount: Schema.String, detail: Schema.String }) {
  override get message() {
    return `${this.mount}: init failed; earlier mounts are applied, and the next push retries`;
  }
}

/**
 * Whether codegen wrote `confectDeploy.ts` into the backend's Convex directory.
 */
const hasDeployModule = Effect.fn("MountInit.hasDeployModule")(function* (
  cwd: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const functions = yield* functionsDirectory(cwd);
  return yield* fs.exists(path.join(cwd, functions, "confectDeploy.ts"));
});

/**
 * Run every mount's `init` against a pushed deployment, in the order
 * `MountSteps.run` walks them, the order the test backend uses too. The first
 * failing mount stops the run. Each `init` is its own transaction, so earlier
 * mounts stay applied and a rerun converges.
 *
 * @internal
 */
export const run = Effect.fn("MountInit.run")(function* (
  url: string,
  key: Redacted.Redacted<string>,
  cwd: string,
) {
  // The mount and the detail come from the deployment and may echo a
  // credential the run handled.
  const credentials = yield* Redaction.credentials;
  yield* credentials.add(key);
  const failure = (mount: string, detail: string) =>
    MountInitFailed.make({
      mount: credentials.redact(mount),
      detail: credentials.redact(detail),
    });
  const failed =
    (mount: string) =>
    (error: { readonly _tag: string }): MountInitFailed =>
      failure(
        mount,
        Schema.is(ConvexFunctionError)(error) ? error.errorMessage : error._tag,
      );
  if (
    !(yield* hasDeployModule(cwd).pipe(
      Effect.mapError(failed(MountSteps.STEPS)),
    ))
  )
    return;
  const client = yield* ConvexClient;
  yield* MountSteps.run({
    steps: (prefix) =>
      client
        .runFunction(url, key, MountSteps.STEPS, {}, prefix)
        .pipe(Effect.mapError(failed(prefix ?? MountSteps.STEPS))),
    init: (mount, functionName, args) =>
      client
        .runFunction(url, key, functionName, args, mount)
        .pipe(Effect.mapError(failed(mount))),
    failed: failure,
  });
});
