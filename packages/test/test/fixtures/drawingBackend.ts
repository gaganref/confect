// Plain Convex functions on the test kernel that draw from every random
// source: a query, a mutation, an action, a component's query the host calls,
// and an action that imports a drawing module lazily. `handlerDrawReplay.ts`
// runs each under its own bound stream.
import {
  actionGeneric,
  componentsGeneric,
  defineSchema,
  type FunctionReference,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import * as Context from "effect/Context";
import { convexTest, type KernelControls } from "../../src/internal/ConvexTest";
import * as Entropy from "../../src/internal/Entropy";
import type * as Invocation from "../../src/internal/Invocation";

export interface Drawn {
  readonly random: number;
  readonly bytes: ReadonlyArray<number>;
  readonly uuid: string;
}

/**
 * One draw from each source: `Math.random`, a 2-byte fill and `randomUUID`.
 */
const drawAll = (): Drawn => ({
  // oxlint-disable-next-line effecttsgo/global-random -- A plain Convex function reads the ambient Math.random the kernel gives it.
  random: Math.random(),
  bytes: Array.from(crypto.getRandomValues(new Uint8Array(2))),
  // oxlint-disable-next-line effecttsgo/crypto-random-uuid -- A plain Convex function reads the ambient crypto.randomUUID the kernel gives it.
  uuid: crypto.randomUUID(),
});

/**
 * What `drawAll` answers when it draws from `random`, as the binary's
 * `getRandomValues` and `randomUUID` fill from a stream.
 */
export const drawnFrom = (random: () => number): Drawn => ({
  random: random(),
  bytes: [Math.floor(random() * 256), Math.floor(random() * 256)],
  uuid: Entropy.uuid(random),
});

const drawer = (componentsGeneric() as any).drawer as {
  readonly draws: {
    readonly query: FunctionReference<"query", "internal", {}, Drawn>;
  };
};

export const calls = {
  query: ["query", makeFunctionReference<"query", {}, Drawn>("draws:query")],
  mutation: [
    "mutation",
    makeFunctionReference<"mutation", {}, Drawn>("draws:mutation"),
  ],
  action: [
    "action",
    makeFunctionReference<"action", {}, Drawn>("draws:action"),
  ],
  component: [
    "query",
    makeFunctionReference<"query", {}, Drawn>("draws:component"),
  ],
  lazy: ["action", makeFunctionReference<"action", {}, Drawn>("draws:lazy")],
} as const;

/**
 * The backend, with `world` as its own when given, which an unbound call draws
 * from.
 */
export const drawingBackend = (world?: Invocation.World): KernelControls => {
  const t = convexTest({
    ...(world === undefined ? {} : { world }),
    schema: defineSchema({}),
    modules: {
      "_generated/server.ts": () => Promise.resolve({}),
      "draws.ts": () =>
        Promise.resolve({
          query: queryGeneric({
            args: {},
            handler: () => Promise.resolve(drawAll()),
          }),
          mutation: mutationGeneric({
            args: {},
            handler: () => Promise.resolve(drawAll()),
          }),
          action: actionGeneric({
            args: {},
            handler: () => Promise.resolve(drawAll()),
          }),
          component: queryGeneric({
            args: {},
            handler: (ctx): Promise<Drawn> =>
              ctx.runQuery(drawer.draws.query, {}),
          }),
          lazy: actionGeneric({
            args: {},
            handler: (): Promise<Drawn> =>
              import("./lazyDraws").then(({ drawn }) => drawn),
          }),
        }),
    },
  });
  t.registerComponent("drawer", defineSchema({}), {
    "_generated/server.ts": () => Promise.resolve({}),
    "draws.ts": () =>
      Promise.resolve({
        query: queryGeneric({
          args: {},
          handler: () => Promise.resolve(drawAll()),
        }),
      }),
  });
  return t;
};

/**
 * A linear congruential stream, so every process draws the same values.
 */
export const streamFor = (index: number) => {
  let state = 20_261_114 + index;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
};

/**
 * An invocation of a world whose stream, and its own, is `random`.
 */
export const invocationOf = (random: () => number): Invocation.Invocation => ({
  world: {
    name: "draws",
    services: Context.empty(),
    clock: () => 1_000,
    random,
  },
  componentPath: "",
  attempt: 1,
  request: {
    ip: null,
    userAgent: null,
    requestId: "0000000000000000",
    scheduledFunctionId: null,
  },
  services: Context.empty(),
  startedAt: 1_000,
  random,
});
