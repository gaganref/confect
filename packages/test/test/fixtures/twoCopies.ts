// Two copies of `@confect/test` loaded in one plain Node process, as an install
// with a hoisted copy and a nested one loads them. Each argument is a copy's
// package directory. `copies.ts` makes the copies and runs this file; it prints
// one JSON line of what each copy's functions saw.
import * as Ref from "@confect/core/Ref";
import * as DatabaseSchema from "@confect/server/DatabaseSchema";
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
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Each copy is imported by its file path, which no Effect service is needed to build.
import * as Path from "node:path";
import { pathToFileURL } from "node:url";
// Types only: each copy's modules are imported from the copy's own files below,
// so this package's own source never loads as a third copy.
import type * as ConvexTestModule from "../../src/internal/ConvexTest";
import type * as EgressModule from "../../src/internal/Egress";
import type * as TestConfectModule from "../../src/TestConfect";
import { inlineSources } from "./inlineSources";

type Surface = {
  readonly setImmediate: string;
  readonly queueMicrotask: string;
};

const surface = (): Surface => ({
  setImmediate: typeof setImmediate,
  queueMicrotask: typeof queueMicrotask,
});

const UnknownJson = Schema.fromJsonString(Schema.Unknown);

const startedAt = 1_767_225_600_000;

const schema = defineSchema({ notes: defineTable({ label: v.string() }) });

// The session reads no table through Confect, so its Confect schema is empty.
const confectSchema = DatabaseSchema.make({});

const probe = {
  surface: makeFunctionReference<"action", {}, Surface>("probe:surface"),
  atLoad: makeFunctionReference<"query", {}, Surface>("probe:atLoad"),
  timer: makeFunctionReference<"query", {}, string>("probe:timer"),
  write: makeFunctionReference<"mutation", { label: string }, null>(
    "probe:write",
  ),
  read: makeFunctionReference<
    "query",
    {},
    { labels: ReadonlyArray<string>; now: number }
  >("probe:read"),
  charge: makeFunctionReference<"action", {}, string>("probe:charge"),
  who: makeFunctionReference<"query", {}, string | null>("probe:who"),
  callPeer: makeFunctionReference<"action", {}, Nested>("probe:callPeer"),
  whoAtLoad: makeFunctionReference<"query", {}, string | null>(
    "probe:whoAtLoad",
  ),
};

/**
 * What a node action saw: the globals the isolate lacks, and its environment.
 */
interface Seen extends Surface {
  readonly who: string | null;
}

// oxlint-disable-next-line effecttsgo/process-env -- The probes read the environment the kernel scopes to each function.
const seen = (): Seen => ({ ...surface(), who: process.env["WHO"] ?? null });

/**
 * What a chain from A's action through B's action to a fresh A saw: the fresh
 * backend's modules at load, then B's action and A's action each after the call
 * into the next returned.
 */
interface Chain {
  readonly fresh: { readonly atLoad: Surface; readonly who: string | null };
  readonly middle: Seen;
  readonly outer: Seen;
}

const chain = {
  outer: makeFunctionReference<"action", {}, Chain>("chain:outer"),
  middle: makeFunctionReference<"action", {}, Omit<Chain, "outer">>(
    "chain:middle",
  ),
};

type Settled<A> = { readonly value: A } | { readonly error: string };

const leak = {
  outer: makeFunctionReference<"action", {}, Settled<string>>("leak:outer"),
  middle: makeFunctionReference<"mutation", {}, Settled<string>>("leak:middle"),
  inserted: makeFunctionReference<"query", {}, Settled<string>>(
    "leak:inserted",
  ),
};

/**
 * The context of the mutation whose call opens a fresh backend, while it waits
 * on that call: the fresh backend's module load writes through it, as a module
 * that kept a context it was handed would.
 */
const captured: { ctx?: GenericMutationCtx<any> | undefined } = {};

const keptRefs = {
  keep: makeFunctionReference<"action", {}, Kept | null>("kept:keep"),
  atLoad: makeFunctionReference<"query", {}, Kept | null>("kept:atLoad"),
};

/**
 * The context of the action whose call opens a fresh backend on the other copy,
 * while it waits on that call: the fresh backend's module load calls functions
 * through it (#224).
 */
const keptAction: { ctx?: GenericActionCtx<any> | undefined } = {};

/**
 * What the calls a module load made through a kept action context settled with:
 * a query, a mutation and an action of that context's backend.
 */
interface Kept {
  readonly runQuery: Settled<unknown>;
  readonly runMutation: Settled<unknown>;
  readonly runAction: Settled<unknown>;
}

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

/**
 * What an outer copy's action saw when it called into the inner copy's backend:
 * each inner function's answer, then the outer action's own time and
 * environment once the inner calls returned.
 */
interface Nested {
  readonly surface: Settled<Surface>;
  readonly atLoad: Settled<Surface>;
  readonly timer: Settled<string>;
  readonly read: Settled<{
    readonly labels: ReadonlyArray<string>;
    readonly now: number;
  }>;
  readonly who: Settled<string | null>;
  readonly charge: Settled<string>;
  readonly outerNow: number;
  readonly outerWho: string | null;
}

type Kernel = ConvexTestModule.KernelControls & {
  readonly setEnvironment: (
    componentPath: string,
    env: Readonly<Record<string, string>>,
  ) => void;
};

/**
 * Each copy's kernel clock reads its own time, so a probe tells whose
 * invocation answered.
 */
const timeOf = (label: string) =>
  label === "one" ? startedAt : startedAt + 1_000_000;

interface Copy {
  readonly convexTest: typeof ConvexTestModule.convexTest;
  readonly port: typeof EgressModule.port;
  readonly TestConfect: typeof TestConfectModule;
}

const load = (directory: string): Promise<Copy> => {
  const from = (file: string) =>
    import(pathToFileURL(Path.join(directory, "src", file)).href);
  return Promise.all([
    from("internal/ConvexTest.ts") as Promise<typeof ConvexTestModule>,
    from("internal/Egress.ts") as Promise<typeof EgressModule>,
    from("TestConfect.ts") as Promise<typeof TestConfectModule>,
  ]).then(([kernel, egress, testConfect]) => ({
    convexTest: kernel.convexTest,
    port: egress.port,
    TestConfect: testConfect,
  }));
};

// The modules a copy's backend runs: an isolate action that reads the globals
// the isolate lacks, the same globals as the module loads, a query that starts
// a timer, a write and a read through the syscalls, a read of the component's
// environment, a port call, and an action that calls into `peer`'s backend.
// Its node actions in `chain.ts` call into `peer`'s backend, or open `fresh`.
const modulesOf = (copy: Copy, peer?: () => Kernel, fresh?: () => Kernel) => {
  const charges = copy.port<{}, string>("charges", () =>
    Promise.reject(new Error("the live provider ran")),
  );
  return {
    "_generated/server.ts": () => Promise.resolve({}),
    "probe.ts": () => {
      const atLoad = surface();
      // oxlint-disable-next-line effecttsgo/process-env -- The module reads the environment the kernel scopes to its load.
      const whoAtLoad = process.env["WHO"] ?? null;
      return Promise.resolve({
        whoAtLoad: queryGeneric({
          args: {},
          handler: () => Promise.resolve(whoAtLoad),
        }),
        atLoad: queryGeneric({
          args: {},
          handler: () => Promise.resolve(atLoad),
        }),
        timer: queryGeneric({
          args: {},
          handler: () => {
            // oxlint-disable-next-line effecttsgo/global-timers -- The query starts the timer the I/O bans refuse.
            setTimeout(() => {}, 0);
            return Promise.resolve("returned");
          },
        }),
        surface: actionGeneric({
          args: {},
          handler: () => Promise.resolve(surface()),
        }),
        write: mutationGeneric({
          args: { label: v.string() },
          handler: (ctx, { label }) =>
            ctx.db.insert("notes", { label }).then(() => null),
        }),
        read: queryGeneric({
          args: {},
          handler: (ctx) =>
            ctx.db
              .query("notes")
              .collect()
              .then((rows) => ({
                labels: Arr.map(rows, (row) => row.label),
                // oxlint-disable-next-line effecttsgo/global-date -- The case reads the time a query is pinned to.
                now: Date.now(),
              })),
        }),
        charge: actionGeneric({
          args: {},
          handler: () => charges.call({}),
        }),
        who: queryGeneric({
          args: {},
          // oxlint-disable-next-line effecttsgo/process-env -- The case reads the environment the kernel scopes to the component.
          handler: () => Promise.resolve(process.env["WHO"] ?? null),
        }),
        callPeer: actionGeneric({
          args: {},
          handler: (): Promise<Nested> => {
            const inner = peer!();
            return settled(inner.action(probe.surface, {})).then(
              (innerSurface) =>
                settled(inner.query(probe.atLoad, {})).then((innerAtLoad) =>
                  settled(inner.query(probe.timer, {})).then((timer) =>
                    settled(
                      inner
                        .mutation(probe.write, { label: "nested" })
                        .then(() => inner.query(probe.read, {})),
                    ).then((read) =>
                      settled(inner.query(probe.who, {})).then((who) =>
                        settled(inner.action(probe.charge, {})).then(
                          (charge) => ({
                            surface: innerSurface,
                            atLoad: innerAtLoad,
                            timer,
                            read,
                            who,
                            charge,
                            // oxlint-disable-next-line effecttsgo/global-date -- The case reads the outer action's own time once the inner calls returned.
                            outerNow: Date.now(),
                            // oxlint-disable-next-line effecttsgo/process-env -- The case reads the outer action's own environment once the inner calls returned.
                            outerWho: process.env["WHO"] ?? null,
                          }),
                        ),
                      ),
                    ),
                  ),
                ),
            );
          },
        }),
      });
    },
    // `middle` keeps its context while it opens `fresh`, whose load of this
    // module inserts through it: Convex runs no syscall while a module loads,
    // so the insert must be refused, and `middle`'s database stay empty.
    "leak.ts": () => {
      const kept = captured.ctx;
      const attempt: Promise<Settled<string>> =
        kept === undefined
          ? Promise.resolve({ value: "no context" })
          : settled(kept.db.insert("notes", { label: "leak" }).then(String));
      return attempt.then((inserted) => ({
        inserted: queryGeneric({
          args: {},
          handler: () => Promise.resolve(inserted),
        }),
        middle: mutationGeneric({
          args: {},
          handler: (ctx) => {
            captured.ctx = ctx;
            return fresh!()
              .query(leak.inserted, {})
              .finally(() => {
                captured.ctx = undefined;
              });
          },
        }),
        outer: actionGeneric({
          args: {},
          handler: () => peer!().mutation(leak.middle, {}),
        }),
      }));
    },
    // `keep` keeps its context while it opens `fresh`, whose load of this
    // module calls a query, a mutation and an action through it: Convex runs
    // no function while a module loads, so each must be refused, and `keep`'s
    // database stay empty.
    "kept.ts": () => {
      const keptCtx = keptAction.ctx;
      const attempts: Promise<Kept | null> =
        keptCtx === undefined
          ? Promise.resolve(null)
          : settled(keptCtx.runQuery(probe.read, {})).then((runQuery) =>
              settled(keptCtx.runMutation(probe.write, { label: "kept" })).then(
                (runMutation) =>
                  settled(keptCtx.runAction(probe.surface, {})).then(
                    (runAction) => ({ runQuery, runMutation, runAction }),
                  ),
              ),
            );
      return attempts.then((calls) => ({
        atLoad: queryGeneric({
          args: {},
          handler: () => Promise.resolve(calls),
        }),
        keep: actionGeneric({
          args: {},
          handler: (ctx) => {
            keptAction.ctx = ctx;
            return fresh!()
              .query(keptRefs.atLoad, {})
              .finally(() => {
                keptAction.ctx = undefined;
              });
          },
        }),
      }));
    },
    "chain.ts": () =>
      Promise.resolve({
        // B's node action: it opens a fresh backend, whose first call loads
        // its modules inside this action.
        middle: actionGeneric({
          args: {},
          handler: () => {
            const opened = fresh!();
            return opened.query(probe.atLoad, {}).then((atLoad: Surface) =>
              opened.query(probe.whoAtLoad, {}).then((who: string | null) => ({
                fresh: { atLoad, who },
                middle: seen(),
              })),
            );
          },
        }),
        // A's node action, which calls B's.
        outer: actionGeneric({
          args: {},
          handler: () =>
            peer!()
              .action(chain.middle, {})
              .then((inner: Omit<Chain, "outer">): Chain => ({
                ...inner,
                outer: seen(),
              })),
        }),
      }),
  };
};

/**
 * What `call` settled with: its value, or the message it rejected with.
 */
const settle = <A>(call: () => Promise<A>): Effect.Effect<Settled<A>> =>
  Effect.promise(() => settled(call()));

/**
 * A fresh backend on `copy`, on the clock and with the environment `label`
 * names, whose `callPeer` and `chain:outer` actions call into `peer`'s backend
 * and whose `chain:middle` action opens `fresh`.
 */
const kernelOf = (
  copy: Copy,
  label: string,
  peer?: () => Kernel,
  fresh?: () => Kernel,
): Kernel => {
  const modules = modulesOf(copy, peer, fresh);
  const t = copy.convexTest({
    schema,
    modules,
    sources: inlineSources(modules, ["chain.ts"]),
    runtime: {
      now: () => timeOf(label),
      commitTs: (version: number) =>
        BigInt(timeOf(label)) * 1_000_000n + BigInt(version),
    },
  }) as Kernel;
  t.setEnvironment("", { WHO: label });
  return t;
};

/**
 * Run `action` on `t` while answering the port calls `holder` holds with
 * `${label} answered`: what it settled with, and how many calls `holder` and
 * `other` each held. A call `other` holds, the wrong copy, is answered too, so
 * the action still settles. The calls are held once an action reaches its port,
 * unless it settles first, as it does when no copy holds them.
 */
const answering = <A>(
  t: Kernel,
  action: () => Promise<A>,
  holder: Kernel,
  label: string,
  other?: Kernel,
) =>
  Effect.gen(function* () {
    let done: Settled<A> | undefined;
    const fiber = yield* settle(action).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          done = result;
        }),
      ),
      Effect.forkChild,
    );
    const [held, heldByOther] = yield* Effect.sync(
      () => [holder.commands(), other?.commands() ?? []] as const,
    ).pipe(
      Effect.repeat({
        until: ([mine, wrong]) =>
          mine.length > 0 || wrong.length > 0 || done !== undefined,
        schedule: Schedule.spaced("5 millis"),
      }),
    );
    for (const command of held) holder.answer(command.id, `${label} answered`);
    for (const command of heldByOther) {
      other?.answer(command.id, "answered by the wrong copy");
    }
    const result = yield* Fiber.join(fiber);
    return { result, held: held.length, heldByOther: heldByOther.length };
  });

/**
 * Everything one copy's backend does: its isolate action's surface, the same
 * globals read as its module loaded, a query's timer, a write it reads back
 * with the time its query is pinned to, its environment, and a port call held
 * as a command the test answers.
 */
const kernelRun = (copy: Copy, label: string) =>
  Effect.gen(function* () {
    const t = kernelOf(copy, label);
    const surfaceSeen = yield* settle(() => t.action(probe.surface, {}));
    const atLoad = yield* settle(() => t.query(probe.atLoad, {}));
    const timer = yield* settle(() => t.query(probe.timer, {}));
    const read = yield* settle(() =>
      t.mutation(probe.write, { label }).then(() => t.query(probe.read, {})),
    );
    const who = yield* settle(() => t.query(probe.who, {}));
    const charged = yield* answering(
      t,
      () => t.action(probe.charge, {}),
      t,
      label,
    );
    return {
      surface: surfaceSeen,
      atLoad,
      timer,
      read,
      who,
      held: charged.held,
      charge: charged.result,
    };
  });

/**
 * `outer`'s action calling into a fresh backend on `inner`, whose first call it
 * makes, so the inner backend's modules load inside the outer action too. The
 * inner backend must hold the port call its action makes, and the outer none.
 */
const nestedRun = (
  outer: Copy,
  outerLabel: string,
  inner: Copy,
  innerLabel: string,
) =>
  Effect.gen(function* () {
    const innerT = kernelOf(inner, innerLabel);
    const outerT = kernelOf(outer, outerLabel, () => innerT);
    const called = yield* answering(
      outerT,
      () => outerT.action(probe.callPeer, {}),
      innerT,
      innerLabel,
      outerT,
    );
    return {
      result: called.result,
      heldByInner: called.held,
      heldByOuter: called.heldByOther,
    };
  });

/**
 * `outer`'s node action calling `middle`'s node action, which opens a fresh
 * backend on `outer`, labelled `fresh`, whose modules load during that call
 * (#213). The fresh backend's load must read its own environment and the
 * isolate's globals, not either action's.
 */
const chainRun = (
  outer: Copy,
  outerLabel: string,
  middle: Copy,
  middleLabel: string,
) =>
  Effect.gen(function* () {
    const middleT = kernelOf(middle, middleLabel, undefined, () =>
      kernelOf(outer, "fresh"),
    );
    const outerT = kernelOf(outer, outerLabel, () => middleT);
    return yield* settle(() => outerT.action(chain.outer, {}));
  });

/**
 * `outer`'s action calling `middle`'s mutation, which opens a fresh backend on
 * `outer` whose module load inserts through the mutation's context (#213): what
 * the insert settled with, and the rows `middle`'s database holds after.
 */
const leakRun = (
  outer: Copy,
  outerLabel: string,
  middle: Copy,
  middleLabel: string,
) =>
  Effect.gen(function* () {
    const middleT = kernelOf(middle, middleLabel, undefined, () =>
      kernelOf(outer, "fresh"),
    );
    const outerT = kernelOf(outer, outerLabel, () => middleT);
    const inserted = yield* settle(() => outerT.action(leak.outer, {}));
    const middleRows = yield* settle(() => middleT.query(probe.read, {}));
    return { inserted, middleRows };
  });

/**
 * `keeper`'s action keeping its context while it opens a fresh backend on
 * `loader`, whose module load calls through that context (#224): what the calls
 * settled with, and the rows `keeper`'s database holds after.
 */
const keptRun = (keeper: Copy, keeperLabel: string, loader: Copy) =>
  Effect.gen(function* () {
    const keeperT = kernelOf(keeper, keeperLabel, undefined, () =>
      kernelOf(loader, "fresh"),
    );
    const calls = yield* settle(() => keeperT.action(keptRefs.keep, {}));
    const keeperRows = yield* settle(() => keeperT.query(probe.read, {}));
    return { calls, keeperRows };
  });

/**
 * A `TestConfect` session on `copy`, open until the caller closes it, and its
 * isolate action's surface.
 */
const session = (copy: Copy) =>
  Effect.gen(function* () {
    const modules = modulesOf(copy);
    const layer = copy.TestConfect.layer(confectSchema, schema, modules, {
      target: "kernel",
      sources: inlineSources(modules),
    });
    const surfaceRef = Ref.fromFunctionReference(probe.surface, "action");
    const scope = yield* Scope.make();
    const services = yield* Layer.buildWithScope(layer, scope);
    const read = Effect.gen(function* () {
      const test = yield* copy.TestConfect.TestConfect<typeof confectSchema>();
      return yield* test.action(surfaceRef);
    }).pipe(Effect.provideContext(services), Effect.orDie);
    return { read, close: Scope.close(scope, Exit.void) };
  });

/**
 * Sessions on both copies, each read while both are open, then each read after
 * the other's session closed: first the copy that installed the guards, then
 * the second copy, with a fresh session on the first.
 */
const sessions = (one: Copy, two: Copy) =>
  Effect.gen(function* () {
    const first = yield* session(one);
    const second = yield* session(two);
    const bothOpen = { one: yield* first.read, two: yield* second.read };
    yield* first.close;
    const afterOneClosed = yield* second.read;
    const again = yield* session(one);
    yield* second.close;
    const afterTwoClosed = yield* again.read;
    yield* again.close;
    return { bothOpen, afterOneClosed, afterTwoClosed };
  });

// The copy that registers first, then the other.
const [firstCopy, secondCopy] = process.argv.slice(2);

const report = Effect.gen(function* () {
  const [one, two] = yield* Effect.promise(() =>
    Promise.all([load(firstCopy!), load(secondCopy!)]),
  );
  const [kernelOne, kernelTwo] = yield* Effect.all(
    [kernelRun(one, "one"), kernelRun(two, "two")],
    { concurrency: "unbounded" },
  );
  const opened = yield* sessions(one, two);
  const twoInOne = yield* nestedRun(one, "one", two, "two");
  const oneInTwo = yield* nestedRun(two, "two", one, "one");
  const oneTwoOne = yield* chainRun(one, "one", two, "two");
  const twoOneTwo = yield* chainRun(two, "two", one, "one");
  const leakOneTwoOne = yield* leakRun(one, "one", two, "two");
  const leakTwoOneTwo = yield* leakRun(two, "two", one, "one");
  const keptOneTwo = yield* keptRun(one, "one", two);
  const keptTwoOne = yield* keptRun(two, "two", one);
  const output = yield* Schema.encodeEffect(UnknownJson)({
    kernel: { one: kernelOne, two: kernelTwo },
    nested: { twoInOne, oneInTwo },
    chain: { oneTwoOne, twoOneTwo },
    leak: { oneTwoOne: leakOneTwoOne, twoOneTwo: leakTwoOneTwo },
    kept: { oneTwo: keptOneTwo, twoOne: keptTwoOne },
    sessions: opened,
    host: surface(),
  });
  process.stdout.write(`${output}\n`);
});

void Effect.runPromise(report);
