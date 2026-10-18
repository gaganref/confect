import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as FileLock from "./FileLock";
import { userCache } from "./UserCache";

export class PushLockError extends Schema.TaggedError<PushLockError>()(
  "PushLockError",
  {
    deploymentName: Schema.String,
    reason: Schema.Literals(["configuration", "timeout", "filesystem"]),
  },
) {
  override get message() {
    switch (this.reason) {
      case "configuration":
        return `Push lock for ${this.deploymentName} needs a home directory to keep its lock file in`;
      case "timeout":
        return `Timed out waiting for another push to ${this.deploymentName} to release its push lock`;
      case "filesystem":
        return `Push lock for ${this.deploymentName} could not read or write its lock file`;
    }
  }
}

/**
 * Serialises pushes per deployment. Overlapping `convex deploy` runs against
 * one deployment race on `wait_for_schema`, so every push holds the lock for
 * its whole duration, whichever stack, checkout, or process it comes from.
 */
export class PushLock extends Context.Service<
  PushLock,
  {
    readonly withLock: <A, E, R>(
      deploymentName: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | PushLockError, R>;
  }
>()("@confect/alchemy/internal/PushLock") {}

/**
 * One lock file per deployment under the user's cache,
 * `confect/alchemy/locks/<deployment>.lock`, so every checkout on the machine
 * shares it. A lock left by a process that exited is taken over; a holder that
 * never releases ends in a typed timeout.
 */
export const layer = (options?: { readonly timeout?: Duration.Input }) =>
  Layer.effect(
    PushLock,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const timeout = options?.timeout ?? Duration.minutes(10);
      const lock = Effect.fn("PushLock.lock")(
        function* (deploymentName: string, scope: Scope.Scope) {
          const failed = (reason: PushLockError["reason"]) =>
            new PushLockError({ deploymentName, reason });
          const cache = yield* userCache.pipe(
            Effect.mapError(() => failed("configuration")),
          );
          if (Option.isNone(cache)) return yield* failed("configuration");
          yield* FileLock.acquire(
            path.join(
              cache.value,
              "confect",
              "alchemy",
              "locks",
              `${deploymentName}.lock`,
            ),
            timeout,
          ).pipe(
            Scope.provide(scope),
            Effect.mapError((error) =>
              failed(error.reason === "timeout" ? "timeout" : "filesystem"),
            ),
          );
        },
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(Crypto.Crypto, crypto),
      );
      return PushLock.of({
        withLock: (deploymentName, effect) =>
          Effect.acquireUseRelease(
            Scope.make(),
            (scope) => lock(deploymentName, scope).pipe(Effect.andThen(effect)),
            (scope, exit) => Scope.close(scope, exit),
          ),
      });
    }),
  );
