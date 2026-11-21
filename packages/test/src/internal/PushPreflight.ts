import * as PushCheck from "@confect/server/PushCheck";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Order from "effect/Order";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { functionModules } from "./Execution.js";

/**
 * Push checks are registered for a backend whose modules hold no registered
 * function and no HTTP router, so no push would run them.
 *
 * @stability unstable
 */
export class NoPushEntry extends Schema.TaggedError<
  NoPushEntry,
  { readonly brand: unique symbol }
>()("NoPushEntry", {
  /**
   * The names of the checks no entry runs.
   */
  checks: Schema.NonEmptyArray(Schema.String),
}) {
  override get message(): string {
    return `Push checks ${Arr.join(
      Arr.map(this.checks, (name) => `"${name}"`),
      ", ",
    )} are registered for this backend, but none of its modules registers a function or an HTTP router, so no push runs them`;
  }
}

/**
 * Whether a test backend runs its targets' push checks when it is built:
 * `"run"`, the default, or `"skip"`.
 */
export type Mode = "run" | "skip";

/**
 * One target's evaluated modules, and the database schema its checks are
 * registered under when the caller knows it.
 */
export interface Loaded {
  readonly modules: Iterable<unknown>;
  readonly schema?: object | undefined;
}

/**
 * Run, apart from the analysis memo, each check registered for a database
 * schema one of `targets`' functions or routers runs the checks of, once each
 * and in registration order, and refuse with the first refusal. A target given
 * its schema first refuses with {@link NoPushEntry} when checks are registered
 * for that schema but none of its modules runs them.
 *
 * @stability unstable
 */
export const verify = (
  targets: ReadonlyArray<Loaded>,
): Result.Result<void, PushCheck.PushRefused | NoPushEntry> => {
  const checks = new Set<Pick<PushCheck.PushCheck, "name" | "check">>();
  for (const { modules, schema } of targets) {
    const found = new Set<object>();
    for (const loaded of modules) {
      if (typeof loaded !== "object" || loaded === null) continue;
      for (const value of Rec.values(loaded as Record<string, unknown>)) {
        const target = PushCheck.targetOf(value);
        if (target !== undefined) found.add(target);
      }
    }
    if (schema !== undefined && !found.has(schema)) {
      const unrun = PushCheck.registered(schema);
      if (Arr.isReadonlyArrayNonEmpty(unrun))
        return Result.fail(
          NoPushEntry.make({ checks: Arr.map(unrun, (check) => check.name) }),
        );
    }
    for (const target of found)
      for (const check of PushCheck.registered(target)) checks.add(check);
  }
  for (const check of checks) {
    const verdict = PushCheck.verify(check);
    if (Result.isFailure(verdict)) return verdict;
  }
  return Result.succeed(undefined);
};

/**
 * Import every module of `modules` in path order, keeping each that loads.
 * `complete` says whether every one loaded.
 */
export const importAll = (
  modules: Readonly<Record<string, () => Promise<unknown>>>,
): Effect.Effect<{
  readonly modules: ReadonlyArray<unknown>;
  readonly complete: boolean;
}> =>
  Effect.gen(function* () {
    const loaded: Array<unknown> = [];
    let complete = true;
    for (const path of Arr.sort(Rec.keys(modules), Order.String)) {
      const module = yield* Effect.promise(() =>
        modules[path]!().then(
          (value) => ({ value }),
          () => undefined,
        ),
      );
      if (module === undefined) complete = false;
      else loaded.push(module.value);
    }
    return { modules: loaded, complete };
  });

/**
 * One target a test backend builds: the app at `""` or a component at its path,
 * the modules it was registered with, and, for the app, its database schema.
 */
export interface Target {
  readonly componentPath: string;
  readonly modules: Readonly<Record<string, () => Promise<unknown>>>;
  readonly schema?: object | undefined;
}

/**
 * Whether `raw`, the backend a session opened, is the test kernel, which loads
 * modules under its own guards and so must load them itself.
 */
const isKernel = (
  raw: unknown,
): raw is {
  readonly preload: (componentPath: string) => Promise<void>;
  readonly loadedModules: (componentPath: string) => ReadonlyArray<unknown>;
} =>
  typeof raw === "object" &&
  raw !== null &&
  typeof (raw as { preload?: unknown }).preload === "function" &&
  typeof (raw as { loadedModules?: unknown }).loadedModules === "function";

/**
 * The evaluated modules of `target` on `raw`: on the kernel, its own guarded
 * load, which its open reuses, and on convex-test, each module a deployment
 * registers as functions imported, which the test runtime does not evaluate
 * again. A target whose kernel load fails runs no check, since its open fails
 * every call the same way. A module that fails to import is left out, and the
 * target's schema goes unchecked for {@link NoPushEntry}, since that module may
 * have held its entry. Either failure still reaches the call that loads the
 * module, as it did before.
 */
const loadedOf = (
  raw: unknown,
  target: Target,
): Effect.Effect<Loaded | undefined> =>
  isKernel(raw)
    ? Effect.map(
        Effect.promise(() =>
          raw.preload(target.componentPath).then(
            () => true,
            () => false,
          ),
        ),
        (loaded) =>
          loaded
            ? {
                modules: raw.loadedModules(target.componentPath),
                schema: target.schema,
              }
            : undefined,
      )
    : Effect.map(
        importAll(functionModules(target.modules)),
        ({ modules, complete }) => ({
          modules,
          schema: complete ? target.schema : undefined,
        }),
      );

/**
 * Run the push checks of each target a test backend builds, before it serves a
 * call: each check registered for a target, once per run and apart from the
 * analysis memo, failing with the first {@link PushCheck.PushRefused}, or with
 * {@link NoPushEntry} for a target whose schema has checks none of its modules
 * runs. With `"skip"` it runs nothing.
 *
 * @stability unstable
 */
export const run = (
  raw: unknown,
  targets: ReadonlyArray<Target>,
  mode: Mode = "run",
): Effect.Effect<void, PushCheck.PushRefused | NoPushEntry> =>
  mode === "skip"
    ? Effect.void
    : Effect.gen(function* () {
        const loaded: Array<Loaded> = [];
        for (const target of targets) {
          const modules = yield* loadedOf(raw, target);
          if (modules !== undefined) loaded.push(modules);
        }
        yield* Effect.fromResult(verify(loaded));
      });
