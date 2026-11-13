// oxlint-disable effecttsgo/global-fetch, effecttsgo/global-console, effecttsgo/new-promise, effecttsgo/async-function -- The ports' live providers make the raw fetch a port replaces, and the handlers log and wait as an action's code does.
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
import { loopback } from "./fixtures/loopback";

const live = vi.fn((input: { readonly url: string }) =>
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
        handler: async (_ctx, { url }) => {
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
        handler: async (_ctx, { url }) => {
          // Held, never awaited.
          void charges.call({ url });
          await gate;
          return fetch(url).then((response) => response.text());
        },
      }),
      hangAfterRefusal: actionGeneric({
        args: { url: v.string() },
        handler: async (_ctx, { url }) => {
          await fetch(url).catch(() => null);
          // The handler never settles, and the action ends anyway.
          return new Promise<never>(() => {});
        },
      }),
      logAroundRefusal: actionGeneric({
        args: { url: v.string() },
        handler: async (_ctx, { url }) => {
          console.log("before the refusal");
          await fetch(url).catch(() => null);
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

describe("provider ports", () => {
  it.effect(
    "a port call in an action is held as a command until the test answers it",
    () =>
      Effect.gen(function* () {
        live.mockClear();
        const server = yield* loopback;
        const t = convexTest(schema, modules);
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
        expect(yield* Effect.promise(() => charged)).toBe("answered");
        expect(t.commands()).toEqual([]);
        expect(live).not.toHaveBeenCalled();
        expect(server.hits()).toBe(0);
      }).pipe(Effect.scoped),
  );

  it.effect("a command answered twice is refused with StaleCommand", () =>
    Effect.gen(function* () {
      live.mockClear();
      const t = convexTest(schema, modules);
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
        const t = convexTest(schema, modules);
        expect(
          yield* Effect.promise(() =>
            t.query(egress.chargeInQuery, {
              url: "https://api.example.com/v1/charges",
            }),
          ),
        ).toEqual({
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
      convexTest(schema, modules);
      expect(
        yield* Effect.promise(() => charges.call({ url: server.url })),
      ).toBe("reached /ping");
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
          const t = convexTest(schema, modules);
          expect(
            yield* refusalOf(
              t.action(egress.chargeAfterRefusal, { url: server.url }),
            ),
          ).toEqual(undeclared);
          expect(t.commands()).toEqual([]);
          expect(yield* Effect.promise(() => Promise.all(late))).toEqual([
            { failed: "BackendRefusal" },
          ]);
          expect(live).not.toHaveBeenCalled();
        }).pipe(Effect.scoped),
    );

    it.effect(
      "a command it held before the refusal is cancelled, and answering it is refused",
      () =>
        Effect.gen(function* () {
          live.mockClear();
          const server = yield* loopback;
          const t = convexTest(schema, modules);
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
          expect(yield* refusalOf(died)).toEqual(undeclared);
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
        const t = convexTest(schema, modules);
        expect(
          yield* refusalOf(
            t.action(egress.hangAfterRefusal, { url: server.url }),
          ),
        ).toEqual(undeclared);
      }).pipe(Effect.scoped),
    );

    it.effect("it logs nothing after its refusal", () =>
      Effect.gen(function* () {
        const server = yield* loopback;
        const t = convexTest(schema, modules);
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
          const t = convexTest(schema, modules);
          expect(
            yield* Effect.promise(() =>
              t.action(egress.chargeAndReturn, { url: "https://example.com/" }),
            ),
          ).toBe("returned");
          expect(t.commands()).toEqual([]);
        }),
    );
  });
});
