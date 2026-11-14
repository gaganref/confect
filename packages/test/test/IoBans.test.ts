import * as FunctionSpec from "@confect/core/FunctionSpec";
import * as DatabaseSchema from "@confect/server/DatabaseSchema";
import * as FunctionRegistryItem from "@confect/server/FunctionRegistryItem";
import * as RegisteredConvexFunction from "@confect/server/RegisteredConvexFunction";
import { RegisteredNodeFunction } from "@confect/server/node";
import * as Util from "node:util";
import * as Vm from "node:vm";
import { assert, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import {
  actionGeneric,
  componentsGeneric,
  defineSchema,
  defineTable,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import * as Schema from "effect/Schema";
import { convexTest } from "../src/internal/ConvexTest";
import type * as KernelRefusal from "../src/internal/KernelRefusal";
import { hasUseNodeDirective } from "../src/internal/Execution";
import { inlineSources } from "./fixtures/inlineSources";
import { keptFetch, keptSetImmediate } from "./fixtures/keptAtImport";
import { loopback } from "./fixtures/loopback";

type Timer = "setTimeout" | "setInterval";

const timerArgs = {
  name: v.union(v.literal("setTimeout"), v.literal("setInterval")),
};

type TimerFn = (callback: () => void, ms: number) => unknown;

const timerOf = (name: Timer) =>
  (globalThis as unknown as Record<Timer, TimerFn>)[name];

const startTimer = (name: Timer) => timerOf(name)(() => {}, 0);

/**
 * Wait on `name` as a handler that awaits its timer does.
 */
const awaitTimer = (name: Timer) =>
  // oxlint-disable-next-line effecttsgo/new-promise -- The case waits on the runtime's own timer callback, which is what the I/O bans refuse or allow.
  new Promise<void>((resolve) => {
    timerOf(name)(resolve, 10);
  });

// What a rejected call tells its handler, so a test compares it whole.
const outcomeOf = (called: Promise<unknown>) =>
  called.then(
    (value) => ({ returned: value }),
    (error: Error) => ({ name: error.name, message: error.message }),
  );

// What each global the isolate lacks reads as, inside the running function.
const surface = () => ({
  setImmediate: typeof setImmediate,
  queueMicrotask: typeof queueMicrotask,
});

type Body = "multipart" | "urlencoded" | "multipartWithoutBoundary";

const bodyArgs = {
  body: v.union(
    v.literal("multipart"),
    v.literal("urlencoded"),
    v.literal("multipartWithoutBoundary"),
  ),
};

const formRequest = (body: Body) =>
  body === "urlencoded"
    ? new Request("https://example.com/", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "name=ada",
      })
    : new Request("https://example.com/", {
        method: "POST",
        headers: {
          "content-type":
            body === "multipart"
              ? "multipart/form-data; boundary=fence"
              : "multipart/form-data",
        },
        body: '--fence\r\nContent-Disposition: form-data; name="name"\r\n\r\nada\r\n--fence--\r\n',
      });

const parseForm = (body: Body) =>
  outcomeOf(
    formRequest(body)
      .formData()
      .then((form) => form.get("name")),
  );

const nodeSurface = RegisteredNodeFunction.make(
  DatabaseSchema.make({}),
  (() => {
    const item = FunctionRegistryItem.make({
      functionSpec: FunctionSpec.publicNodeAction({
        name: "surface",
        returns: () =>
          Schema.Struct({
            setImmediate: Schema.String,
            queueMicrotask: Schema.String,
          }),
      }),
      groupMiddlewareAttachments: [],
      handler: () => Effect.sync(surface),
    });
    assert(item._tag === "Confect");
    return item;
  })(),
);

const isolateSurface = (() => {
  const item = FunctionRegistryItem.make({
    functionSpec: FunctionSpec.publicAction({
      name: "surface",
      returns: () =>
        Schema.Struct({
          setImmediate: Schema.String,
          queueMicrotask: Schema.String,
        }),
    }),
    groupMiddlewareAttachments: [],
    handler: () => Effect.sync(surface),
  });
  assert(item._tag === "Confect");
  return RegisteredConvexFunction.make(DatabaseSchema.make({}), item);
})();

const io = {
  fetchInQuery: makeFunctionReference<"query", { url: string }>(
    "io:fetchInQuery",
  ),
  fetchInMutation: makeFunctionReference<"mutation", { url: string }>(
    "io:fetchInMutation",
  ),
  capturedFetchInQuery: makeFunctionReference<"query", { url: string }>(
    "io:capturedFetchInQuery",
  ),
  importedFetchInQuery: makeFunctionReference<"query", { url: string }>(
    "io:importedFetchInQuery",
  ),
  reassignedFetchInQuery: makeFunctionReference<"query", { url: string }>(
    "io:reassignedFetchInQuery",
  ),
  timerInQuery: makeFunctionReference<"query", { name: Timer }>(
    "io:timerInQuery",
  ),
  timerInMutation: makeFunctionReference<"mutation", { name: Timer }>(
    "io:timerInMutation",
  ),
  awaitedTimerInQuery: makeFunctionReference<"query", { name: Timer }>(
    "io:awaitedTimerInQuery",
  ),
  awaitedTimerInMutation: makeFunctionReference<"mutation", { name: Timer }>(
    "io:awaitedTimerInMutation",
  ),
  surfaceInQuery: makeFunctionReference<"query">("io:surfaceInQuery"),
  surfaceInMutation: makeFunctionReference<"mutation">("io:surfaceInMutation"),
  surfaceInAction: makeFunctionReference<"action">("io:surfaceInAction"),
  confectSurface: makeFunctionReference<"action">("io:confectSurface"),
  nodeSurface: makeFunctionReference<"action">("ioNode:surface"),
  importedImmediateInQuery: makeFunctionReference<"query">(
    "io:importedImmediateInQuery",
  ),
  formDataInQuery: makeFunctionReference<"query", { body: Body }>(
    "io:formDataInQuery",
  ),
  formDataInMutation: makeFunctionReference<"mutation", { body: Body }>(
    "io:formDataInMutation",
  ),
  formDataInAction: makeFunctionReference<"action", { body: Body }>(
    "io:formDataInAction",
  ),
  clearInQuery: makeFunctionReference<"query">("io:clearInQuery"),
  notes: makeFunctionReference<"query", {}, Array<string>>("io:notes"),
  fetchThroughNestedMutation: makeFunctionReference<
    "mutation",
    { url: string }
  >("io:fetchThroughNestedMutation"),
  fetchThroughQuery: makeFunctionReference<"action", { url: string }>(
    "io:fetchThroughQuery",
  ),
  fetchThroughMutation: makeFunctionReference<"action", { url: string }>(
    "io:fetchThroughMutation",
  ),
  timerThroughQuery: makeFunctionReference<"action", { name: Timer }>(
    "io:timerThroughQuery",
  ),
  fetchInAction: makeFunctionReference<"action", { url: string }, string>(
    "io:fetchInAction",
  ),
  timersInAction: makeFunctionReference<"action">("io:timersInAction"),
  fetchThenWrite: makeFunctionReference<"action", { url: string }>(
    "io:fetchThenWrite",
  ),
  addNote: makeFunctionReference<"mutation", { text: string }>("io:addNote"),
  promisifiedTimerInQuery: makeFunctionReference<"query">(
    "io:promisifiedTimerInQuery",
  ),
  fakedStackInQuery: makeFunctionReference<"query">("io:fakedStackInQuery"),
  namedNodeScriptInQuery: makeFunctionReference<"query">(
    "io:namedNodeScriptInQuery",
  ),
  redefinedFetchInQuery: makeFunctionReference<"query", { url: string }>(
    "io:redefinedFetchInQuery",
  ),
  redefinedFetchInMutation: makeFunctionReference<"mutation", { url: string }>(
    "io:redefinedFetchInMutation",
  ),
  redefinedFetchInAction: makeFunctionReference<"action", { url: string }>(
    "io:redefinedFetchInAction",
  ),
  overlaidFetchInQuery: makeFunctionReference<"query", { url: string }>(
    "io:overlaidFetchInQuery",
  ),
  getterFetchInMutation: makeFunctionReference<"mutation", { url: string }>(
    "io:getterFetchInMutation",
  ),
  restoredFetchInMutation: makeFunctionReference<"mutation", { url: string }>(
    "io:restoredFetchInMutation",
  ),
  inheritedFetchInMutation: makeFunctionReference<"mutation", { url: string }>(
    "io:inheritedFetchInMutation",
  ),
};

// The writes an action made after its raw fetch, so a test waits for them.
const lateWrites: Array<Promise<unknown>> = [];

/**
 * What a handler redefines `fetch` as while it runs, which no guard sees.
 */
const redefinedFetch = vi.fn(() => Promise.resolve(new Response("redefined")));

const redefineFetch = () =>
  Object.defineProperty(globalThis, "fetch", {
    value: redefinedFetch,
    writable: true,
    configurable: true,
  });

const schema = defineSchema({ notes: defineTable({ text: v.string() }) });

const modules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "io.ts": () => {
    // A module that keeps the global when the backend loads it.
    const captured = globalThis.fetch;
    return Promise.resolve({
      fetchInQuery: queryGeneric({
        args: { url: v.string() },
        // oxlint-disable-next-line effecttsgo/global-fetch -- The handler calls the runtime's own fetch, which the I/O bans refuse or allow.
        handler: (_ctx, { url }) => outcomeOf(fetch(url)),
      }),
      fetchInMutation: mutationGeneric({
        args: { url: v.string() },
        // oxlint-disable-next-line effecttsgo/global-fetch -- The handler calls the runtime's own fetch, which the I/O bans refuse or allow.
        handler: (_ctx, { url }) => outcomeOf(fetch(url)),
      }),
      capturedFetchInQuery: queryGeneric({
        args: { url: v.string() },
        // oxlint-disable-next-line effecttsgo/global-fetch -- The handler calls the runtime's own fetch, which the I/O bans refuse or allow.
        handler: (_ctx, { url }) => outcomeOf(captured(url)),
      }),
      importedFetchInQuery: queryGeneric({
        args: { url: v.string() },
        // oxlint-disable-next-line effecttsgo/global-fetch -- The handler calls the runtime's own fetch, which the I/O bans refuse or allow.
        handler: (_ctx, { url }) => outcomeOf(keptFetch(url)),
      }),
      reassignedFetchInQuery: queryGeneric({
        args: { url: v.string() },
        // oxlint-disable-next-line effecttsgo/async-function -- A plain Convex handler is async, as product code is.
        handler: async (_ctx, { url }) => {
          const before = globalThis.fetch;
          globalThis.fetch = (() =>
            Promise.resolve(
              new Response("reassigned"),
            )) as unknown as typeof fetch;
          try {
            // oxlint-disable-next-line effecttsgo/global-fetch -- The handler calls the runtime's own fetch, which the I/O bans refuse or allow.
            return await outcomeOf(fetch(url));
          } finally {
            globalThis.fetch = before;
          }
        },
      }),
      timerInQuery: queryGeneric({
        args: timerArgs,
        handler: (_ctx, { name }) => {
          startTimer(name);
          return "returned";
        },
      }),
      timerInMutation: mutationGeneric({
        args: timerArgs,
        // oxlint-disable-next-line effecttsgo/async-function -- A plain Convex handler is async, as product code is.
        handler: async (ctx, { name }) => {
          await ctx.db.insert("notes", { text: "before" });
          startTimer(name);
          await ctx.db.insert("notes", { text: "after" });
          return "returned";
        },
      }),
      awaitedTimerInQuery: queryGeneric({
        args: timerArgs,
        // oxlint-disable-next-line effecttsgo/async-function -- A plain Convex handler is async, as product code is.
        handler: async (_ctx, { name }) => {
          await awaitTimer(name);
          return "returned";
        },
      }),
      awaitedTimerInMutation: mutationGeneric({
        args: timerArgs,
        // oxlint-disable-next-line effecttsgo/async-function -- A plain Convex handler is async, as product code is.
        handler: async (ctx, { name }) => {
          await ctx.db.insert("notes", { text: "before" });
          await awaitTimer(name);
          return "returned";
        },
      }),
      surfaceInQuery: queryGeneric({ args: {}, handler: surface }),
      surfaceInMutation: mutationGeneric({ args: {}, handler: surface }),
      surfaceInAction: actionGeneric({ args: {}, handler: surface }),
      confectSurface: isolateSurface,
      importedImmediateInQuery: queryGeneric({
        args: {},
        handler: () =>
          outcomeOf(Promise.resolve().then(() => keptSetImmediate(() => {}))),
      }),
      formDataInQuery: queryGeneric({
        args: bodyArgs,
        handler: (_ctx, { body }) => parseForm(body),
      }),
      formDataInMutation: mutationGeneric({
        args: bodyArgs,
        handler: (_ctx, { body }) => parseForm(body),
      }),
      formDataInAction: actionGeneric({
        args: bodyArgs,
        handler: (_ctx, { body }) => parseForm(body),
      }),
      clearInQuery: queryGeneric({
        args: {},
        handler: () => {
          clearTimeout(1);
          clearInterval(1);
          return "cleared";
        },
      }),
      notes: queryGeneric({
        args: {},
        handler: (ctx) =>
          ctx.db
            .query("notes")
            .collect()
            .then((rows) => Arr.map(rows, (row) => row.text)),
      }),
      fetchThroughNestedMutation: mutationGeneric({
        args: { url: v.string() },
        handler: (ctx, { url }) => ctx.runMutation(io.fetchInMutation, { url }),
      }),
      fetchThroughQuery: actionGeneric({
        args: { url: v.string() },
        handler: (ctx, { url }) => ctx.runQuery(io.fetchInQuery, { url }),
      }),
      fetchThroughMutation: actionGeneric({
        args: { url: v.string() },
        handler: (ctx, { url }) => ctx.runMutation(io.fetchInMutation, { url }),
      }),
      timerThroughQuery: actionGeneric({
        args: timerArgs,
        handler: (ctx, { name }) =>
          ctx.runQuery(io.timerInQuery, { name }).then(
            () => "returned",
            (error: Error) => error.message,
          ),
      }),
      fetchInAction: actionGeneric({
        args: { url: v.string() },
        // The handler catches the rejection, and the action dies anyway.
        handler: (_ctx, { url }) =>
          // oxlint-disable-next-line effecttsgo/global-fetch -- The handler calls the runtime's own fetch, which the I/O bans refuse or allow.
          fetch(url).then(
            (response) => response.text(),
            () => "caught",
          ),
      }),
      fetchThenWrite: actionGeneric({
        args: { url: v.string() },
        // oxlint-disable-next-line effecttsgo/async-function -- A plain Convex handler is async, as product code is.
        handler: async (ctx, { url }) => {
          // oxlint-disable-next-line effecttsgo/global-fetch -- The handler calls the runtime's own fetch, which the I/O bans refuse or allow.
          await fetch(url).catch(() => null);
          const write = ctx.runMutation(io.addNote, { text: "after" });
          lateWrites.push(write);
          return write;
        },
      }),
      addNote: mutationGeneric({
        args: { text: v.string() },
        handler: (ctx, { text }) =>
          ctx.db.insert("notes", { text }).then(() => null),
      }),
      promisifiedTimerInQuery: queryGeneric({
        args: {},
        // oxlint-disable-next-line effecttsgo/async-function -- A plain Convex handler is async, as product code is.
        handler: async () => {
          await Util.promisify(setTimeout)(10);
          return "returned";
        },
      }),
      fakedStackInQuery: queryGeneric({
        args: {},
        // A user's prepareStackTrace that claims every frame is Node's fetch,
        // and that the kernel's own assignment cannot replace.
        handler: () => {
          const original = Object.getOwnPropertyDescriptor(
            Error,
            "prepareStackTrace",
          );
          Object.defineProperty(Error, "prepareStackTrace", {
            get: () => () => [
              { getFileName: () => "node:internal/deps/undici/undici" },
            ],
            set: () => {},
            configurable: true,
          });
          try {
            return typeof queueMicrotask;
          } finally {
            if (original === undefined) {
              Reflect.deleteProperty(Error, "prepareStackTrace");
            } else {
              Object.defineProperty(Error, "prepareStackTrace", original);
            }
          }
        },
      }),
      namedNodeScriptInQuery: queryGeneric({
        args: {},
        // A script that names itself as one of Node's modules.
        handler: () =>
          Vm.runInThisContext("typeof queueMicrotask", {
            filename: "node:internal/deps/undici/undici-lookalike",
          }) as string,
      }),
      redefinedFetchInQuery: queryGeneric({
        args: { url: v.string() },
        handler: (_ctx, { url }) => {
          redefineFetch();
          // oxlint-disable-next-line effecttsgo/global-fetch -- The handler calls the runtime's own fetch, which the I/O bans refuse or allow.
          return fetch(url).then((response) => response.text());
        },
      }),
      redefinedFetchInMutation: mutationGeneric({
        args: { url: v.string() },
        // oxlint-disable-next-line effecttsgo/async-function -- A plain Convex handler is async, as product code is.
        handler: async (ctx, { url }) => {
          await ctx.db.insert("notes", { text: "before" });
          redefineFetch();
          // oxlint-disable-next-line effecttsgo/global-fetch -- The handler calls the runtime's own fetch, which the I/O bans refuse or allow.
          await fetch(url);
          await ctx.db.insert("notes", { text: "after" });
          return "returned";
        },
      }),
      redefinedFetchInAction: actionGeneric({
        args: { url: v.string() },
        handler: (_ctx, { url }) => {
          redefineFetch();
          // oxlint-disable-next-line effecttsgo/global-fetch -- The handler calls the runtime's own fetch, which the I/O bans refuse or allow.
          return fetch(url).then((response) => response.text());
        },
      }),
      overlaidFetchInQuery: queryGeneric({
        args: { url: v.string() },
        // An accessor laid over the guard's that reads through it, as
        // convex-test lays its own before each of its handlers.
        handler: (_ctx, { url }) => {
          const beneath = Object.getOwnPropertyDescriptor(globalThis, "fetch")!;
          Object.defineProperty(globalThis, "fetch", {
            get: () => beneath.get?.call(globalThis),
            set: (value: unknown) => {
              beneath.set?.call(globalThis, value);
            },
            configurable: true,
          });
          // oxlint-disable-next-line effecttsgo/global-fetch -- The handler calls the runtime's own fetch, which the I/O bans refuse or allow.
          return outcomeOf(fetch(url));
        },
      }),
      getterFetchInMutation: mutationGeneric({
        args: { url: v.string() },
        // A getter that answers the replacement while the handler runs and the
        // guard again by the time the function settles.
        // oxlint-disable-next-line effecttsgo/async-function -- A plain Convex handler is async, as product code is.
        handler: async (ctx, { url }) => {
          const guard = globalThis.fetch;
          let settling = false;
          Object.defineProperty(globalThis, "fetch", {
            get: () => (settling ? guard : redefinedFetch),
            configurable: true,
          });
          // oxlint-disable-next-line effecttsgo/global-fetch -- The handler calls the runtime's own fetch, which the I/O bans refuse or allow.
          await fetch(url);
          await ctx.db.insert("notes", { text: "after" });
          settling = true;
          return "returned";
        },
      }),
      restoredFetchInMutation: mutationGeneric({
        args: { url: v.string() },
        // A replacement redefined, called and removed again, its exact
        // descriptor restored, before the function settles.
        // oxlint-disable-next-line effecttsgo/async-function -- A plain Convex handler is async, as product code is.
        handler: async (ctx, { url }) => {
          const before = Object.getOwnPropertyDescriptor(globalThis, "fetch")!;
          redefineFetch();
          // oxlint-disable-next-line effecttsgo/global-fetch -- The handler calls the runtime's own fetch, which the I/O bans refuse or allow.
          await fetch(url);
          Object.defineProperty(globalThis, "fetch", before);
          await ctx.db.insert("notes", { text: "after" });
          return "returned";
        },
      }),
      inheritedFetchInMutation: mutationGeneric({
        args: { url: v.string() },
        // A replacement moved onto the global's prototype, with the own
        // property deleted.
        // oxlint-disable-next-line effecttsgo/async-function -- A plain Convex handler is async, as product code is.
        handler: async (ctx, { url }) => {
          Object.defineProperty(Object.getPrototypeOf(globalThis), "fetch", {
            value: redefinedFetch,
            writable: true,
            configurable: true,
          });
          Reflect.deleteProperty(globalThis, "fetch");
          // oxlint-disable-next-line effecttsgo/global-fetch -- The handler calls the runtime's own fetch, which the I/O bans refuse or allow.
          await fetch(url);
          await ctx.db.insert("notes", { text: "after" });
          return "returned";
        },
      }),
      timersInAction: actionGeneric({
        args: {},
        // oxlint-disable-next-line effecttsgo/async-function -- A plain Convex handler is async, as product code is.
        handler: async () => {
          // oxlint-disable-next-line effecttsgo/new-promise -- The case waits on the runtime's own timer callback, which is what the I/O bans refuse or allow.
          const slept = await new Promise<string>((resolve) =>
            // oxlint-disable-next-line effecttsgo/global-timers -- The handler starts the runtime's own timer, which the I/O bans refuse or allow.
            setTimeout(() => resolve("slept"), 1),
          );
          // oxlint-disable-next-line effecttsgo/new-promise -- The case waits on the runtime's own timer callback, which is what the I/O bans refuse or allow.
          const ticked = await new Promise<string>((resolve) => {
            // oxlint-disable-next-line effecttsgo/global-timers -- The handler starts the runtime's own timer, which the I/O bans refuse or allow.
            const id = setInterval(() => {
              clearInterval(id);
              resolve("ticked");
            }, 1);
          });
          return [slept, ticked];
        },
      }),
    });
  },
  "ioNode.ts": () => Promise.resolve({ surface: nodeSurface }),
};

// Each inline module's source: only ioNode.ts has a "use node" directive.
const sources = inlineSources(modules, ["ioNode.ts"]);

// The URL carries a query string, which the binary's message leaves out.
const url = "https://api.example.com/v1/charges?token=secret";

const fetchRefusal = {
  name: "TypeError",
  message:
    "fetch to https://api.example.com/v1/charges failed: Can't use fetch() in queries and mutations. Please consider using an action. See https://docs.convex.dev/functions/actions for more details.",
};

const timerRefusal = (name: Timer) =>
  `Can't use ${name} in queries and mutations. Please consider using an action. See https://docs.convex.dev/functions/actions for more details.`;

const failureOf = (call: Promise<unknown>) =>
  Effect.promise(() =>
    call.then(
      (value) => ({ returned: value }),
      (error: Error) => ({ failed: error.message }),
    ),
  );

const absent = { setImmediate: "undefined", queueMicrotask: "undefined" };

describe("I/O bans", () => {
  describe("fetch", () => {
    it.effect.each(["fetchInQuery", "fetchInMutation"] as const)(
      "%s rejects with the binary's TypeError, which the handler can catch",
      (name) =>
        Effect.gen(function* () {
          const t = convexTest({ schema, modules, sources });
          const call =
            name === "fetchInQuery"
              ? t.query(io[name], { url })
              : t.mutation(io[name], { url });
          const observed = yield* Effect.promise(() => call);
          expect(observed).toEqual(fetchRefusal);
        }),
    );

    it.effect(
      "a reference a module kept when the backend loaded it is refused in a query",
      () =>
        Effect.gen(function* () {
          const t = convexTest({ schema, modules, sources });
          const observed = yield* Effect.promise(() =>
            t.query(io.capturedFetchInQuery, { url }),
          );
          expect(observed).toEqual(fetchRefusal);
        }),
    );

    it.effect(
      "a reference a module kept when it was imported, before any backend existed, is refused in a query",
      () =>
        Effect.gen(function* () {
          const t = convexTest({ schema, modules, sources });
          const observed = yield* Effect.promise(() =>
            t.query(io.importedFetchInQuery, { url }),
          );
          expect(observed).toEqual(fetchRefusal);
        }),
    );

    it.effect(
      "a handler that reassigns globalThis.fetch mid-invocation is still refused, and the host's fetch comes back",
      () =>
        Effect.gen(function* () {
          const t = convexTest({ schema, modules, sources });
          const host = Reflect.get(globalThis, "fetch");
          const observed = yield* Effect.promise(() =>
            t.query(io.reassignedFetchInQuery, { url }),
          );
          expect(observed).toEqual(fetchRefusal);
          expect(Reflect.get(globalThis, "fetch")).toBe(host);
          const server = yield* loopback;
          const observed2 = yield* Effect.promise(() =>
            // oxlint-disable-next-line effecttsgo/global-fetch-in-effect -- The handler calls the runtime's own fetch, which the I/O bans refuse or allow.
            fetch(server.url).then((response) => response.text()),
          );
          expect(observed2).toBe("reached /ping");
        }).pipe(Effect.scoped),
    );

    it.effect(
      "a fetch a test stubbed after the backend opened is refused in a query",
      () =>
        Effect.gen(function* () {
          const t = convexTest({ schema, modules, sources });
          yield* Effect.promise(() => t.query(io.notes, {}));
          const stub = vi.fn(() => Promise.resolve(new Response("stubbed")));
          vi.stubGlobal("fetch", stub);
          const outcome = yield* Effect.promise(() =>
            t.query(io.fetchInQuery, { url }),
          ).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllGlobals())));
          expect(outcome).toEqual(fetchRefusal);
          expect(stub).not.toHaveBeenCalled();
        }),
    );

    it.effect("a query or mutation another function calls is refused", () =>
      Effect.gen(function* () {
        const t = convexTest({ schema, modules, sources });
        const observed = yield* Effect.promise(() =>
          t.action(io.fetchThroughQuery, { url }),
        );
        expect(observed).toEqual(fetchRefusal);
        const observed2 = yield* Effect.promise(() =>
          t.action(io.fetchThroughMutation, { url }),
        );
        expect(observed2).toEqual(fetchRefusal);
        const observed3 = yield* Effect.promise(() =>
          t.mutation(io.fetchThroughNestedMutation, { url }),
        );
        expect(observed3).toEqual(fetchRefusal);
      }),
    );
  });

  describe("action egress", () => {
    const refusalOf = (call: Promise<unknown>) =>
      Effect.promise(() =>
        call.then(
          (value) => ({ returned: value }),
          (error: KernelRefusal.BackendRefusal) => error,
        ),
      );

    it.effect(
      "a raw fetch in an action dies with UndeclaredFetch naming the action and host, whatever the handler catches",
      () =>
        Effect.gen(function* () {
          const server = yield* loopback;
          const t = convexTest({ schema, modules, sources });
          const refusal = yield* refusalOf(
            t.action(io.fetchInAction, { url: server.url }),
          );
          expect(refusal).toMatchObject({
            _tag: "BackendRefusal",
            reason: "UndeclaredFetch",
            componentPath: "",
            functionName: "io:fetchInAction",
            host: server.host,
            docs: "https://confect.dev/guides/testing#reach-the-network-from-an-action",
          });
          expect((refusal as Error).message).toBe(
            `The action io:fetchInAction fetched ${server.host} directly. The test kernel performs no raw fetch, so a test never reaches the network and a run replays. Reach ${server.host} through a provider port. The kernel holds each port call as a command the test answers. See https://confect.dev/guides/testing#reach-the-network-from-an-action.`,
          );
          expect(server.hits()).toBe(0);
        }).pipe(Effect.scoped),
    );

    it.effect("an action that made a raw fetch runs no later syscall", () =>
      Effect.gen(function* () {
        lateWrites.length = 0;
        const server = yield* loopback;
        const t = convexTest({ schema, modules, sources });
        const refused = yield* refusalOf(
          t.action(io.fetchThenWrite, { url: server.url }),
        );
        expect(refused).toMatchObject({ reason: "UndeclaredFetch" });
        // The action settled at once, so the write its handler went on to make
        // is awaited before the table is read.
        const writes = yield* Effect.promise(() =>
          Promise.allSettled(lateWrites),
        );
        expect(writes).toMatchObject([
          { status: "rejected", reason: { reason: "UndeclaredFetch" } },
        ]);
        const notes = yield* Effect.promise(() => t.query(io.notes, {}));
        expect(notes).toEqual([]);
      }).pipe(Effect.scoped),
    );

    it.effect("a component's action is named with its component path", () =>
      Effect.gen(function* () {
        const server = yield* loopback;
        const t = convexTest({ schema, modules, sources });
        const storeModules = {
          "_generated/server.ts": () => Promise.resolve({}),
          "egress.ts": () =>
            Promise.resolve({
              fetchInAction: actionGeneric({
                args: { url: v.string() },
                // oxlint-disable-next-line effecttsgo/global-fetch -- The handler calls the runtime's own fetch, which the I/O bans refuse or allow.
                handler: (_ctx, args) => fetch(args.url).then(() => null),
              }),
            }),
        };
        t.registerComponent("store", schema, storeModules, {
          sources: inlineSources(storeModules),
        });
        const store = (componentsGeneric() as any).store;
        const refused = yield* refusalOf(
          t.action(store.egress.fetchInAction, { url: server.url }),
        );
        expect(refused).toMatchObject({
          reason: "UndeclaredFetch",
          componentPath: "store",
          functionName: "egress:fetchInAction",
          host: server.host,
        });
        expect(server.hits()).toBe(0);
      }).pipe(Effect.scoped),
    );
  });

  describe("host timers", () => {
    it.effect.each(["setTimeout", "setInterval"] as const)(
      "a query that starts %s fails with the binary's error after it returns",
      (name) =>
        Effect.gen(function* () {
          const t = convexTest({ schema, modules, sources });
          const observed = yield* failureOf(t.query(io.timerInQuery, { name }));
          expect(observed).toEqual({
            failed: timerRefusal(name),
          });
        }),
    );

    it.effect.each(["setTimeout", "setInterval"] as const)(
      "a mutation that starts %s fails and publishes none of its writes",
      (name) =>
        Effect.gen(function* () {
          const t = convexTest({ schema, modules, sources });
          const observed = yield* failureOf(
            t.mutation(io.timerInMutation, { name }),
          );
          expect(observed).toEqual({
            failed: timerRefusal(name),
          });
          const observed2 = yield* Effect.promise(() => t.query(io.notes, {}));
          expect(observed2).toEqual([]);
        }),
    );

    it.effect.each(["setTimeout", "setInterval"] as const)(
      "a query that awaits %s fails with the binary's error without waiting for its handler",
      (name) =>
        Effect.gen(function* () {
          const t = convexTest({ schema, modules, sources });
          const observed = yield* failureOf(
            t.query(io.awaitedTimerInQuery, { name }),
          );
          expect(observed).toEqual({ failed: timerRefusal(name) });
        }),
    );

    it.effect.each(["setTimeout", "setInterval"] as const)(
      "a mutation that awaits %s fails without waiting for its handler and publishes none of its writes",
      (name) =>
        Effect.gen(function* () {
          const t = convexTest({ schema, modules, sources });
          const observed = yield* failureOf(
            t.mutation(io.awaitedTimerInMutation, { name }),
          );
          expect(observed).toEqual({ failed: timerRefusal(name) });
          const observed2 = yield* Effect.promise(() => t.query(io.notes, {}));
          expect(observed2).toEqual([]);
        }),
    );

    it.effect(
      "a query an action calls fails, and the action sees its error",
      () =>
        Effect.gen(function* () {
          const t = convexTest({ schema, modules, sources });
          const observed = yield* Effect.promise(() =>
            t.action(io.timerThroughQuery, { name: "setTimeout" }),
          );
          expect(observed).toBe(timerRefusal("setTimeout"));
        }),
    );

    it.effect("a query may clear a timer, as the binary allows", () =>
      Effect.gen(function* () {
        const t = convexTest({ schema, modules, sources });
        const observed = yield* Effect.promise(() =>
          t.query(io.clearInQuery, {}),
        );
        expect(observed).toBe("cleared");
      }),
    );

    it.effect("an action runs host timers", () =>
      Effect.gen(function* () {
        const t = convexTest({ schema, modules, sources });
        const observed = yield* Effect.promise(() =>
          t.action(io.timersInAction, {}),
        );
        expect(observed).toEqual(["slept", "ticked"]);
      }),
    );

    it.effect(
      "fake timers install and uninstall through the guards, and a query is still refused while they are on",
      () =>
        Effect.gen(function* () {
          const t = convexTest({ schema, modules, sources });
          for (const round of [1, 2]) {
            vi.useFakeTimers();
            let fired = false;
            // oxlint-disable-next-line effecttsgo/global-timers-in-effect -- The handler starts the runtime's own timer, which the I/O bans refuse or allow.
            setTimeout(() => {
              fired = true;
            }, 1000);
            vi.advanceTimersByTime(1000);
            expect(fired, `round ${round}`).toBe(true);
            const observed = yield* failureOf(
              t.query(io.timerInQuery, { name: "setTimeout" }),
            );
            expect(observed).toEqual({ failed: timerRefusal("setTimeout") });
            vi.useRealTimers();
          }
          const observed2 = yield* Effect.promise(
            () =>
              // oxlint-disable-next-line effecttsgo/new-promise -- The case waits on the runtime's own timer callback, which is what the I/O bans refuse or allow.
              new Promise<string>((resolve) =>
                // oxlint-disable-next-line effecttsgo/global-timers -- The handler starts the runtime's own timer, which the I/O bans refuse or allow.
                setTimeout(() => resolve("real"), 1),
              ),
          );
          expect(observed2).toBe("real");
        }),
    );
  });

  describe("kept references", () => {
    it.effect(
      "a timer kept before fake timers stays the real one while they are on, as convex-test relies on",
      () =>
        Effect.gen(function* () {
          const kept = setTimeout;
          vi.useFakeTimers();
          const fired = yield* Effect.promise(
            () =>
              // oxlint-disable-next-line effecttsgo/new-promise -- The case waits on the runtime's own timer callback, which is what the I/O bans refuse or allow.
              new Promise<string>((resolve) => {
                // oxlint-disable-next-line effecttsgo/global-timers -- The handler starts the runtime's own timer, which the I/O bans refuse or allow.
                kept(() => resolve("real"), 1);
              }),
          ).pipe(Effect.ensuring(Effect.sync(() => vi.useRealTimers())));
          expect(fired).toBe("real");
        }),
    );
  });

  describe("runtime globals", () => {
    it.effect(
      "a query, a mutation and an isolate action have no setImmediate and no queueMicrotask, as the binary's isolate",
      () =>
        Effect.gen(function* () {
          const t = convexTest({ schema, modules, sources });
          const observed = yield* Effect.promise(() =>
            t.query(io.surfaceInQuery, {}),
          );
          expect(observed).toEqual(absent);
          const observed2 = yield* Effect.promise(() =>
            t.mutation(io.surfaceInMutation, {}),
          );
          expect(observed2).toEqual(absent);
          const observed3 = yield* Effect.promise(() =>
            t.action(io.surfaceInAction, {}),
          );
          expect(observed3).toEqual(absent);
          const observed4 = yield* Effect.promise(() =>
            t.action(io.confectSurface, {}),
          );
          expect(observed4).toEqual(absent);
          expect(surface()).toEqual({
            setImmediate: "function",
            queueMicrotask: "function",
          });
        }),
    );

    it.effect(
      "a Confect Node action has Node's setImmediate and queueMicrotask",
      () =>
        Effect.gen(function* () {
          const t = convexTest({ schema, modules, sources });
          const observed = yield* Effect.promise(() =>
            t.action(io.nodeSurface, {}),
          );
          expect(observed).toEqual({
            setImmediate: "function",
            queueMicrotask: "function",
          });
        }),
    );

    it.effect(
      "a setImmediate a module kept when it was imported fails in a query as the missing global does",
      () =>
        Effect.gen(function* () {
          const t = convexTest({ schema, modules, sources });
          const observed = yield* Effect.promise(() =>
            t.query(io.importedImmediateInQuery, {}),
          );
          expect(observed).toEqual({
            name: "ReferenceError",
            message: "setImmediate is not defined",
          });
        }),
    );
  });

  describe("multipart formData", () => {
    const refusal = {
      name: "Error",
      message:
        "Can't use formData() in queries and mutations. Please consider using an action. See https://docs.convex.dev/functions/actions for more details.",
    };

    it.effect(
      "a query's and a mutation's multipart formData() reject with the binary's error",
      () =>
        Effect.gen(function* () {
          const t = convexTest({ schema, modules, sources });
          const observed = yield* Effect.promise(() =>
            t.query(io.formDataInQuery, { body: "multipart" }),
          );
          expect(observed).toEqual(refusal);
          const observed2 = yield* Effect.promise(() =>
            t.mutation(io.formDataInMutation, { body: "multipart" }),
          );
          expect(observed2).toEqual(refusal);
        }),
    );

    it.effect(
      "a query parses a urlencoded body and refuses multipart without a boundary as the binary does",
      () =>
        Effect.gen(function* () {
          const t = convexTest({ schema, modules, sources });
          const observed = yield* Effect.promise(() =>
            t.query(io.formDataInQuery, { body: "urlencoded" }),
          );
          expect(observed).toEqual({ returned: "ada" });
          const observed2 = yield* Effect.promise(() =>
            t.query(io.formDataInQuery, {
              body: "multipartWithoutBoundary",
            }),
          );
          expect(observed2).toEqual({
            name: "TypeError",
            message:
              "Missing boundary parameter in mime type of multipart formdata.",
          });
        }),
    );

    it.effect("an action parses a multipart body", () =>
      Effect.gen(function* () {
        const t = convexTest({ schema, modules, sources });
        const observed = yield* Effect.promise(() =>
          t.action(io.formDataInAction, { body: "multipart" }),
        );
        expect(observed).toEqual({ returned: "ada" });
      }),
    );
  });
});

describe("replaced globals", () => {
  const original = (name: string) =>
    Object.getOwnPropertyDescriptor(globalThis, name)!;

  it.effect(
    "a fetch a test redefined with defineProperty is adopted and still refused in a query",
    () =>
      Effect.gen(function* () {
        const t = convexTest({ schema, modules, sources });
        yield* Effect.promise(() => t.query(io.notes, {}));
        const before = original("fetch");
        const stub = vi.fn(() => Promise.resolve(new Response("stubbed")));
        Object.defineProperty(globalThis, "fetch", {
          value: stub,
          writable: true,
          configurable: true,
        });
        const outcome = yield* Effect.promise(() =>
          t.query(io.fetchInQuery, { url }),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() =>
              Object.defineProperty(globalThis, "fetch", before),
            ),
          ),
        );
        expect(outcome).toEqual(fetchRefusal);
        expect(stub).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    "a fetch a test deleted and assigned again is adopted and still refused in a query",
    () =>
      Effect.gen(function* () {
        const t = convexTest({ schema, modules, sources });
        yield* Effect.promise(() => t.query(io.notes, {}));
        const before = original("fetch");
        const stub = vi.fn(() => Promise.resolve(new Response("stubbed")));
        Reflect.deleteProperty(globalThis, "fetch");
        Reflect.set(globalThis, "fetch", stub);
        const outcome = yield* Effect.promise(() =>
          t.query(io.fetchInQuery, { url }),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() =>
              Object.defineProperty(globalThis, "fetch", before),
            ),
          ),
        );
        expect(outcome).toEqual(fetchRefusal);
        expect(stub).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    "a stub vi.stubGlobal made is adopted, still refused in a query, and called outside one",
    () =>
      Effect.gen(function* () {
        const t = convexTest({ schema, modules, sources });
        yield* Effect.promise(() => t.query(io.notes, {}));
        const stub = vi.fn(() => Promise.resolve(new Response("stubbed")));
        vi.stubGlobal("fetch", stub);
        const outcome = yield* Effect.promise(() =>
          t.query(io.fetchInQuery, { url }),
        );
        const outside = yield* Effect.promise(() =>
          // oxlint-disable-next-line effecttsgo/global-fetch-in-effect -- The handler calls the runtime's own fetch, which the I/O bans refuse or allow.
          fetch("https://example.com/").then((response) => response.text()),
        ).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllGlobals())));
        expect(outcome).toEqual(fetchRefusal);
        expect(outside).toBe("stubbed");
        expect(stub).toHaveBeenCalledOnce();
      }),
  );

  // What a function that redefined a guarded global while it ran fails with.
  const replacedOutcome = (call: Promise<unknown>) =>
    Effect.promise(() =>
      call.then(
        (value) => ({ returned: value }),
        (error: {
          readonly _tag?: string;
          readonly reason?: string;
          readonly globals?: unknown;
        }) => ({
          failed: error._tag,
          reason: error.reason,
          globals: error.globals,
        }),
      ),
    );

  const replacedRefusal = {
    failed: "UnguardableGlobal",
    reason: "replacedWhileRunning",
    globals: ["fetch"],
  };

  it.effect.each([
    { article: "a", kind: "query" },
    { article: "an", kind: "action" },
  ] as const)(
    "$article $kind that redefines fetch and calls it is not blocked, but ends refused, and the guard is back",
    ({ kind }) =>
      Effect.gen(function* () {
        const t = convexTest({ schema, modules, sources });
        yield* Effect.promise(() => t.query(io.notes, {}));
        const before = original("fetch");
        redefinedFetch.mockClear();
        const outcome = yield* replacedOutcome(
          kind === "query"
            ? t.query(io.redefinedFetchInQuery, { url })
            : t.action(io.redefinedFetchInAction, { url }),
        );
        const calls = redefinedFetch.mock.calls.length;
        // The refusal installed the guard again over the replacement, before
        // any other function starts.
        const reguarded = "get" in original("fetch");
        const after = yield* Effect.promise(() =>
          t.query(io.fetchInQuery, { url }),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() =>
              Object.defineProperty(globalThis, "fetch", before),
            ),
          ),
        );
        expect(outcome).toEqual(replacedRefusal);
        expect(calls).toBe(1);
        expect(reguarded).toBe(true);
        expect(after).toEqual(fetchRefusal);
        expect(redefinedFetch).toHaveBeenCalledOnce();
      }),
  );

  it.effect(
    "a mutation that redefines fetch and calls it ends refused and publishes nothing",
    () =>
      Effect.gen(function* () {
        const t = convexTest({ schema, modules, sources });
        const before = original("fetch");
        const outcome = yield* replacedOutcome(
          t.mutation(io.redefinedFetchInMutation, { url }),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() =>
              Object.defineProperty(globalThis, "fetch", before),
            ),
          ),
        );
        expect(outcome).toEqual(replacedRefusal);
        const observed = yield* Effect.promise(() => t.query(io.notes, {}));
        expect(observed).toEqual([]);
      }),
  );

  it.effect(
    "a getter a test leaves on one guarded global that replaces another when read refuses the function before it runs, with installFailed naming the global it undid",
    () =>
      Effect.gen(function* () {
        const t = convexTest({ schema, modules, sources });
        yield* Effect.promise(() => t.query(io.notes, {}));
        const fetchBefore = original("fetch");
        const timeoutBefore = original("setTimeout");
        const guardedTimeout = globalThis.setTimeout;
        redefinedFetch.mockClear();
        Object.defineProperty(globalThis, "setTimeout", {
          get: () => {
            redefineFetch();
            return guardedTimeout;
          },
          configurable: true,
        });
        const outcome = yield* replacedOutcome(
          t.query(io.fetchInQuery, { url }),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              Object.defineProperty(globalThis, "setTimeout", timeoutBefore);
              Object.defineProperty(globalThis, "fetch", fetchBefore);
            }),
          ),
        );
        expect(outcome).toEqual({
          failed: "UnguardableGlobal",
          reason: "installFailed",
          globals: ["fetch"],
        });
        expect(redefinedFetch).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    "the guards build with the host's Request captured at load, so a Request a test stubs never answers a refused fetch",
    () =>
      Effect.gen(function* () {
        const t = convexTest({ schema, modules, sources });
        yield* Effect.promise(() => t.query(io.notes, {}));
        vi.stubGlobal(
          "Request",
          vi.fn(function stubbedRequest() {
            throw new Error("the stubbed Request");
          }),
        );
        const outcome = yield* Effect.promise(() =>
          t.query(io.fetchInQuery, { url }),
        ).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllGlobals())));
        expect(outcome).toEqual(fetchRefusal);
      }),
  );

  it.effect(
    "an accessor laid over the guard while a query runs reads through it and is no replacement",
    () =>
      Effect.gen(function* () {
        const t = convexTest({ schema, modules, sources });
        yield* Effect.promise(() => t.query(io.notes, {}));
        const before = original("fetch");
        const outcome = yield* Effect.promise(() =>
          t.query(io.overlaidFetchInQuery, { url }),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() =>
              Object.defineProperty(globalThis, "fetch", before),
            ),
          ),
        );
        expect(outcome).toEqual(fetchRefusal);
      }),
  );

  it.effect(
    "the documented limit: a getter that answers the replacement while a mutation runs and the guard at settlement is hostile, so it is neither blocked nor reported",
    () =>
      Effect.gen(function* () {
        const t = convexTest({ schema, modules, sources });
        const before = original("fetch");
        redefinedFetch.mockClear();
        const outcome = yield* replacedOutcome(
          t.mutation(io.getterFetchInMutation, { url }),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() =>
              Object.defineProperty(globalThis, "fetch", before),
            ),
          ),
        );
        const notes = yield* Effect.promise(() => t.query(io.notes, {}));
        expect(outcome).toEqual({ returned: "returned" });
        expect(redefinedFetch).toHaveBeenCalledOnce();
        expect(notes).toEqual(["after"]);
      }),
  );

  it.effect(
    "the documented limit: a replacement redefined, called and removed again before the function settles is neither blocked nor reported",
    () =>
      Effect.gen(function* () {
        const t = convexTest({ schema, modules, sources });
        const before = original("fetch");
        redefinedFetch.mockClear();
        const outcome = yield* replacedOutcome(
          t.mutation(io.restoredFetchInMutation, { url }),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() =>
              Object.defineProperty(globalThis, "fetch", before),
            ),
          ),
        );
        const notes = yield* Effect.promise(() => t.query(io.notes, {}));
        expect(outcome).toEqual({ returned: "returned" });
        expect(redefinedFetch).toHaveBeenCalledOnce();
        expect(notes).toEqual(["after"]);
      }),
  );

  it.effect(
    "a replacement moved onto the global's prototype fails its mutation, and the next mutation meets an own guard again",
    () =>
      Effect.gen(function* () {
        const t = convexTest({ schema, modules, sources });
        const before = original("fetch");
        const prototype = Object.getPrototypeOf(globalThis) as object;
        redefinedFetch.mockClear();
        const restore = Effect.sync(() => {
          Reflect.deleteProperty(prototype, "fetch");
          Object.defineProperty(globalThis, "fetch", before);
        });
        const first = yield* replacedOutcome(
          t.mutation(io.inheritedFetchInMutation, { url }),
        ).pipe(Effect.onError(() => restore));
        const reguarded = "get" in original("fetch");
        const second = yield* Effect.promise(() =>
          t.mutation(io.fetchInMutation, { url }),
        ).pipe(Effect.ensuring(restore));
        const notes = yield* Effect.promise(() => t.query(io.notes, {}));
        expect(first).toEqual(replacedRefusal);
        expect(reguarded).toBe(true);
        expect(second).toEqual(fetchRefusal);
        expect(redefinedFetch).toHaveBeenCalledOnce();
        expect(notes).toEqual([]);
      }),
  );

  it.effect(
    "util.promisify(setTimeout) in a query ends it with the binary's error",
    () =>
      Effect.gen(function* () {
        const t = convexTest({ schema, modules, sources });
        const observed = yield* failureOf(
          t.query(io.promisifiedTimerInQuery, {}),
        );
        expect(observed).toEqual({ failed: timerRefusal("setTimeout") });
      }),
  );
});

describe("Node callers", () => {
  it.effect(
    "a user's prepareStackTrace cannot pass a query's code off as Node's",
    () =>
      Effect.gen(function* () {
        const t = convexTest({ schema, modules, sources });
        const observed = yield* Effect.promise(() =>
          t.query(io.fakedStackInQuery, {}),
        );
        expect(observed).toBe("undefined");
      }),
  );

  it.effect("a script named like a Node module is not Node's own", () =>
    Effect.gen(function* () {
      const t = convexTest({ schema, modules, sources });
      const observed = yield* Effect.promise(() =>
        t.query(io.namedNodeScriptInQuery, {}),
      );
      expect(observed).toBe("undefined");
    }),
  );
});

describe("module loads", () => {
  /**
   * A module that starts `fetch` at its top level, as a client that warms up
   * when it is imported does, and exports functions that return the call's
   * promise. `seen` receives its outcome.
   */
  const fetchingModule =
    (target: string, seen: Array<Promise<unknown>> = []) =>
    () => {
      // oxlint-disable-next-line effecttsgo/global-fetch -- The module's top level calls the runtime's own fetch, which the I/O bans refuse or allow.
      const started = fetch(target).then((response) => response.text());
      // The functions return it later; until then nothing else handles it.
      seen.push(outcomeOf(started));
      return Promise.resolve({
        query: queryGeneric({ args: {}, handler: () => started }),
        action: actionGeneric({ args: {}, handler: () => started }),
      });
    };

  /**
   * A module that starts a timer at its top level and exports functions that
   * return a promise of its callback.
   */
  const timingModule = (fired: () => void) => () => {
    // oxlint-disable-next-line effecttsgo/new-promise -- The module waits on the runtime's own timer callback, which is what the I/O bans refuse or allow.
    const started = new Promise<string>((resolve) => {
      // oxlint-disable-next-line effecttsgo/global-timers -- The module's top level starts the runtime's own timer, which the I/O bans refuse or allow.
      setTimeout(() => {
        fired();
        resolve("fired");
      }, 1);
    });
    return Promise.resolve({
      query: queryGeneric({ args: {}, handler: () => started }),
      action: actionGeneric({ args: {}, handler: () => started }),
    });
  };

  const kernelOver = (
    loaded: Record<string, () => Promise<unknown>>,
    node: ReadonlyArray<string> = [],
  ) => {
    const all = {
      "_generated/server.ts": () => Promise.resolve({}),
      ...loaded,
    };
    return convexTest({
      schema: defineSchema({}),
      modules: all,
      sources: inlineSources(all, node),
    });
  };

  const refusalOf = (call: Promise<unknown>) =>
    Effect.promise(() =>
      call.then(
        (value) => ({ returned: value }),
        (error: Error) => ({ name: error.name, message: error.message }),
      ),
    );

  const query = makeFunctionReference<"query">("load:query");
  const action = makeFunctionReference<"action">("load:action");

  it.effect(
    "a query's module that starts fetch at its top level is refused with the binary's TypeError, and the host is never reached",
    () =>
      Effect.gen(function* () {
        const server = yield* loopback;
        const t = kernelOver({ "load.ts": fetchingModule(server.url) });
        const observed = yield* refusalOf(t.query(query, {}));
        expect(observed).toEqual({
          name: "TypeError",
          message: `fetch to ${server.url} failed: Can't use fetch() in queries and mutations. Please consider using an action. See https://docs.convex.dev/functions/actions for more details.`,
        });
        expect(server.hits()).toBe(0);
      }).pipe(Effect.scoped),
  );

  it.effect.each(["query", "action"] as const)(
    'a module without "use node" whose top level starts a timer fails to load with the binary\'s error, so the %s fails and the timer never fires',
    (kind) =>
      Effect.gen(function* () {
        const fired = vi.fn();
        const t = kernelOver({ "load.ts": timingModule(fired) });
        const observed = yield* refusalOf(
          kind === "query" ? t.query(query, {}) : t.action(action, {}),
        );
        expect(observed).toEqual({
          name: "Error",
          message: timerRefusal("setTimeout"),
        });
        yield* Effect.promise(() => awaitTimer("setTimeout"));
        expect(fired).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    "an isolate action's module that starts fetch at its top level is refused too, where the binary would fetch: kernel boundary ActionModuleLoadFetch",
    () =>
      Effect.gen(function* () {
        const server = yield* loopback;
        const t = kernelOver({ "load.ts": fetchingModule(server.url) });
        const observed = yield* refusalOf(t.action(action, {}));
        expect(observed).toMatchObject({ name: "TypeError" });
        expect(server.hits()).toBe(0);
      }).pipe(Effect.scoped),
  );

  it.effect(
    'a "use node" module keeps the host\'s fetch and timers while it loads',
    () =>
      Effect.gen(function* () {
        const server = yield* loopback;
        const fired = vi.fn();
        const t = kernelOver(
          {
            "load.ts": fetchingModule(server.url),
            "timing.ts": timingModule(fired),
          },
          ["load.ts", "timing.ts"],
        );
        const observed = yield* refusalOf(t.action(action, {}));
        expect(observed).toEqual({ returned: "reached /ping" });
        expect(server.hits()).toBe(1);
        const observed2 = yield* refusalOf(
          t.action(makeFunctionReference<"action">("timing:action"), {}),
        );
        expect(observed2).toEqual({ returned: "fired" });
        expect(fired).toHaveBeenCalledOnce();
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a component registered without sources loads with the host's fetch when the test declares it runs in Node, and under the isolate's rules when it declares the isolate",
    () =>
      Effect.gen(function* () {
        const server = yield* loopback;
        const seen: Array<Promise<unknown>> = [];
        const kitModules = {
          "_generated/server.ts": () => Promise.resolve({}),
          "load.ts": fetchingModule(server.url, seen),
        };
        const open = (
          componentRuntimes: Record<string, "node" | "isolate">,
        ) => {
          const t = convexTest({
            schema: defineSchema({}),
            modules: { "_generated/server.ts": () => Promise.resolve({}) },
            sources: {
              "_generated/server.ts": () => Promise.resolve(""),
            },
            componentRuntimes,
          });
          t.registerComponent("kit", defineSchema({}), kitModules);
          return Effect.promise(() => t.run(() => Promise.resolve(null)));
        };
        yield* open({ kit: "node" });
        yield* open({ kit: "isolate" });
        const outcomes = yield* Effect.promise(() => Promise.all(seen));
        expect(outcomes).toEqual([
          { returned: "reached /ping" },
          {
            name: "TypeError",
            message: `fetch to ${server.url} failed: Can't use fetch() in queries and mutations. Please consider using an action. See https://docs.convex.dev/functions/actions for more details.`,
          },
        ]);
        expect(server.hits()).toBe(1);
      }).pipe(Effect.scoped),
  );
});

describe("module runtimes", () => {
  const runtimeModules = import.meta.glob("./fixtures/runtime/**/*.ts");
  const runtimeSources = import.meta.glob<string>(
    "./fixtures/runtime/**/*.ts",
    {
      query: "?raw",
      import: "default",
    },
  );
  const only = <A>(map: Record<string, A>, files: ReadonlyArray<string>) =>
    Rec.filter(map, (_, key) =>
      Arr.some(["_generated/server.ts", ...files], (file) =>
        pipe(key, Str.endsWith(`/runtime/${file}`)),
      ),
    );
  type RuntimeOutcome =
    | { readonly returned: unknown }
    | {
        readonly failed: string | undefined;
        readonly reason: string | undefined;
        readonly message: string | undefined;
      };
  const runtimeRefusalOf = (
    call: Promise<unknown>,
  ): Effect.Effect<RuntimeOutcome> =>
    Effect.promise(() =>
      call.then(
        (value) => ({ returned: value }),
        (error: {
          readonly _tag?: string;
          readonly reason?: string;
          readonly message?: string;
        }) => ({
          failed: error._tag,
          reason: error.reason,
          message: error.message,
        }),
      ),
    );
  const surfaceOf = (module: string) =>
    makeFunctionReference<"action">(`${module}:surface`);
  const node = { setImmediate: "function", queueMicrotask: "function" };

  it.effect(
    "a plain Convex \"use node\" action has Node's globals, and a module without the directive the isolate's",
    () =>
      Effect.gen(function* () {
        const files = ["plainNode.ts", "plainIsolate.ts"];
        const t = convexTest({
          schema: defineSchema({}),
          modules: only(runtimeModules, files),
          sources: only(runtimeSources, files),
        });
        const observed = yield* Effect.promise(() =>
          t.action(surfaceOf("plainNode"), {}),
        );
        expect(observed).toEqual(node);
        const observed2 = yield* Effect.promise(() =>
          t.action(surfaceOf("plainIsolate"), {}),
        );
        expect(observed2).toEqual(absent);
      }),
  );

  it.effect(
    'a Confect Node action in a module without "use node" is refused, as Convex would run it in its isolate',
    () =>
      Effect.gen(function* () {
        const files = ["markedNode.ts"];
        const t = convexTest({
          schema: defineSchema({}),
          modules: only(runtimeModules, files),
          sources: only(runtimeSources, files),
        });
        const observed = yield* runtimeRefusalOf(
          t.action(surfaceOf("markedNode"), {}),
        );
        expect(observed).toMatchObject({
          failed: "ModuleRuntime",
          reason: "markerDisagrees",
        });
      }),
  );

  it.effect(
    '"use node" in http.ts is refused with the bundler\'s message',
    () =>
      Effect.gen(function* () {
        const files = ["http.ts", "plainIsolate.ts"];
        const t = convexTest({
          schema: defineSchema({}),
          modules: only(runtimeModules, files),
          sources: only(runtimeSources, files),
        });
        const observed = yield* runtimeRefusalOf(
          t.action(surfaceOf("plainIsolate"), {}),
        );
        expect(observed).toEqual({
          failed: "ModuleRuntime",
          reason: "nodeNotAllowed",
          message: '"use node" directive is not allowed for http.',
        });
      }),
  );

  it.effect(
    'a Confect isolate action in a "use node" module is refused, as Convex would run it in Node',
    () =>
      Effect.gen(function* () {
        const files = ["markedIsolateInNode.ts"];
        const t = convexTest({
          schema: defineSchema({}),
          modules: only(runtimeModules, files),
          sources: only(runtimeSources, files),
        });
        const observed = yield* runtimeRefusalOf(
          t.action(surfaceOf("markedIsolateInNode"), {}),
        );
        expect(observed).toMatchObject({
          failed: "ModuleRuntime",
          reason: "markerDisagrees",
        });
      }),
  );

  it.effect(
    "without sources, a plain Convex action is refused when the kernel opens, naming its module",
    () =>
      Effect.gen(function* () {
        const t = convexTest({
          schema: defineSchema({}),
          modules: only(runtimeModules, ["plainNode.ts"]),
        });
        const refused = yield* Effect.promise(() =>
          t.action(surfaceOf("plainNode"), {}).then(
            () => undefined,
            (error: unknown) => error,
          ),
        );
        expect(refused).toMatchObject({
          _tag: "ActionRuntimeUnknown",
          componentPath: "",
          module: "plainNode",
          exports: ["surface"],
        });
      }),
  );

  it.effect(
    "a component named like an Object.prototype member, such as constructor, declares no runtime unless the test lists it",
    () =>
      Effect.gen(function* () {
        const t = convexTest({
          schema: defineSchema({}),
          modules: only(runtimeModules, []),
          sources: only(runtimeSources, []),
        });
        t.registerComponent(
          "constructor",
          defineSchema({}),
          only(runtimeModules, ["plainIsolate.ts"]),
        );
        const refused = yield* Effect.promise(() =>
          t
            .run(() => Promise.resolve(null))
            .then(
              () => undefined,
              (error: unknown) => error,
            ),
        );
        expect(refused).toMatchObject({
          _tag: "ActionRuntimeUnknown",
          componentPath: "constructor",
          module: "plainIsolate",
        });
      }),
  );

  it.effect(
    "without sources, Confect's marks decide: its Node action has Node's globals and its isolate action the isolate's",
    () =>
      Effect.gen(function* () {
        const t = convexTest(schema, {
          "_generated/server.ts": () => Promise.resolve({}),
          "marks.ts": () =>
            Promise.resolve({ node: nodeSurface, isolate: isolateSurface }),
        });
        const observed = yield* Effect.promise(() =>
          t.action(makeFunctionReference<"action">("marks:node"), {}),
        );
        expect(observed).toEqual(node);
        const observed2 = yield* Effect.promise(() =>
          t.action(makeFunctionReference<"action">("marks:isolate"), {}),
        );
        expect(observed2).toEqual(absent);
      }),
  );

  it.effect("a module without a source is refused when sources are given", () =>
    Effect.gen(function* () {
      const t = convexTest({
        schema: defineSchema({}),
        modules: only(runtimeModules, ["plainNode.ts", "plainIsolate.ts"]),
        sources: only(runtimeSources, ["plainIsolate.ts"]),
      });
      const observed = yield* runtimeRefusalOf(
        t.action(surfaceOf("plainIsolate"), {}),
      );
      expect(observed).toMatchObject({
        failed: "ModuleRuntime",
        reason: "missingSource",
      });
    }),
  );

  it("reads the directive prologue as the bundler does", () => {
    expect(hasUseNodeDirective('"use node";\nexport {};')).toBe(true);
    expect(hasUseNodeDirective("'use node'\nexport {};")).toBe(true);
    expect(
      hasUseNodeDirective(
        '#!/usr/bin/env node\n// a note\n/* more */ "use strict";\n"use node";',
      ),
    ).toBe(true);
    expect(hasUseNodeDirective('import x from "y";\n"use node";')).toBe(false);
    expect(hasUseNodeDirective('"use node".length;')).toBe(false);
    expect(hasUseNodeDirective('const note = "use node";')).toBe(false);
  });
});
