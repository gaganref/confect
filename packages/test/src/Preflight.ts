import * as PushCheck from "@confect/server/PushCheck";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Order from "effect/Order";
import * as Rec from "effect/Record";

/**
 * Run the push checks of one backend's modules now: every check a registered
 * function or HTTP router of `modules` carries, each once, apart from the memo
 * Convex's push analysis runs them through. Fails with the first check's
 * {@link PushCheck.PushRefused}, in module path order, then export order.
 *
 * Convex runs a backend's push checks while it analyzes a push, from each
 * function's `exportArgs` and the router's `getRoutes`. A test backend never
 * pushes. It calls a function's `exportArgs` when a call resolves it, so a
 * refused source fails its first function call, but it serves an HTTP request
 * without one, so a test whose first call is HTTP would run a source a push
 * refuses. Run this once each time a test kit builds a backend, before its
 * first call, to refuse the same way on every path.
 *
 * `modules` is the record a backend is built from, such as
 * `import.meta.glob("../convex/**\/*.ts")`, and this imports every module in
 * it. A module the test runtime already evaluated is not evaluated again. Run
 * it once per target: the app's modules, and each local component's.
 *
 * @stability unstable
 */
export const run = (
  modules: Readonly<Record<string, () => Promise<unknown>>>,
): Effect.Effect<void, PushCheck.PushRefused> =>
  Effect.gen(function* () {
    const checks = new Set<Pick<PushCheck.PushCheck, "name" | "check">>();
    for (const path of Arr.sort(Rec.keys(modules), Order.String)) {
      const loaded = yield* Effect.promise(modules[path]!);
      if (typeof loaded !== "object" || loaded === null) continue;
      for (const value of Rec.values(loaded as Record<string, unknown>))
        for (const check of PushCheck.checksOf(value)) checks.add(check);
    }
    for (const check of checks)
      yield* Effect.fromResult(PushCheck.verify(check));
  });
