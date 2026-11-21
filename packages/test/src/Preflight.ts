import type * as PushCheck from "@confect/server/PushCheck";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Order from "effect/Order";
import * as Rec from "effect/Record";
import * as PushPreflight from "./internal/PushPreflight.js";

export {
  NoPushEntry,
  PushCheckUnattributed,
} from "./internal/PushPreflight.js";

/**
 * Run the push checks of one backend's modules now, each once, apart from the
 * memo Convex's push analysis runs them through: every check registered for the
 * database schema of a function or HTTP router `modules` export. Fails with the
 * first check's {@link PushCheck.PushRefused}, in registration order.
 *
 * Convex runs a backend's push checks while it analyzes a push, from each
 * function's `exportArgs` and the router's `getRoutes`. A test backend never
 * pushes. `TestConfect.layer`, and the `layer` of a generated `TestBackend` or
 * `TestComponent` subject, run this for every target they build before they
 * serve a call, so call this only for a backend built some other way, such as
 * `convexTest` directly, before its first call.
 *
 * Given `schema`, the backend's `_generated/schema` default export, it also
 * fails with {@link PushPreflight.NoPushEntry} when checks are registered for
 * it but no function or router of `modules` runs them, as on a backend with
 * neither.
 *
 * `modules` is the record a backend is built from, such as
 * `import.meta.glob("../convex/**\/*.ts")`, and this imports every module in
 * it. A module the test runtime already evaluated is not evaluated again. Run
 * it once per backend: the app's modules, and each local component's.
 *
 * @stability unstable
 */
export const run = (
  modules: Readonly<Record<string, () => Promise<unknown>>>,
  options: { readonly schema?: object } = {},
): Effect.Effect<void, PushCheck.PushRefused | PushPreflight.NoPushEntry> =>
  Effect.gen(function* () {
    const loaded: Array<unknown> = [];
    for (const path of Arr.sort(Rec.keys(modules), Order.String)) {
      const module = yield* Effect.promise(modules[path]!);
      loaded.push(module);
    }
    // One target loaded outside any backend, so no registration is
    // unattributable.
    yield* Effect.fromResult(
      PushPreflight.verify([{ modules: loaded, schema: options.schema }]),
    ).pipe(Effect.catchTag("PushCheckUnattributed", Effect.die));
  });
