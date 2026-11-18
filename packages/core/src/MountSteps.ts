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
 * The step a push runs for a backend another backend mounts: its own `init`, if
 * it has one, then its own steps, when it has a deploy module.
 */
export interface Root {
  readonly init: {
    readonly functionName: string;
    readonly args: unknown;
  } | null;
  readonly nested: boolean;
}

const app: Root = { init: null, nested: true };

/**
 * Run every mount's `init` in the order a push runs them: the app's steps in
 * declaration order, each mount's `init` and then its nested component's own
 * steps. The first failing mount stops the run. `root` is the backend's own
 * step, which a component's test session runs at the empty component path as
 * its parent's push would. It defaults to an app's: no `init`, then its steps.
 */
export const run = <E, R>(
  runner: Runner<E, R>,
  root: Root = app,
): Effect.Effect<void, E, R> => {
  const step = (
    mount: string | undefined,
    { init, nested }: Root,
  ): Effect.Effect<void, E, R> =>
    Effect.gen(function* () {
      if (init !== null)
        yield* runner.init(mount ?? "", init.functionName, init.args);
      if (nested) yield* visit(mount);
    });
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
      for (const each of steps) {
        const mount =
          prefix === undefined
            ? each.componentPath
            : `${prefix}/${each.componentPath}`;
        if ("failure" in each)
          return yield* Effect.fail(runner.failed(mount, each.failure));
        yield* step(mount, each);
      }
    });
  return step(undefined, root);
};
