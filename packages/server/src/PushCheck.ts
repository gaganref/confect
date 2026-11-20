import type { HttpRouter as ConvexHttpRouter } from "convex/server";
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * A check of the deployed source that runs while Convex analyzes a push, so a
 * refused source never replaces the version a deployment serves.
 *
 * Convex calls each registered query, mutation and action's `exportArgs` while
 * it analyzes a push, to read the function's argument validator, and never
 * while it serves a call. It calls the HTTP router's `getRoutes` the same way.
 * Every function Confect registers, raw Convex functions in a group included,
 * and every router `HttpRouter.make` builds, runs the checks {@link register}ed
 * for its backend's database schema from those callbacks, and a refusal fails
 * the push. The deployment then keeps serving the last push that succeeded.
 *
 * Convex marks `exportArgs` `@internal` (`server/registration.ts` in convex
 * 1.49.0). It is not a supported extension point, so a Convex release could
 * stop calling it during analysis. Pin Convex exactly, and repeat the contract
 * test in `packages/server/test/local-backend/pushCheck.test.ts` on each
 * upgrade.
 *
 * @stability unstable
 */
export interface PushCheck {
  readonly [TypeId]: typeof TypeId;
  /**
   * Names the check in a refusal.
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
 * Make a {@link PushCheck}. Making one runs nothing.
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
   * The entry Convex was analyzing, a function's export name or `http`, or none
   * when the check ran outside a push, as in a test preflight.
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

type Checks = ReadonlyArray<Pick<PushCheck, "name" | "check">>;

/**
 * The checks registered for each backend, by the very database schema object
 * its generated `_generated/schema` module exports. One registry per process,
 * which every loaded copy of `@confect/server` and `@confect/test` shares, so a
 * check registered through one copy reaches entries another copy built. The key
 * names its protocol's version: a `WeakMap` from a schema to an array of
 * objects with a string `name` and a `check` returning the refusals as strings,
 * which `register` appends to. A change that cannot keep that meaning takes a
 * new versioned key.
 *
 * It holds registrations, never verdicts. Its keys are the schemas an
 * evaluation of a module graph builds, so each evaluation registers afresh,
 * even in Convex's long-lived Node executor, whose `globalThis` outlives a
 * push.
 */
const registryKey = Symbol.for("@confect/server/PushCheck/registry/v1");

type Registry = WeakMap<object, Array<Pick<PushCheck, "name" | "check">>>;

const registry = (): Registry =>
  ((globalThis as { [registryKey]?: Registry })[registryKey] ??= new WeakMap());

/**
 * Register `check` for the backend whose database schema is `schema`, the
 * default export of its generated `_generated/schema` module, once. Every
 * function and HTTP router of that backend whose module graph reaches the call
 * runs it in Convex's push analysis. Registering evaluates no schema and runs
 * no check.
 *
 * Register at the module scope of code every entry of the backend imports, such
 * as a provider its implementations use, since Convex evaluates each entry's
 * own graph. A backend with neither a registered function nor an HTTP router
 * runs no check at a push; `Preflight.run` from `@confect/test`, given the
 * schema, refuses such a backend.
 *
 * ```ts
 * import * as PushCheck from "@confect/server/PushCheck";
 * import schema from "./_generated/schema";
 *
 * PushCheck.register(
 *   schema,
 *   PushCheck.make("authz", () => door.refusals()),
 * );
 * ```
 *
 * @stability unstable
 */
export const register = (schema: object, check: PushCheck): void => {
  const checks = registry().get(schema);
  if (checks === undefined) registry().set(schema, [check]);
  else if (!checks.includes(check)) checks.push(check);
};

/**
 * The checks registered for the backend whose database schema is `schema`, in
 * registration order.
 *
 * @stability unstable
 */
export const registered = (schema: object): Checks =>
  registry().get(schema) ?? [];

/**
 * Each check's refusals from its first run, by check. A module-scope memo,
 * never one on `globalThis`: Convex's Node executor keeps one process, and its
 * `globalThis`, across pushes. Each evaluation of a module graph makes its own
 * checks, so this runs a check at most once per check value per loaded copy of
 * this module. Two backends that load one graph share its verdict.
 */
const verdicts = new WeakMap<
  Pick<PushCheck, "name" | "check">,
  ReadonlyArray<string>
>();

/**
 * Run each check registered for `schema` at most once per check, then refuse
 * with the first check's refusals, naming `entry`.
 */
const runOnce = (
  schema: object,
  entry: string,
): Result.Result<void, PushRefused> => {
  for (const self of registered(schema)) {
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
 * The key a function or router guarded here carries, under which every loaded
 * copy of `@confect/server` and `@confect/test` reads the database schema whose
 * registered checks it runs, as v1 defined it. A change that cannot keep that
 * meaning takes a new versioned key.
 */
const targetKey = Symbol.for("@confect/server/PushCheck/v1");

/**
 * The key under which a function guarded here keeps the `exportArgs` it had
 * before, so a copy guarded for another backend wraps that one rather than this
 * guard. Every loaded copy of `@confect/server` reads it, as v1 defined it: the
 * unguarded `exportArgs` function. A change that cannot keep that meaning takes
 * a new versioned key.
 */
const unguardedKey = Symbol.for("@confect/server/PushCheck/unguarded/v1");

/**
 * The properties a guard owns, which a copy replaces rather than copies.
 */
const guardOwned: ReadonlyArray<PropertyKey> = [
  "exportArgs",
  targetKey,
  unguardedKey,
];

/**
 * The database schema whose registered checks a function or router runs in push
 * analysis, or `undefined` for one that runs none.
 *
 * @stability unstable
 */
export const targetOf = (u: unknown): object | undefined => {
  if (typeof u !== "function" && (typeof u !== "object" || u === null))
    return undefined;
  const target = (u as { [targetKey]?: unknown })[targetKey];
  return typeof target === "object" && target !== null ? target : undefined;
};

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
 * Give `registered`, a function this library just made, an `exportArgs` that
 * runs the checks registered for `schema` first, then its own.
 *
 * @internal
 */
export const guardMade = <F>(fn: F, schema: object, entry: string): F => {
  if (!isRegistered(fn)) return fn;
  guard(fn, unguardedOf(fn), schema, entry);
  return fn;
};

/**
 * The `exportArgs` `fn` had before any guard: the one a guard kept, else its
 * own.
 */
const unguardedOf = (fn: Registered): (() => string) => {
  const kept = (fn as { [unguardedKey]?: unknown })[unguardedKey];
  return typeof kept === "function"
    ? (kept as () => string)
    : fn.exportArgs.bind(fn);
};

/**
 * Give `target` an `exportArgs` that runs the checks registered for `schema`,
 * then `unguarded`, and the markers other copies read.
 */
const guard = (
  target: object,
  unguarded: () => string,
  schema: object,
  entry: string,
): void => {
  Object.defineProperties(target, {
    exportArgs: {
      value: () => {
        throwRefusal(runOnce(schema, entry));
        return unguarded();
      },
      enumerable: true,
      writable: true,
      configurable: true,
    },
    [targetKey]: { value: schema, configurable: true },
    [unguardedKey]: { value: unguarded, configurable: true },
  });
};

/**
 * A copy of `registered`, a function a product made, whose `exportArgs` runs
 * the checks registered for `schema` first. The copy keeps every own property
 * but those a guard owns, symbols included, and the original's prototype, so
 * Convex and `@confect/test` read it as they read the original, which stays
 * unchanged. The original may be frozen, or guarded for another backend, in
 * which case the copy wraps the `exportArgs` that guard kept, so it runs this
 * backend's checks alone.
 *
 * @internal
 */
export const guardCopy = <F>(fn: F, schema: object, entry: string): F => {
  if (!isRegistered(fn)) return fn;
  const descriptors: Record<PropertyKey, PropertyDescriptor> =
    Object.getOwnPropertyDescriptors(fn);
  for (const key of guardOwned) delete descriptors[key as never];
  const copy = Object.setPrototypeOf(
    Object.defineProperties(
      (...args: ReadonlyArray<never>) => fn(...args),
      descriptors,
    ),
    Object.getPrototypeOf(fn) as object | null,
  ) as Registered;
  guard(copy, unguardedOf(fn), schema, entry);
  return copy as F;
};

/**
 * Give `router`, which `HttpRouter.make` just built, a `getRoutes` that runs
 * the checks registered for `schema` first. Convex 1.49 discards a throw from
 * `getRoutes` and prints a generic routes error, so a refusal instead returns
 * one route whose method is the refusal's message, which Convex refuses and
 * prints. Serving a request reads `lookup`, never `getRoutes`.
 *
 * @internal
 */
export const guardRouter = (
  router: ConvexHttpRouter,
  schema: object,
): ConvexHttpRouter => {
  const getRoutes = router.getRoutes;
  Object.defineProperties(router, {
    getRoutes: {
      value: (): ReturnType<ConvexHttpRouter["getRoutes"]> => {
        const routes = getRoutes();
        const verdict = runOnce(schema, "http");
        if (Result.isSuccess(verdict)) return routes;
        const refused = [
          "/",
          verdict.failure.message,
          routes[0]?.[2],
        ] as unknown as (typeof routes)[number];
        return [refused];
      },
      enumerable: true,
      writable: true,
      configurable: true,
    },
    [targetKey]: { value: schema, configurable: true },
  });
  return router;
};
