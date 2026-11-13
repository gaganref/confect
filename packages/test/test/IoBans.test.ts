// oxlint-disable effecttsgo/global-fetch, effecttsgo/global-fetch-in-effect, effecttsgo/global-timers, effecttsgo/global-timers-in-effect, effecttsgo/new-promise, effecttsgo/async-function -- These handlers call the runtime's own fetch and timers, which is what the I/O bans refuse or allow.
import * as FunctionSpec from "@confect/core/FunctionSpec";
import * as DatabaseSchema from "@confect/server/DatabaseSchema";
import * as FunctionRegistryItem from "@confect/server/FunctionRegistryItem";
import * as RegisteredConvexFunction from "@confect/server/RegisteredConvexFunction";
import { RegisteredNodeFunction } from "@confect/server/node";
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
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { convexTest } from "../src/internal/ConvexTest";
import type * as KernelRefusal from "../src/internal/KernelRefusal";
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
  nodeSurface: makeFunctionReference<"action">("io:nodeSurface"),
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
};

const schema = defineSchema({ notes: defineTable({ text: v.string() }) });

const modules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "io.ts": () => {
    // A module that keeps the global when the backend loads it.
    const captured = globalThis.fetch;
    return Promise.resolve({
      fetchInQuery: queryGeneric({
        args: { url: v.string() },
        handler: (_ctx, { url }) => outcomeOf(fetch(url)),
      }),
      fetchInMutation: mutationGeneric({
        args: { url: v.string() },
        handler: (_ctx, { url }) => outcomeOf(fetch(url)),
      }),
      capturedFetchInQuery: queryGeneric({
        args: { url: v.string() },
        handler: (_ctx, { url }) => outcomeOf(captured(url)),
      }),
      importedFetchInQuery: queryGeneric({
        args: { url: v.string() },
        handler: (_ctx, { url }) => outcomeOf(keptFetch(url)),
      }),
      reassignedFetchInQuery: queryGeneric({
        args: { url: v.string() },
        handler: async (_ctx, { url }) => {
          const before = globalThis.fetch;
          globalThis.fetch = (() =>
            Promise.resolve(
              new Response("reassigned"),
            )) as unknown as typeof fetch;
          try {
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
        handler: async (ctx, { name }) => {
          await ctx.db.insert("notes", { text: "before" });
          startTimer(name);
          await ctx.db.insert("notes", { text: "after" });
          return "returned";
        },
      }),
      awaitedTimerInQuery: queryGeneric({
        args: timerArgs,
        handler: async (_ctx, { name }) => {
          await awaitTimer(name);
          return "returned";
        },
      }),
      awaitedTimerInMutation: mutationGeneric({
        args: timerArgs,
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
      nodeSurface,
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
            .then((rows) => rows.map((row) => row.text)),
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
          fetch(url).then(
            (response) => response.text(),
            () => "caught",
          ),
      }),
      fetchThenWrite: actionGeneric({
        args: { url: v.string() },
        handler: (ctx, { url }) =>
          fetch(url)
            .catch(() => null)
            .then(() => ctx.runMutation(io.addNote, { text: "after" })),
      }),
      addNote: mutationGeneric({
        args: { text: v.string() },
        handler: (ctx, { text }) =>
          ctx.db.insert("notes", { text }).then(() => null),
      }),
      timersInAction: actionGeneric({
        args: {},
        handler: async () => {
          const slept = await new Promise<string>((resolve) =>
            setTimeout(() => resolve("slept"), 1),
          );
          const ticked = await new Promise<string>((resolve) => {
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
};

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
          const t = convexTest(schema, modules);
          const call =
            name === "fetchInQuery"
              ? t.query(io[name], { url })
              : t.mutation(io[name], { url });
          expect(yield* Effect.promise(() => call)).toEqual(fetchRefusal);
        }),
    );

    it.effect(
      "a reference a module kept when the backend loaded it is refused in a query",
      () =>
        Effect.gen(function* () {
          const t = convexTest(schema, modules);
          expect(
            yield* Effect.promise(() =>
              t.query(io.capturedFetchInQuery, { url }),
            ),
          ).toEqual(fetchRefusal);
        }),
    );

    it.effect(
      "a reference a module kept when it was imported, before any backend existed, is refused in a query",
      () =>
        Effect.gen(function* () {
          const t = convexTest(schema, modules);
          expect(
            yield* Effect.promise(() =>
              t.query(io.importedFetchInQuery, { url }),
            ),
          ).toEqual(fetchRefusal);
        }),
    );

    it.effect(
      "a handler that reassigns globalThis.fetch mid-invocation is still refused, and the host's fetch comes back",
      () =>
        Effect.gen(function* () {
          const t = convexTest(schema, modules);
          const host = Reflect.get(globalThis, "fetch");
          expect(
            yield* Effect.promise(() =>
              t.query(io.reassignedFetchInQuery, { url }),
            ),
          ).toEqual(fetchRefusal);
          expect(Reflect.get(globalThis, "fetch")).toBe(host);
          const server = yield* loopback;
          expect(
            yield* Effect.promise(() =>
              fetch(server.url).then((response) => response.text()),
            ),
          ).toBe("reached /ping");
        }).pipe(Effect.scoped),
    );

    it.effect(
      "a fetch a test stubbed after the backend opened is refused in a query",
      () =>
        Effect.gen(function* () {
          const t = convexTest(schema, modules);
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
        const t = convexTest(schema, modules);
        expect(
          yield* Effect.promise(() => t.action(io.fetchThroughQuery, { url })),
        ).toEqual(fetchRefusal);
        expect(
          yield* Effect.promise(() =>
            t.action(io.fetchThroughMutation, { url }),
          ),
        ).toEqual(fetchRefusal);
        expect(
          yield* Effect.promise(() =>
            t.mutation(io.fetchThroughNestedMutation, { url }),
          ),
        ).toEqual(fetchRefusal);
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
          const t = convexTest(schema, modules);
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
        const server = yield* loopback;
        const t = convexTest(schema, modules);
        expect(
          yield* refusalOf(t.action(io.fetchThenWrite, { url: server.url })),
        ).toMatchObject({ reason: "UndeclaredFetch" });
        expect(yield* Effect.promise(() => t.query(io.notes, {}))).toEqual([]);
      }).pipe(Effect.scoped),
    );

    it.effect("a component's action is named with its component path", () =>
      Effect.gen(function* () {
        const server = yield* loopback;
        const t = convexTest(schema, modules);
        t.registerComponent("store", schema, {
          "_generated/server.ts": () => Promise.resolve({}),
          "egress.ts": () =>
            Promise.resolve({
              fetchInAction: actionGeneric({
                args: { url: v.string() },
                handler: (_ctx, args) => fetch(args.url).then(() => null),
              }),
            }),
        });
        const store = (componentsGeneric() as any).store;
        expect(
          yield* refusalOf(
            t.action(store.egress.fetchInAction, { url: server.url }),
          ),
        ).toMatchObject({
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
          const t = convexTest(schema, modules);
          expect(yield* failureOf(t.query(io.timerInQuery, { name }))).toEqual({
            failed: timerRefusal(name),
          });
        }),
    );

    it.effect.each(["setTimeout", "setInterval"] as const)(
      "a mutation that starts %s fails and publishes none of its writes",
      (name) =>
        Effect.gen(function* () {
          const t = convexTest(schema, modules);
          expect(
            yield* failureOf(t.mutation(io.timerInMutation, { name })),
          ).toEqual({
            failed: timerRefusal(name),
          });
          expect(yield* Effect.promise(() => t.query(io.notes, {}))).toEqual(
            [],
          );
        }),
    );

    it.effect.each(["setTimeout", "setInterval"] as const)(
      "a query that awaits %s fails with the binary's error without waiting for its handler",
      (name) =>
        Effect.gen(function* () {
          const t = convexTest(schema, modules);
          expect(
            yield* failureOf(t.query(io.awaitedTimerInQuery, { name })),
          ).toEqual({ failed: timerRefusal(name) });
        }),
    );

    it.effect.each(["setTimeout", "setInterval"] as const)(
      "a mutation that awaits %s fails without waiting for its handler and publishes none of its writes",
      (name) =>
        Effect.gen(function* () {
          const t = convexTest(schema, modules);
          expect(
            yield* failureOf(t.mutation(io.awaitedTimerInMutation, { name })),
          ).toEqual({ failed: timerRefusal(name) });
          expect(yield* Effect.promise(() => t.query(io.notes, {}))).toEqual(
            [],
          );
        }),
    );

    it.effect(
      "a query an action calls fails, and the action sees its error",
      () =>
        Effect.gen(function* () {
          const t = convexTest(schema, modules);
          expect(
            yield* Effect.promise(() =>
              t.action(io.timerThroughQuery, { name: "setTimeout" }),
            ),
          ).toBe(timerRefusal("setTimeout"));
        }),
    );

    it.effect("a query may clear a timer, as the binary allows", () =>
      Effect.gen(function* () {
        const t = convexTest(schema, modules);
        expect(yield* Effect.promise(() => t.query(io.clearInQuery, {}))).toBe(
          "cleared",
        );
      }),
    );

    it.effect("an action runs host timers", () =>
      Effect.gen(function* () {
        const t = convexTest(schema, modules);
        expect(
          yield* Effect.promise(() => t.action(io.timersInAction, {})),
        ).toEqual(["slept", "ticked"]);
      }),
    );

    it.effect(
      "fake timers install and uninstall through the guards, and a query is still refused while they are on",
      () =>
        Effect.gen(function* () {
          const t = convexTest(schema, modules);
          for (const round of [1, 2]) {
            vi.useFakeTimers();
            let fired = false;
            setTimeout(() => {
              fired = true;
            }, 1000);
            vi.advanceTimersByTime(1000);
            expect(fired, `round ${round}`).toBe(true);
            expect(
              yield* failureOf(
                t.query(io.timerInQuery, { name: "setTimeout" }),
              ),
            ).toEqual({ failed: timerRefusal("setTimeout") });
            vi.useRealTimers();
          }
          expect(
            yield* Effect.promise(
              () =>
                new Promise<string>((resolve) =>
                  setTimeout(() => resolve("real"), 1),
                ),
            ),
          ).toBe("real");
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
              new Promise<string>((resolve) => {
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
          const t = convexTest(schema, modules);
          expect(
            yield* Effect.promise(() => t.query(io.surfaceInQuery, {})),
          ).toEqual(absent);
          expect(
            yield* Effect.promise(() => t.mutation(io.surfaceInMutation, {})),
          ).toEqual(absent);
          expect(
            yield* Effect.promise(() => t.action(io.surfaceInAction, {})),
          ).toEqual(absent);
          expect(
            yield* Effect.promise(() => t.action(io.confectSurface, {})),
          ).toEqual(absent);
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
          const t = convexTest(schema, modules);
          expect(
            yield* Effect.promise(() => t.action(io.nodeSurface, {})),
          ).toEqual({ setImmediate: "function", queueMicrotask: "function" });
        }),
    );

    it.effect(
      "a setImmediate a module kept when it was imported fails in a query as the missing global does",
      () =>
        Effect.gen(function* () {
          const t = convexTest(schema, modules);
          expect(
            yield* Effect.promise(() =>
              t.query(io.importedImmediateInQuery, {}),
            ),
          ).toEqual({
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
          const t = convexTest(schema, modules);
          expect(
            yield* Effect.promise(() =>
              t.query(io.formDataInQuery, { body: "multipart" }),
            ),
          ).toEqual(refusal);
          expect(
            yield* Effect.promise(() =>
              t.mutation(io.formDataInMutation, { body: "multipart" }),
            ),
          ).toEqual(refusal);
        }),
    );

    it.effect(
      "a query parses a urlencoded body and refuses multipart without a boundary as the binary does",
      () =>
        Effect.gen(function* () {
          const t = convexTest(schema, modules);
          expect(
            yield* Effect.promise(() =>
              t.query(io.formDataInQuery, { body: "urlencoded" }),
            ),
          ).toEqual({ returned: "ada" });
          expect(
            yield* Effect.promise(() =>
              t.query(io.formDataInQuery, {
                body: "multipartWithoutBoundary",
              }),
            ),
          ).toEqual({
            name: "TypeError",
            message:
              "Missing boundary parameter in mime type of multipart formdata.",
          });
        }),
    );

    it.effect("an action parses a multipart body", () =>
      Effect.gen(function* () {
        const t = convexTest(schema, modules);
        expect(
          yield* Effect.promise(() =>
            t.action(io.formDataInAction, { body: "multipart" }),
          ),
        ).toEqual({ returned: "ada" });
      }),
    );
  });
});
