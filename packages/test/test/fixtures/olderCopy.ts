// A copy of `@confect/test` from before #159 that loaded first, simulated in a
// fresh Node process: each process-wide hook it would hold, set up as it left
// it, then a backend of this copy opened over it. `Kernel.test.ts` runs this
// file; it prints one JSON line of what each open did.
import * as DatabaseSchema from "@confect/server/DatabaseSchema";
import {
  defineSchema,
  makeFunctionReference,
  queryGeneric,
} from "convex/server";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import { AsyncLocalStorage } from "node:async_hooks";
import { convexTest } from "../../src/internal/ConvexTest";
import * as TestConfect from "../../src/TestConfect";
import { inlineSources } from "./inlineSources";

const UnknownJson = Schema.fromJsonString(Schema.Unknown);

const modules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "probe.ts": () =>
    Promise.resolve({
      ping: queryGeneric({ args: {}, handler: () => Promise.resolve("pong") }),
    }),
};

const ping = makeFunctionReference<"query", {}, string>("probe:ping");

type Global = Record<PropertyKey, unknown>;

const global = globalThis as unknown as Global;

/**
 * The keys this copy's process-wide hooks live under, and the one its
 * dispatcher registers behind `globalThis.Convex`.
 */
const keys = {
  ioGuards: Symbol.for("@confect/test/IoBans"),
  Date: Symbol.for("@confect/test/Clock"),
  providerPorts: Symbol.for("@confect/test/Egress"),
  processEnv: Symbol.for("@confect/test/Environment"),
  registry: Symbol.for("@confect/test/ConvexGlobal"),
};

/**
 * Each hook as a copy from before #159 left it, and how to take it away.
 */
const olderHooks = {
  Convex: () => {
    Object.defineProperty(globalThis, "Convex", {
      value: {
        [Symbol.for("@confect/test/Kernel")]: true,
        syscall: () => "null",
        asyncSyscall: () => Promise.resolve("null"),
        jsSyscall: () => null,
      },
      writable: true,
      configurable: true,
      enumerable: true,
    });
    return () => {
      delete global["Convex"];
    };
  },
  ioGuards: () => {
    global[keys.ioGuards] = {
      hooks: {
        running: () => undefined,
        loading: () => undefined,
        end: () => undefined,
        ended: () => false,
      },
      made: new WeakSet(),
      guarding: new WeakMap(),
      probing: false,
      nextTimerId: 1,
    };
    return () => {
      delete global[keys.ioGuards];
    };
  },
  Date: () => {
    global[keys.Date] = {
      bases: new WeakMap(),
      pinned: () => undefined,
      inside: () => false,
    };
    return () => {
      delete global[keys.Date];
    };
  },
  providerPorts: () => {
    global[keys.providerPorts] = { hold: () => undefined };
    return () => {
      delete global[keys.providerPorts];
    };
  },
  processEnv: () => {
    global[keys.processEnv] = {
      lookups: new Set([() => undefined]),
      loading: new AsyncLocalStorage(),
      installed: true,
    };
    return () => {
      delete global[keys.processEnv];
    };
  },
};

/**
 * What opening a backend threw: its tag and the hooks it names, or `opened`.
 */
const outcome = (thrown: unknown) =>
  typeof thrown === "object" && thrown !== null && "_tag" in thrown
    ? {
        tag: (thrown as { readonly _tag: unknown })._tag,
        hooks: (thrown as { readonly hooks?: unknown }).hooks,
        message: (thrown as { readonly message?: unknown }).message,
      }
    : { tag: "other", message: String(thrown) };

const openKernel = () => {
  try {
    convexTest({ schema: defineSchema({}), modules });
    return { tag: "opened" };
  } catch (thrown) {
    return outcome(thrown);
  }
};

/**
 * Whether a refused open left this copy registered anywhere.
 */
const registered = () => global[keys.registry] !== undefined;

const report = Effect.gen(function* () {
  const atImport = Arr.some(
    Rec.values(keys),
    (key) => global[key] !== undefined,
  );
  const kernel = Rec.map(olderHooks, (simulate) => {
    const remove = simulate();
    const opened = openKernel();
    const left = registered();
    remove();
    return { ...opened, registered: left };
  });
  // Through the public layer, which turns the refusal into its failure.
  const remove = olderHooks.Convex();
  const exit = yield* TestConfect.layer(
    DatabaseSchema.make({}),
    defineSchema({}),
    modules,
    { target: "kernel", sources: inlineSources(modules) },
  ).pipe(Layer.build, Effect.scoped, Effect.exit);
  remove();
  const layer = Exit.isFailure(exit)
    ? exit.cause.pipe(Cause.squash, outcome)
    : { tag: "opened" };
  // With no older copy, a backend opens and runs.
  const control = yield* Effect.promise(() =>
    convexTest({
      schema: defineSchema({}),
      modules,
      sources: inlineSources(modules),
    }).query(ping, {}),
  );
  const output = yield* Schema.encodeEffect(UnknownJson)({
    atImport,
    kernel,
    layer,
    control,
  });
  process.stdout.write(`${output}\n`);
});

void Effect.runPromise(report);
