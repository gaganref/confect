// oxlint-disable-next-line effecttsgo/node-builtin-import -- The replay test compares the exact stdout of fresh Node processes.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import {
  defineSchema,
  makeFunctionReference,
  queryGeneric,
} from "convex/server";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import refs from "../../../tools/local-backend/fixtures/confect/_generated/refs";
import { convexTest, type KernelControls } from "../src/internal/ConvexTest";
import * as Invocation from "../src/internal/Invocation";
import { call, localBackendWorld } from "./fixtures/localBackendWorld";
import { expected, normalize } from "./fixtures/randomnessProbe";

const probe = refs.public.groups.randomness;

/**
 * A random stream that cycles through `draws`.
 */
const cycling = (draws: ReadonlyArray<number>) => {
  let next = 0;
  return () => draws[next++ % draws.length]!;
};

const draws = [0.125, 0.25, 0.5, 0.75, 0.875];

/**
 * A test world whose random stream starts at the first of `draws`.
 */
const worldOf = (name: string): Invocation.World => ({
  name,
  services: Context.empty(),
  clock: () => 1_000,
  random: cycling(draws),
});

/**
 * Run `kind`'s probe under a test invocation whose random stream, and whose
 * world's, each start at the first of `draws`. The backend opens under the
 * invocation, so a module that loads then draws from the world's stream.
 */
const sample = (kind: "query" | "mutation" | "action") =>
  Effect.gen(function* () {
    const context = yield* Effect.context<never>();
    const t = localBackendWorld();
    const invocation: Invocation.Invocation = {
      world: worldOf("randomness"),
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
      random: cycling(draws),
    };
    return yield* Effect.promise(() =>
      Invocation.bind(invocation, () =>
        Effect.runPromiseWith(context)(call(t, kind, probe[kind])),
      ),
    );
  });

const read = makeFunctionReference<"query", Record<string, never>, unknown>(
  "draws:read",
);

/**
 * A backend whose one module runs `draw` while it loads, and whose `read` query
 * answers what it drew.
 */
const drawingAtLoad = (
  draw: () => unknown,
  world?: Invocation.World,
): KernelControls =>
  convexTest({
    schema: defineSchema({}),
    modules: {
      "_generated/server.ts": () => Promise.resolve({}),
      "draws.ts": () => {
        const drawn = draw();
        return Promise.resolve({
          read: queryGeneric({
            args: {},
            handler: () => Promise.resolve(drawn),
          }),
        });
      },
    },
    ...(world === undefined ? {} : { world }),
  });

const settle = (thunk: () => Promise<unknown>) =>
  Effect.promise(() =>
    thunk().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    ),
  );

describe("randomness on the kernel", () => {
  it.effect(
    "a query, a mutation and an action may each draw from Math.random and crypto, and refuse the fills the binary refuses",
    () =>
      Effect.gen(function* () {
        const query = yield* sample("query");
        const mutation = yield* sample("mutation");
        const action = yield* sample("action");
        expect({
          query: normalize(query),
          mutation: normalize(mutation),
          action: normalize(action),
        }).toEqual(expected);
      }),
  );

  it.effect(
    "Math.random and crypto.getRandomValues draw from the supplied stream in a query, a mutation and an action",
    () =>
      Effect.gen(function* () {
        for (const kind of ["query", "mutation", "action"] as const) {
          const { mathRandom, getRandomValues } = yield* sample(kind);
          expect([mathRandom.value, getRandomValues.value], kind).toEqual([
            [0.125],
            [64, 128, 192, 224],
          ]);
        }
      }),
  );

  it.effect(
    "a module that draws while it loads draws from the stream of the world the backend opens in",
    () =>
      Effect.gen(function* () {
        // The host runtime evaluates the fixture module once, at the first
        // open in this file. Every sample opens under a world whose stream
        // starts at the first of `draws`, so every sample reads that load.
        for (const kind of ["query", "mutation", "action"] as const) {
          const { loadMathRandom, loadGetRandomValues } = yield* sample(kind);
          expect(
            [loadMathRandom.value, loadGetRandomValues.value],
            kind,
          ).toEqual([[0.125], [64, 128, 192, 224]]);
        }
        const given = yield* settle(() =>
          // oxlint-disable-next-line effecttsgo/global-random -- The module under test draws from the ambient Math.random while it loads.
          drawingAtLoad(() => Math.random(), worldOf("given")).query(read, {}),
        );
        expect(given).toEqual({ value: 0.125 });
      }),
  );

  it.effect(
    "a module that draws while it loads, with no world bound or given, refuses the open with LoadRandomUnavailable, even when it catches the draw, and a module that draws nothing opens",
    () =>
      Effect.gen(function* () {
        const drawing = yield* settle(() =>
          // oxlint-disable-next-line effecttsgo/global-random -- The module under test draws from the ambient Math.random while it loads.
          drawingAtLoad(() => Math.random()).query(read, {}),
        );
        expect(drawing).toMatchObject({
          error: {
            _tag: "LoadRandomUnavailable",
            componentPath: "",
            modulePath: "draws",
          },
        });
        const caught = yield* settle(() =>
          drawingAtLoad(() => {
            try {
              return crypto.getRandomValues(new Uint8Array(1));
            } catch {
              return null;
            }
          }).query(read, {}),
        );
        expect(caught).toMatchObject({
          error: { _tag: "LoadRandomUnavailable", modulePath: "draws" },
        });
        const still = yield* settle(() =>
          drawingAtLoad(() => "no draw").query(read, {}),
        );
        expect(still).toEqual({ value: "no draw" });
      }),
  );

  it("two processes opening a module that draws while it loads, through TestConfect.layer with one seed, replay its draws byte for byte, and another seed moves them", () => {
    const loader = pathToFileURL(
      createRequire(import.meta.url).resolve("tsx/esm"),
    ).href;
    const script = fileURLToPath(
      new URL("fixtures/loadDrawReplay.ts", import.meta.url),
    );
    const replay = (...seed: Array<string>) =>
      spawnSync(process.execPath, ["--import", loader, script, ...seed], {
        encoding: "utf8",
      });
    const [one, two, other] = [replay(), replay(), replay("7")];
    expect(
      Arr.flatMap([one, two, other], ({ status, stderr }) => [status, stderr]),
    ).toEqual([0, "", 0, "", 0, ""]);
    expect(one.stdout).toBe(two.stdout);
    expect(other.stdout).not.toBe(one.stdout);
    // Mulberry32 from seed 0, `TestConfect.layer`'s default, first draws
    // 0.26642920868471265.
    expect(one.stdout).toContain('"mathRandom":[0.26642920868471265,');
  }, 120_000);
});
