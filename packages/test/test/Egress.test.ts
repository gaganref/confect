import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import {
  actionGeneric,
  defineSchema,
  makeFunctionReference,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";
import * as Effect from "effect/Effect";
import { convexTest } from "../src/internal/ConvexTest";
import * as Egress from "../src/internal/Egress";
import { inlineSources } from "./fixtures/inlineSources";
import { loopback } from "./fixtures/loopback";

const live = vi.fn((input: { readonly url: string }) =>
  // oxlint-disable-next-line effecttsgo/global-fetch -- The port's live provider makes the raw fetch the port replaces.
  fetch(input.url).then((response) => response.text()),
);

// A port whose live provider makes the raw fetch.
const charges = Egress.port("charges", live);

const egress = {
  charge: makeFunctionReference<"action", { url: string }, string>(
    "egress:charge",
  ),
  chargeInQuery: makeFunctionReference<"query", { url: string }>(
    "egress:chargeInQuery",
  ),
  chargeAfterRefusal: makeFunctionReference<"action", { url: string }>(
    "egress:chargeAfterRefusal",
  ),
  chargeThenFetch: makeFunctionReference<"action", { url: string }>(
    "egress:chargeThenFetch",
  ),
  hangAfterRefusal: makeFunctionReference<"action", { url: string }>(
    "egress:hangAfterRefusal",
  ),
  logAroundRefusal: makeFunctionReference<"action", { url: string }>(
    "egress:logAroundRefusal",
  ),
  chargeAndReturn: makeFunctionReference<"action", { url: string }>(
    "egress:chargeAndReturn",
  ),
  logAfterReturn: makeFunctionReference<"action">("egress:logAfterReturn"),
  logAfterReturnInQuery: makeFunctionReference<"query">(
    "egress:logAfterReturnInQuery",
  ),
};

// Released by a test after a function returned, so the function's own
// continuation runs then.
let afterReturn: Promise<void> = Promise.resolve();
// The continuations that ran, so a test waits for them.
const continued: Array<Promise<void>> = [];

const logLater = (label: string) => {
  continued.push(
    afterReturn.then(() => {
      // oxlint-disable-next-line effecttsgo/global-console -- The handler logs through the runtime's console, as an action's code does.
      console.log(`${label} after it returned`);
      return undefined;
    }),
  );
  // oxlint-disable-next-line effecttsgo/global-console -- The handler logs through the runtime's console, as an action's code does.
  console.log(`${label} before it returned`);
  return label;
};

// Set by a test before it starts `chargeThenFetch`, so the test can read the
// held command before the action makes its raw fetch.
let gate: Promise<void> = Promise.resolve();

// Port calls an action made after it ended, and how each settled.
const late: Array<Promise<unknown>> = [];

const schema = defineSchema({});

const modules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "egress.ts": () =>
    Promise.resolve({
      charge: actionGeneric({
        args: { url: v.string() },
        handler: (_ctx, { url }) => charges.call({ url }),
      }),
      chargeAfterRefusal: actionGeneric({
        args: { url: v.string() },
        // oxlint-disable-next-line effecttsgo/async-function -- A plain Convex handler is async, as product code is.
        handler: async (_ctx, { url }) => {
          // oxlint-disable-next-line effecttsgo/global-fetch -- The action makes the raw fetch the test kernel refuses and the binary performs.
          await fetch(url).catch(() => null);
          const call = charges.call({ url });
          late.push(
            call.then(
              (value) => ({ returned: value }),
              (error: { readonly _tag?: string }) => ({ failed: error._tag }),
            ),
          );
          return call;
        },
      }),
      chargeThenFetch: actionGeneric({
        args: { url: v.string() },
        // oxlint-disable-next-line effecttsgo/async-function -- A plain Convex handler is async, as product code is.
        handler: async (_ctx, { url }) => {
          // Held, never awaited.
          void charges.call({ url });
          await gate;
          // oxlint-disable-next-line effecttsgo/global-fetch -- The action makes the raw fetch the test kernel refuses and the binary performs.
          return fetch(url).then((response) => response.text());
        },
      }),
      hangAfterRefusal: actionGeneric({
        args: { url: v.string() },
        // oxlint-disable-next-line effecttsgo/async-function -- A plain Convex handler is async, as product code is.
        handler: async (_ctx, { url }) => {
          // oxlint-disable-next-line effecttsgo/global-fetch -- The action makes the raw fetch the test kernel refuses and the binary performs.
          await fetch(url).catch(() => null);
          // The handler never settles, and the action ends anyway.
          // oxlint-disable-next-line effecttsgo/new-promise -- A promise that never settles, as the case's handler never does.
          return new Promise<never>(() => {});
        },
      }),
      logAroundRefusal: actionGeneric({
        args: { url: v.string() },
        // oxlint-disable-next-line effecttsgo/async-function -- A plain Convex handler is async, as product code is.
        handler: async (_ctx, { url }) => {
          // oxlint-disable-next-line effecttsgo/global-console -- The handler logs through the runtime's console, as an action's code does.
          console.log("before the refusal");
          // oxlint-disable-next-line effecttsgo/global-fetch -- The action makes the raw fetch the test kernel refuses and the binary performs.
          await fetch(url).catch(() => null);
          // oxlint-disable-next-line effecttsgo/global-console -- The handler logs through the runtime's console, as an action's code does.
          console.log("after the refusal");
          return null;
        },
      }),
      chargeAndReturn: actionGeneric({
        args: { url: v.string() },
        handler: (_ctx, { url }) => {
          void charges.call({ url });
          return Promise.resolve("returned");
        },
      }),
      logAfterReturn: actionGeneric({
        args: {},
        handler: () => Promise.resolve(logLater("action")),
      }),
      logAfterReturnInQuery: queryGeneric({
        args: {},
        handler: () => logLater("query"),
      }),
      chargeInQuery: queryGeneric({
        args: { url: v.string() },
        handler: (_ctx, { url }) =>
          charges.call({ url }).then(
            () => "charged",
            (error: Error) => ({ name: error.name, message: error.message }),
          ),
      }),
    }),
};

// Each inline module's source: none has a "use node" directive.
const sources = inlineSources(modules);

describe("provider ports", () => {
  it.effect(
    "a port call in an action is held as a command until the test answers it",
    () =>
      Effect.gen(function* () {
        live.mockClear();
        const server = yield* loopback;
        const t = convexTest({ schema, modules, sources });
        const charged = t.action(egress.charge, { url: server.url });
        const commands = yield* Effect.promise(() =>
          vi.waitFor(() => {
            const held = t.commands();
            expect(held).toHaveLength(1);
            return held;
          }),
        );
        expect(commands[0]).toMatchObject({
          kind: "provider",
          port: "charges",
          input: { url: server.url },
          componentPath: "",
          functionName: "egress:charge",
        });
        t.answer(commands[0]!.id, "answered");
        const observed = yield* Effect.promise(() => charged);
        expect(observed).toBe("answered");
        expect(t.commands()).toEqual([]);
        expect(live).not.toHaveBeenCalled();
        expect(server.hits()).toBe(0);
      }).pipe(Effect.scoped),
  );

  it.effect("a command answered twice is refused with StaleCommand", () =>
    Effect.gen(function* () {
      live.mockClear();
      const t = convexTest({ schema, modules, sources });
      const charged = t.action(egress.charge, { url: "https://example.com/" });
      const [command] = yield* Effect.promise(() =>
        vi.waitFor(() => {
          const held = t.commands();
          expect(held).toHaveLength(1);
          return held;
        }),
      );
      t.answer(command!.id, "answered");
      yield* Effect.promise(() => charged);
      expect(() => t.answer(command!.id, "again")).toThrow(
        expect.objectContaining({
          _tag: "StaleCommand",
          id: command!.id,
          reason: "notHeld",
        }),
      );
    }),
  );

  it.effect(
    "a port call in a query reaches its live provider, whose fetch the query refuses as the binary does",
    () =>
      Effect.gen(function* () {
        live.mockClear();
        const t = convexTest({ schema, modules, sources });
        const observed = yield* Effect.promise(() =>
          t.query(egress.chargeInQuery, {
            url: "https://api.example.com/v1/charges",
          }),
        );
        expect(observed).toEqual({
          name: "TypeError",
          message:
            "fetch to https://api.example.com/v1/charges failed: Can't use fetch() in queries and mutations. Please consider using an action. See https://docs.convex.dev/functions/actions for more details.",
        });
        expect(live).toHaveBeenCalledOnce();
        expect(t.commands()).toEqual([]);
      }),
  );

  it.effect("outside a kernel function a port calls its live provider", () =>
    Effect.gen(function* () {
      live.mockClear();
      const server = yield* loopback;
      convexTest({ schema, modules, sources });
      const observed = yield* Effect.promise(() =>
        charges.call({ url: server.url }),
      );
      expect(observed).toBe("reached /ping");
      expect(server.hits()).toBe(1);
    }).pipe(Effect.scoped),
  );

  describe("an action that ended", () => {
    const refusalOf = (call: Promise<unknown>) =>
      Effect.promise(() =>
        call.then(
          (value) => ({ returned: value }),
          (error: { readonly _tag?: string; readonly reason?: string }) => ({
            failed: error._tag,
            reason: error.reason,
          }),
        ),
      );

    const undeclared = { failed: "BackendRefusal", reason: "UndeclaredFetch" };

    it.effect(
      "a port call it makes after catching UndeclaredFetch is refused and holds nothing",
      () =>
        Effect.gen(function* () {
          live.mockClear();
          late.length = 0;
          const server = yield* loopback;
          const t = convexTest({ schema, modules, sources });
          const observed = yield* refusalOf(
            t.action(egress.chargeAfterRefusal, { url: server.url }),
          );
          expect(observed).toEqual(undeclared);
          expect(t.commands()).toEqual([]);
          const observed2 = yield* Effect.promise(() => Promise.all(late));
          expect(observed2).toEqual([{ failed: "BackendRefusal" }]);
          expect(live).not.toHaveBeenCalled();
        }).pipe(Effect.scoped),
    );

    it.effect(
      "a command it held before the refusal is cancelled, and answering it is refused",
      () =>
        Effect.gen(function* () {
          live.mockClear();
          const server = yield* loopback;
          const t = convexTest({ schema, modules, sources });
          const { promise: opened, resolve: open } =
            Promise.withResolvers<void>();
          gate = opened;
          const died = t.action(egress.chargeThenFetch, { url: server.url });
          const [command] = yield* Effect.promise(() =>
            vi.waitFor(() => {
              const held = t.commands();
              expect(held).toHaveLength(1);
              return held;
            }),
          );
          open();
          const observed = yield* refusalOf(died);
          expect(observed).toEqual(undeclared);
          expect(t.commands()).toEqual([]);
          expect(() => t.answer(command!.id, "late")).toThrow(
            expect.objectContaining({
              _tag: "StaleCommand",
              id: command!.id,
              reason: "cancelled",
            }),
          );
        }).pipe(Effect.scoped),
    );

    it.effect("it settles with its refusal while its handler never does", () =>
      Effect.gen(function* () {
        const server = yield* loopback;
        const t = convexTest({ schema, modules, sources });
        const observed = yield* refusalOf(
          t.action(egress.hangAfterRefusal, { url: server.url }),
        );
        expect(observed).toEqual(undeclared);
      }).pipe(Effect.scoped),
    );

    it.effect("it logs nothing after its refusal", () =>
      Effect.gen(function* () {
        const server = yield* loopback;
        const t = convexTest({ schema, modules, sources });
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const outcome = yield* refusalOf(
          t.action(egress.logAroundRefusal, { url: server.url }),
        );
        // Restoring a spy clears its calls, so they are read first.
        const logged = [...log.mock.calls];
        log.mockRestore();
        expect(outcome).toEqual(undeclared);
        expect(logged).toEqual([["before the refusal"]]);
      }).pipe(Effect.scoped),
    );

    it.effect(
      "a command an action left held when it returned is cancelled",
      () =>
        Effect.gen(function* () {
          const t = convexTest({ schema, modules, sources });
          const observed = yield* Effect.promise(() =>
            t.action(egress.chargeAndReturn, { url: "https://example.com/" }),
          );
          expect(observed).toBe("returned");
          expect(t.commands()).toEqual([]);
        }),
    );
  });

  describe("a function that settled", () => {
    it.effect.each([
      { article: "an", kind: "action" },
      { article: "a", kind: "query" },
    ] as const)(
      "$article $kind logs nothing from a continuation released after it returned",
      ({ kind }) =>
        Effect.gen(function* () {
          const t = convexTest({ schema, modules, sources });
          const { promise, resolve } = Promise.withResolvers<void>();
          afterReturn = promise;
          continued.length = 0;
          const log = vi.spyOn(console, "log").mockImplementation(() => {});
          const returned = yield* Effect.promise(() =>
            kind === "action"
              ? t.action(egress.logAfterReturn, {})
              : t.query(egress.logAfterReturnInQuery, {}),
          );
          resolve();
          yield* Effect.promise(() => Promise.all(continued));
          // Restoring a spy clears its calls, so they are read first.
          const logged = [...log.mock.calls];
          log.mockRestore();
          expect(returned).toBe(kind);
          expect(logged).toEqual([[`${kind} before it returned`]]);
        }),
    );

    it.effect(
      "a console a test assigns keeps its own methods, and an ended action's later call to it is dropped",
      () =>
        Effect.gen(function* () {
          const t = convexTest({ schema, modules, sources });
          const original = globalThis.console;
          const log = vi.fn();
          const assigned = { ...original, log };
          globalThis.console = assigned;
          yield* Effect.promise(() =>
            t
              .action(egress.logAroundRefusal, { url: "https://example.com/" })
              .catch(() => null),
          ).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                globalThis.console = original;
              }),
            ),
          );
          expect(assigned.log).toBe(log);
          expect(log.mock.calls).toEqual([["before the refusal"]]);
        }),
    );
  });
});
