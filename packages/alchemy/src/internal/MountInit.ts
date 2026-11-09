import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { ConvexClient, ConvexFunctionError } from "../ConvexClient.js";

export class MountInitFailed extends Schema.TaggedError<MountInitFailed>()(
  "MountInitFailed",
  { mount: Schema.String, detail: Schema.String },
) {
  override get message() {
    return `${this.mount}: init failed; earlier mounts are applied, and the next push retries`;
  }
}

const Steps = Schema.Array(
  Schema.Union([
    Schema.Struct({
      componentPath: Schema.String,
      nested: Schema.Boolean,
      init: Schema.NullOr(
        Schema.Struct({ functionName: Schema.String, args: Schema.Unknown }),
      ),
    }),
    Schema.Struct({ componentPath: Schema.String, failure: Schema.String }),
  ]),
);

const STEPS = "confectDeploy:steps";

const ConvexJson = Schema.fromJsonString(
  Schema.Struct({ functions: Schema.optional(Schema.String) }),
);

/**
 * Whether codegen wrote `confectDeploy.ts` into the backend's Convex directory,
 * which `convex.json` may move.
 */
const hasDeployModule = Effect.fn("MountInit.hasDeployModule")(function* (
  cwd: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = path.join(cwd, "convex.json");
  const functions = (yield* fs.exists(config))
    ? ((yield* fs
        .readFileString(config)
        .pipe(Effect.flatMap(Schema.decodeEffect(ConvexJson)))).functions ??
      "convex")
    : "convex";
  return yield* fs.exists(path.join(cwd, functions, "confectDeploy.ts"));
});

/**
 * Run every mount's `init` against a pushed deployment: ask the backend's
 * deploy module for its steps, then run each mount's `init` at its component
 * path, one at a time, and visit a nested component's own steps after its
 * `init`. The first failing mount stops the run. Each `init` is its own
 * transaction, so earlier mounts stay applied and a rerun converges.
 */
export const run = Effect.fn("MountInit.run")(function* (
  url: string,
  key: Redacted.Redacted<string>,
  cwd: string,
) {
  const failed =
    (mount: string) =>
    (error: { readonly _tag: string }): MountInitFailed =>
      new MountInitFailed({
        mount,
        detail: Schema.is(ConvexFunctionError)(error)
          ? error.errorMessage
          : error._tag,
      });
  if (!(yield* hasDeployModule(cwd).pipe(Effect.mapError(failed(STEPS)))))
    return;
  const client = yield* ConvexClient;
  const visit = (
    prefix: string | undefined,
  ): Effect.Effect<void, MountInitFailed> =>
    Effect.gen(function* () {
      const steps = yield* client
        .runFunction(url, key, STEPS, {}, prefix)
        .pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Steps)),
          Effect.mapError(failed(prefix ?? STEPS)),
        );
      for (const step of steps) {
        const mount =
          prefix === undefined
            ? step.componentPath
            : `${prefix}/${step.componentPath}`;
        if ("failure" in step)
          return yield* new MountInitFailed({ mount, detail: step.failure });
        if (step.init !== null)
          yield* client
            .runFunction(
              url,
              key,
              step.init.functionName,
              step.init.args,
              mount,
            )
            .pipe(Effect.mapError(failed(mount)));
        if (step.nested) yield* visit(mount);
      }
    });
  yield* visit(undefined);
});
