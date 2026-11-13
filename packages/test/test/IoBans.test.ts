// oxlint-disable effecttsgo/global-fetch, effecttsgo/global-timers, effecttsgo/new-promise, effecttsgo/async-function -- These handlers call the runtime's own fetch and timers, which is what the I/O bans and the egress rule refuse or allow.
import { describe, expect, it } from "@effect/vitest";
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
import { convexTest } from "../src/internal/ConvexTest";
import type * as KernelRefusal from "../src/internal/KernelRefusal";
import { loopback } from "./fixtures/loopback";

type Timer = "setTimeout" | "setInterval";

const timerArgs = {
  name: v.union(v.literal("setTimeout"), v.literal("setInterval")),
};

const startTimer = (name: Timer) =>
  (
    globalThis as unknown as Record<
      Timer,
      (f: () => void, ms: number) => unknown
    >
  )[name](() => {}, 0);

// What a rejected fetch tells its handler, so a test compares it whole.
const outcomeOf = (fetched: Promise<unknown>) =>
  fetched.then(
    () => "fetched",
    (error: Error) => ({ name: error.name, message: error.message }),
  );

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
  timerInQuery: makeFunctionReference<"query", { name: Timer }>(
    "io:timerInQuery",
  ),
  timerInMutation: makeFunctionReference<"mutation", { name: Timer }>(
    "io:timerInMutation",
  ),
  immediateInQuery: makeFunctionReference<"query">("io:immediateInQuery"),
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
  fetchThenWrite: makeFunctionReference<"action", { url: string }>(
    "io:fetchThenWrite",
  ),
  addNote: makeFunctionReference<"mutation", { text: string }>("io:addNote"),
  timersInAction: makeFunctionReference<"action">("io:timersInAction"),
};

const schema = defineSchema({ notes: defineTable({ text: v.string() }) });

const modules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "io.ts": () => {
    // A module that keeps the global when it loads, as an HTTP client does.
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
      immediateInQuery: queryGeneric({
        args: {},
        handler: () => typeof setImmediate,
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
          const immediate = await new Promise<string>((resolve) =>
            setImmediate(() => resolve("immediate")),
          );
          return [slept, ticked, immediate];
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
      "a reference a module kept when it loaded is refused in a query",
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

    it.effect(
      "a query reads setImmediate as undefined, as the binary defines none",
      () =>
        Effect.gen(function* () {
          const t = convexTest(schema, modules);
          expect(
            yield* Effect.promise(() => t.query(io.immediateInQuery, {})),
          ).toBe("undefined");
          expect(typeof setImmediate).toBe("function");
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

    it.effect("an action runs every host timer", () =>
      Effect.gen(function* () {
        const t = convexTest(schema, modules);
        expect(
          yield* Effect.promise(() => t.action(io.timersInAction, {})),
        ).toEqual(["slept", "ticked", "immediate"]);
      }),
    );
  });
});
