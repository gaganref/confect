// oxlint-disable effecttsgo/global-fetch -- The ports' live providers make the raw fetch a port replaces.
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
};

const schema = defineSchema({});

const modules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "egress.ts": () =>
    Promise.resolve({
      charge: actionGeneric({
        args: { url: v.string() },
        handler: (_ctx, { url }) => charges.call({ url }),
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
        expect.objectContaining({ _tag: "StaleCommand", id: command!.id }),
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
});
