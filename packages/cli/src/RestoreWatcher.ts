import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

/**
 * Run a directory watch that a restore can pause: Windows refuses to remove a
 * directory while a recursive watch holds it open.
 */
// Untraced, because restarts run in the captured context and would carry this
// constructor's stack frame into their failures.
export const make = Effect.fnUntraced(function* <E, R>(
  watch: Effect.Effect<void, E, R>,
) {
  const parent = yield* Effect.scope;
  const context = yield* Effect.context<R>();
  const failed = yield* Deferred.make<never, E>();
  const start = Effect.gen(function* () {
    const scope = yield* Scope.fork(parent, "sequential");
    yield* watch.pipe(
      Effect.provide(context),
      Effect.onExit((exit) =>
        Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
          ? Deferred.failCause(failed, exit.cause)
          : Effect.void,
      ),
      Effect.forkIn(scope, { startImmediately: true }),
    );
    return scope;
  });
  let scope = yield* start;
  return {
    failure: Deferred.await(failed),
    duringRestore: Effect.acquireRelease(
      Effect.suspend(() => Scope.close(scope, Exit.void)),
      () =>
        start.pipe(
          Effect.tap((next) =>
            Effect.sync(() => {
              scope = next;
            }),
          ),
        ),
    ),
  };
});
