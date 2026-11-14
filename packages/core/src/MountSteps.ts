import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * The deploy module's mutation, `convex/confectDeploy.ts`'s `steps`, which a
 * push calls at the app and at each nested component.
 */
export const STEPS = "confectDeploy:steps";

/**
 * What a backend's deploy module answers: each mount's `init` call, or the
 * failure that stopped the list, and whether the mount has steps of its own.
 */
export const Steps = Schema.Array(
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

/**
 * How a push reaches a backend: ask a component path's deploy module for its
 * steps (`undefined` is the app), run an `init` at a component path, and turn a
 * mount's failure into the run's error.
 */
export interface Runner<E, R> {
  readonly steps: (prefix: string | undefined) => Effect.Effect<unknown, E, R>;
  readonly init: (
    mount: string,
    functionName: string,
    args: unknown,
  ) => Effect.Effect<unknown, E, R>;
  readonly failed: (mount: string, detail: string) => E;
}

/**
 * Run every mount's `init` in the order a push runs them: the app's steps in
 * declaration order, each mount's `init` and then its nested component's own
 * steps. The first failing mount stops the run.
 */
export const run = <E, R>(runner: Runner<E, R>): Effect.Effect<void, E, R> => {
  const visit = (prefix: string | undefined): Effect.Effect<void, E, R> =>
    Effect.gen(function* () {
      const steps = yield* runner
        .steps(prefix)
        .pipe(
          Effect.flatMap((answer) =>
            Schema.decodeUnknownEffect(Steps)(answer).pipe(
              Effect.mapError((error) =>
                runner.failed(prefix ?? STEPS, error._tag),
              ),
            ),
          ),
        );
      for (const step of steps) {
        const mount =
          prefix === undefined
            ? step.componentPath
            : `${prefix}/${step.componentPath}`;
        if ("failure" in step)
          return yield* Effect.fail(runner.failed(mount, step.failure));
        if (step.init !== null)
          yield* runner.init(mount, step.init.functionName, step.init.args);
        if (step.nested) yield* visit(mount);
      }
    });
  return visit(undefined);
};
