// A copy of this package's current source and a copy of an older published
// build (`olderBuild` in `copies.ts`) loaded in one plain Node process, as an
// install that holds two versions loads them (#213). Arguments: the newer
// copy's package directory, the older one's, and which registers first.
// `copies.ts` makes the copies and runs this file; it prints one JSON line of
// what each copy's functions and loads saw.
import {
  actionGeneric,
  defineSchema,
  defineTable,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
  type GenericActionCtx,
  type GenericMutationCtx,
} from "convex/server";
import { v } from "convex/values";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Each copy is imported by its file path, which no Effect service is needed to build.
import * as Path from "node:path";
import { pathToFileURL } from "node:url";
// Types only: each copy's kernel is imported from the copy's own files below,
// so this package's own source never loads as a third copy.
import type * as ConvexTestModule from "../../src/internal/ConvexTest";
import { inlineSources } from "./inlineSources";

type Settled<A> = { readonly value: A } | { readonly error: string };

/**
 * What a promise settled with: its value, or the message it rejected with.
 */
const settled = <A>(promise: Promise<A>): Promise<Settled<A>> =>
  promise.then(
    (value): Settled<A> => ({ value }),
    (error: unknown): Settled<A> => ({
      error: error instanceof Error ? error.message : String(error),
    }),
  );

const settle = <A>(call: () => Promise<A>): Effect.Effect<Settled<A>> =>
  Effect.promise(() => settled(call()));

const UnknownJson = Schema.fromJsonString(Schema.Unknown);

type Kernel = ConvexTestModule.KernelControls & {
  readonly setEnvironment: (
    componentPath: string,
    env: Readonly<Record<string, string>>,
  ) => void;
};

type ConvexTest = typeof ConvexTestModule.convexTest;

// oxlint-disable-next-line effecttsgo/process-env -- The probes read the environment the kernel scopes to each load and function.
const who = (): string | null => process.env["WHO"] ?? null;

interface Env {
  readonly freshAtLoad: string | null;
  readonly freshQuery: string | null;
  readonly freshMutation: string | null;
  readonly outer: string | null;
}

const refs = {
  whoAtLoad: makeFunctionReference<"query", {}, string | null>(
    "probe:whoAtLoad",
  ),
  who: makeFunctionReference<"query", {}, string | null>("probe:who"),
  write: makeFunctionReference<"mutation", {}, string | null>("probe:write"),
  rows: makeFunctionReference<"query", {}, ReadonlyArray<string>>("probe:rows"),
  callFresh: makeFunctionReference<"action", {}, Env>("probe:callFresh"),
  middle: makeFunctionReference<"mutation", {}, Settled<string>>(
    "probe:middle",
  ),
  inserted: makeFunctionReference<"query", {}, Settled<string>>(
    "probe:inserted",
  ),
  keep: makeFunctionReference<"action", {}, Kept | null>("kept:keep"),
  keptAtLoad: makeFunctionReference<"query", {}, Kept | null>("kept:atLoad"),
  noop: makeFunctionReference<"action", {}, null>("kept:noop"),
};

/**
 * What the calls a module load made through a kept action context settled with:
 * a query, a mutation and an action of that context's backend.
 */
interface Kept {
  readonly runQuery: Settled<unknown>;
  readonly runMutation: Settled<unknown>;
  readonly runAction: Settled<unknown>;
}

const schema = defineSchema({ notes: defineTable({ label: v.string() }) });

/**
 * The context of the mutation whose call opens a fresh backend, while it waits
 * on that call: the fresh backend's module load writes through it.
 */
const captured: { ctx?: GenericMutationCtx<any> | undefined } = {};

/**
 * The context of the action whose call opens a fresh backend on the other copy,
 * while it waits on that call: the fresh backend's module load calls functions
 * through it (#224).
 */
const keptAction: { ctx?: GenericActionCtx<any> | undefined } = {};

// A module that reads `WHO` at load, in a query and in a mutation, and
// inserts through a kept mutation context while it loads. `callFresh` opens a
// fresh backend and reads all three there; `middle` keeps its context while
// it opens one.
const modulesOf = (fresh?: () => Kernel) => ({
  "_generated/server.ts": () => Promise.resolve({}),
  "probe.ts": () => {
    const whoAtLoad = who();
    const kept = captured.ctx;
    const attempt: Promise<Settled<string>> =
      kept === undefined
        ? Promise.resolve({ value: "no context" })
        : settled(kept.db.insert("notes", { label: "leak" }).then(String));
    return attempt.then((inserted) => ({
      whoAtLoad: queryGeneric({
        args: {},
        handler: () => Promise.resolve(whoAtLoad),
      }),
      inserted: queryGeneric({
        args: {},
        handler: () => Promise.resolve(inserted),
      }),
      who: queryGeneric({ args: {}, handler: () => Promise.resolve(who()) }),
      write: mutationGeneric({
        args: {},
        handler: ({ db }) =>
          db.insert("notes", { label: "write" }).then(() => who()),
      }),
      rows: queryGeneric({
        args: {},
        handler: ({ db }) =>
          db
            .query("notes")
            .collect()
            .then(Arr.map((row) => row.label)),
      }),
      callFresh: actionGeneric({
        args: {},
        handler: (): Promise<Env> => {
          const opened = fresh!();
          return opened.query(refs.whoAtLoad, {}).then((freshAtLoad) =>
            opened.query(refs.who, {}).then((freshQuery) =>
              opened.mutation(refs.write, {}).then((freshMutation) => ({
                freshAtLoad,
                freshQuery,
                freshMutation,
                outer: who(),
              })),
            ),
          );
        },
      }),
      middle: mutationGeneric({
        args: {},
        handler: (ctx) => {
          captured.ctx = ctx;
          return fresh!()
            .query(refs.inserted, {})
            .finally(() => {
              captured.ctx = undefined;
            });
        },
      }),
    }));
  },
  // `keep` keeps its context while it opens a fresh backend, whose load of this
  // module calls a query, a mutation and an action through it: each must be
  // refused, and `keep`'s database stay empty (#224).
  "kept.ts": () => {
    const keptCtx = keptAction.ctx;
    const attempts: Promise<Kept | null> =
      keptCtx === undefined
        ? Promise.resolve(null)
        : settled(keptCtx.runQuery(refs.who, {})).then((runQuery) =>
            settled(keptCtx.runMutation(refs.write, {})).then((runMutation) =>
              settled(keptCtx.runAction(refs.noop, {})).then((runAction) => ({
                runQuery,
                runMutation,
                runAction,
              })),
            ),
          );
    return attempts.then((calls) => ({
      atLoad: queryGeneric({
        args: {},
        handler: () => Promise.resolve(calls),
      }),
      noop: actionGeneric({ args: {}, handler: () => Promise.resolve(null) }),
      keep: actionGeneric({
        args: {},
        handler: (ctx) => {
          keptAction.ctx = ctx;
          return fresh!()
            .query(refs.keptAtLoad, {})
            .finally(() => {
              keptAction.ctx = undefined;
            });
        },
      }),
    }));
  },
});

/**
 * A fresh backend on `convexTest`, with `WHO` bound when `label` names one,
 * whose functions open `fresh`.
 */
const kernelOf = (
  convexTest: ConvexTest,
  label: string | undefined,
  fresh?: () => Kernel,
): Kernel => {
  const modules = modulesOf(fresh);
  const t = convexTest({
    schema,
    modules,
    sources: inlineSources(modules),
  }) as Kernel;
  if (label !== undefined) t.setEnvironment("", { WHO: label });
  return t;
};

/**
 * `outer`'s action, with `WHO` bound, opening a fresh backend on `inner` that
 * binds none: what the fresh load, query and mutation read, which must be the
 * host's, and what the outer action reads after.
 */
const envRun = (outer: ConvexTest, inner: ConvexTest) =>
  settle(() =>
    kernelOf(outer, "outer-env", () => kernelOf(inner, undefined)).action(
      refs.callFresh,
      {},
    ),
  );

/**
 * `middle`'s mutation opening a fresh backend on `inner`, whose load inserts
 * through the mutation's context: the insert must be refused, and the
 * mutation's database stay empty.
 */
const leakRun = (middle: ConvexTest, inner: ConvexTest) =>
  Effect.gen(function* () {
    const t = kernelOf(middle, undefined, () => kernelOf(inner, undefined));
    const inserted = yield* settle(() => t.mutation(refs.middle, {}));
    const rows = yield* settle(() => t.query(refs.rows, {}));
    return { inserted, rows };
  });

/**
 * `keeper`'s action keeping its context while it opens a fresh backend on
 * `loader`, whose load calls through it: each call must be refused, and the
 * action's database stay empty.
 */
const keptRun = (keeper: ConvexTest, loader: ConvexTest) =>
  Effect.gen(function* () {
    const t = kernelOf(keeper, undefined, () => kernelOf(loader, undefined));
    const calls = yield* settle(() => t.action(refs.keep, {}));
    const rows = yield* settle(() => t.query(refs.rows, {}));
    return { calls, rows };
  });

const load = (directory: string): Promise<ConvexTest> =>
  (
    import(
      pathToFileURL(Path.join(directory, "src", "internal", "ConvexTest.ts"))
        .href
    ) as Promise<typeof ConvexTestModule>
  ).then((module) => module.convexTest);

const [newerDirectory, olderDirectory, order] = process.argv.slice(2);

const report = Effect.gen(function* () {
  // The copy that registers first loads first and opens the first backend,
  // which installs the process-wide hooks.
  const newerFirst = order === "hoistedFirst";
  const [first, second] = yield* Effect.promise(() =>
    load(newerFirst ? newerDirectory! : olderDirectory!).then((one) =>
      load(newerFirst ? olderDirectory! : newerDirectory!).then(
        (two) => [one, two] as const,
      ),
    ),
  );
  kernelOf(first, undefined);
  kernelOf(second, undefined);
  const [newer, older] = newerFirst ? [first, second] : [second, first];
  const output = yield* Schema.encodeEffect(UnknownJson)({
    host: who(),
    env: {
      newerOuter: yield* envRun(newer, older),
      olderOuter: yield* envRun(older, newer),
    },
    leak: {
      newerMutation: yield* leakRun(newer, older),
      olderMutation: yield* leakRun(older, newer),
    },
    kept: { newerAction: yield* keptRun(newer, older) },
  });
  process.stdout.write(`${output}\n`);
});

void Effect.runPromise(report);
