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
};

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
// a timer, a write and a read through the syscalls, and a port call.
const modulesOf = (copy: Copy) => {
  const charges = copy.port<{}, string>("charges", () =>
    Promise.reject(new Error("the live provider ran")),
  );
  return {
    "_generated/server.ts": () => Promise.resolve({}),
    "probe.ts": () => {
      const atLoad = surface();
      return Promise.resolve({
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
      });
    },
  };
};

type Settled<A> = { readonly value: A } | { readonly error: string };

/**
 * What `call` settled with: its value, or the message it rejected with.
 */
const settle = <A>(call: () => Promise<A>): Effect.Effect<Settled<A>> =>
  Effect.promise(() =>
    call().then(
      (value): Settled<A> => ({ value }),
      (error: unknown): Settled<A> => ({
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
  );

/**
 * Everything one copy's backend does: its isolate action's surface, the same
 * globals read as its module loaded, a query's timer, a write it reads back
 * with the time its query is pinned to, and a port call held as a command the
 * test answers.
 */
const kernelRun = (copy: Copy, label: string) =>
  Effect.gen(function* () {
    const modules = modulesOf(copy);
    const t: ConvexTestModule.KernelControls = copy.convexTest({
      schema,
      modules,
      sources: inlineSources(modules),
      runtime: {
        now: () => startedAt,
        commitTs: (version: number) =>
          BigInt(startedAt) * 1_000_000n + BigInt(version),
      },
    });
    const surfaceSeen = yield* settle(() => t.action(probe.surface, {}));
    const atLoad = yield* settle(() => t.query(probe.atLoad, {}));
    const timer = yield* settle(() => t.query(probe.timer, {}));
    const read = yield* settle(() =>
      t.mutation(probe.write, { label }).then(() => t.query(probe.read, {})),
    );
    let charged: Settled<string> | undefined;
    const charging = settle(() => t.action(probe.charge, {})).pipe(
      Effect.tap((settled) =>
        Effect.sync(() => {
          charged = settled;
        }),
      ),
      Effect.forkChild,
    );
    const fiber = yield* charging;
    // The call is held once the action reaches its port, unless it settles
    // first, as it does when no copy holds it.
    const held = yield* Effect.sync(() => t.commands()).pipe(
      Effect.repeat({
        until: (commands) => commands.length > 0 || charged !== undefined,
        schedule: Schedule.spaced("5 millis"),
      }),
    );
    for (const command of held) t.answer(command.id, `${label} answered`);
    const charge = yield* Fiber.join(fiber);
    return {
      surface: surfaceSeen,
      atLoad,
      timer,
      read,
      held: held.length,
      charge,
    };
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

const [hoisted, nested] = process.argv.slice(2);

const report = Effect.gen(function* () {
  const [one, two] = yield* Effect.promise(() =>
    Promise.all([load(hoisted!), load(nested!)]),
  );
  const [kernelOne, kernelTwo] = yield* Effect.all(
    [kernelRun(one, "one"), kernelRun(two, "two")],
    { concurrency: "unbounded" },
  );
  const opened = yield* sessions(one, two);
  const output = yield* Schema.encodeEffect(UnknownJson)({
    kernel: { one: kernelOne, two: kernelTwo },
    sessions: opened,
    host: surface(),
  });
  process.stdout.write(`${output}\n`);
});

void Effect.runPromise(report);
