import type { HttpRouter as ConvexHttpRouter } from "convex/server";
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * A check of the deployed source that runs while Convex analyzes a push, so a
 * refused source never replaces the version a deployment serves.
 *
 * Convex calls each registered query, mutation and action's `exportArgs` while
 * it analyzes a push, to read the function's argument validator, and never
 * while it serves a call. It calls the HTTP router's `getRoutes` the same way.
 * A throw from either fails the push, and the deployment keeps serving the last
 * push that succeeded. {@link guardFunctions} and {@link guardRouter} run each
 * check before they delegate to those callbacks. Convex prints a refusal from
 * `exportArgs`, naming the check and the function it analyzed, but discards one
 * from `getRoutes`.
 *
 * Convex marks `exportArgs` `@internal` (`server/registration.ts` in convex
 * 1.49.0). It is not a supported extension point, so a Convex release could
 * stop calling it during analysis. Pin Convex exactly, and repeat the contract
 * test in `packages/server/test/local-backend/pushCheck.test.ts` on each
 * upgrade.
 *
 * A manifest section declares one with `generate.pushCheck`: its `_generated`
 * file exports `pushCheck`, made by {@link make}, and codegen passes it to
 * every registered function and HTTP router that imports the file.
 *
 * @stability unstable
 */
export interface PushCheck {
  readonly [TypeId]: typeof TypeId;
  /**
   * Names the check in a refusal, such as the key of the manifest section that
   * declares it.
   */
  readonly name: string;
  /**
   * The check's refusals, each naming the declaration it refuses, or none when
   * the source passes. It reads only the deployed source, so every evaluation
   * of one source reaches the same verdict. Convex's message for a refused push
   * may name no module or function, so a refusal is all an author sees.
   */
  readonly check: () => ReadonlyArray<string>;
}

const TypeId = "~@confect/server/PushCheck";

/**
 * Make a {@link PushCheck}. Make it at module scope, in the `_generated` file
 * of the section that declares it, so each evaluation of a module graph makes
 * its own and runs it at most once.
 *
 * ```ts
 * import * as PushCheck from "@confect/server/PushCheck";
 * import door from "../door";
 *
 * export const pushCheck = PushCheck.make("authz", () => door.refusals());
 * ```
 *
 * @stability unstable
 */
export const make = (
  name: string,
  check: () => ReadonlyArray<string>,
): PushCheck => ({ [TypeId]: TypeId, name, check });

/**
 * @stability unstable
 */
export const isPushCheck = (u: unknown): u is PushCheck =>
  Predicate.hasProperty(u, TypeId) && u[TypeId] === TypeId;

/**
 * A push check refused the source.
 *
 * @stability unstable
 */
export class PushRefused extends Schema.TaggedError<
  PushRefused,
  { readonly brand: unique symbol }
>()("PushRefused", {
  /**
   * The refusing check's name.
   */
  check: Schema.String,
  /**
   * The entry Convex was analyzing, such as `tasks/list:list` or `http`, or
   * none when the check ran outside a push, as in a test preflight.
   */
  entry: Schema.optional(Schema.String),
  refusals: Schema.NonEmptyArray(Schema.String),
}) {
  override get message(): string {
    const where =
      this.entry === undefined ? "" : ` while Convex analyzed ${this.entry}`;
    const refusals =
      this.refusals.length === 1
        ? ` ${this.refusals[0]}`
        : Arr.join(
            Arr.map(this.refusals, (refusal) => `\n- ${refusal}`),
            "",
          );
    return `Push check "${this.check}" refused the source${where}:${refusals}`;
  }
}

/**
 * Run `self` now, apart from any memo: its refusals as a {@link PushRefused}
 * naming `entry`, or nothing when the source passes. A throw from the check
 * propagates.
 *
 * @stability unstable
 */
export const verify = (
  self: Pick<PushCheck, "name" | "check">,
  entry?: string,
): Result.Result<void, PushRefused> => {
  const refusals = self.check();
  return Arr.isReadonlyArrayNonEmpty(refusals)
    ? Result.fail(
        PushRefused.make({
          check: self.name,
          ...(entry === undefined ? {} : { entry }),
          refusals,
        }),
      )
    : Result.succeed(undefined);
};

/**
 * Each check's refusals from its first run, by check. A module-scope memo,
 * never one on `globalThis`: Convex's Node executor keeps one process, and its
 * `globalThis`, across pushes, so a memo there would skip the checks of every
 * push after the first. Each evaluation of a module graph makes its own checks,
 * so this holds each check's verdict for one graph.
 */
const verdicts = new WeakMap<
  Pick<PushCheck, "name" | "check">,
  ReadonlyArray<string>
>();

/**
 * Run each check at most once per check value, then refuse with the first
 * check's refusals, naming `entry`.
 */
const runOnce = (
  checks: ReadonlyArray<Pick<PushCheck, "name" | "check">>,
  entry: string,
): Result.Result<void, PushRefused> => {
  for (const self of checks) {
    let refusals = verdicts.get(self);
    if (refusals === undefined) {
      refusals = self.check();
      verdicts.set(self, refusals);
    }
    if (Arr.isReadonlyArrayNonEmpty(refusals))
      return Result.fail(
        PushRefused.make({ check: self.name, entry, refusals }),
      );
  }
  return Result.succeed(undefined);
};

/**
 * The key a guarded function or router carries its checks under, which every
 * copy of `@confect/server` and `@confect/test` reads. Its value is a
 * `ReadonlyArray` of objects with a string `name` and a `check` returning the
 * refusals as strings, as v1 defined them. A change that cannot keep that
 * meaning takes a new versioned key.
 */
const checksKey = Symbol.for("@confect/server/PushCheck/v1");

type Checks = ReadonlyArray<Pick<PushCheck, "name" | "check">>;

/**
 * The checks a function or router {@link guardFunctions} or {@link guardRouter}
 * returned carries, none for any other value.
 *
 * @stability unstable
 */
export const checksOf = (u: unknown): Checks =>
  (typeof u === "function" || (typeof u === "object" && u !== null)) &&
  Arr.isArray((u as { [checksKey]?: unknown })[checksKey])
    ? ((u as { [checksKey]: Checks })[checksKey] as Checks)
    : [];

const throwRefusal = (result: Result.Result<void, PushRefused>): void => {
  if (Result.isFailure(result)) throw result.failure;
};

interface Registered {
  (...args: ReadonlyArray<never>): unknown;
  readonly exportArgs: () => string;
}

const isRegistered = (u: unknown): u is Registered =>
  typeof u === "function" &&
  typeof (u as { exportArgs?: unknown }).exportArgs === "function";

/**
 * A copy of `registered` whose `exportArgs` runs `checks` first. The copy keeps
 * every own property, symbols included, so Convex and `@confect/test` read it
 * as they read the original.
 */
const guardOne = (
  registered: Registered,
  checks: Checks,
  entry: string,
): Registered => {
  const copy = Object.defineProperties(
    (...args: ReadonlyArray<never>) => registered(...args),
    Object.getOwnPropertyDescriptors(registered),
  ) as Registered;
  return Object.defineProperties(copy, {
    exportArgs: {
      value: () => {
        throwRefusal(runOnce(checks, entry));
        return registered.exportArgs();
      },
      enumerable: true,
      writable: true,
      configurable: true,
    },
    [checksKey]: { value: checks },
  });
};

/**
 * The registered functions of one module with each query, mutation and action's
 * `exportArgs` running `checks` first, at most once per check, then the
 * original. A refusal throws {@link PushRefused}, naming the function as
 * `modulePath:name`. Ordinary calls never call `exportArgs`, so they run no
 * check. The functions are copies, and `functions` is unchanged.
 *
 * Generated registration calls this with the push checks of the sections it
 * imports.
 *
 * @stability unstable
 */
export const guardFunctions = <Functions>(
  functions: Functions,
  checks: ReadonlyArray<PushCheck>,
  modulePath: string,
): Functions => {
  if (checks.length === 0) return functions;
  const guard = (value: unknown, path: ReadonlyArray<string>): unknown =>
    isRegistered(value)
      ? guardOne(value, checks, `${modulePath}:${Arr.join(path, ".")}`)
      : typeof value === "object" && value !== null && !Arr.isArray(value)
        ? Rec.map(value as Readonly<Record<string, unknown>>, (child, key) =>
            guard(child, [...path, key]),
          )
        : value;
  return guard(functions, []) as Functions;
};

/**
 * A copy of `router` whose `getRoutes` runs `checks` first, at most once per
 * check, so a backend whose only entry is its HTTP router refuses the push too.
 * A refusal throws {@link PushRefused}, naming `http`, but Convex 1.49 discards
 * a throw from `getRoutes` and reports only that it returned no routes, so the
 * push fails without the refusal. Codegen therefore guards the router only with
 * checks no registered function runs. Serving a request reads `lookup`, never
 * `getRoutes`, so it runs no check. The copy shares the original's routes, and
 * `router` is unchanged.
 *
 * @stability unstable
 */
export const guardRouter = (
  router: ConvexHttpRouter,
  checks: ReadonlyArray<PushCheck>,
): ConvexHttpRouter => {
  if (checks.length === 0) return router;
  const copy = Object.create(
    Object.getPrototypeOf(router) as object,
    Object.getOwnPropertyDescriptors(router),
  ) as ConvexHttpRouter;
  return Object.defineProperties(copy, {
    getRoutes: {
      value: () => {
        throwRefusal(runOnce(checks, "http"));
        return router.getRoutes();
      },
      enumerable: true,
      writable: true,
      configurable: true,
    },
    [checksKey]: { value: checks },
  });
};
