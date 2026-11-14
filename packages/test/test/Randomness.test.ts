// oxlint-disable-next-line effecttsgo/node-builtin-import -- The replay test compares the exact stdout of fresh Node processes.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import {
  defineSchema,
  defineTable,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import refs from "../../../tools/local-backend/fixtures/confect/_generated/refs";
import { convexTest, type KernelControls } from "../src/internal/ConvexTest";
import * as Invocation from "../src/internal/Invocation";
import * as Json from "../src/internal/Json";
import * as KernelRefusal from "../src/internal/KernelRefusal";
import { call, localBackendWorld } from "./fixtures/localBackendWorld";
import {
  calls,
  drawingBackend,
  drawnFrom,
  invocationOf,
  streamFor,
} from "./fixtures/drawingBackend";
import { expectedOnKernel, normalize } from "./fixtures/randomnessProbe";
import { keptAtImport } from "./fixtures/randomKeptAtImport";

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

/**
 * A backend whose one module keeps `Math.random` and `getRandomValues` while it
 * loads, drawing nothing, and whose `read` query calls what it kept.
 */
const keepingAtLoad = (world?: Invocation.World): KernelControls =>
  convexTest({
    schema: defineSchema({}),
    modules: {
      "_generated/server.ts": () => Promise.resolve({}),
      "kept.ts": () => {
        const { random } = Math;
        // oxlint-disable-next-line typescript/unbound-method -- The module keeps the methods detached, as one may at load.
        const { getRandomValues } = crypto;
        return Promise.resolve({
          noop: queryGeneric({
            args: {},
            handler: () => Promise.resolve(null),
          }),
          read: queryGeneric({
            args: {},
            handler: () =>
              Promise.resolve([
                random(),
                ...getRandomValues(new Uint8Array(1)),
              ]),
          }),
          host: queryGeneric({
            args: {},
            handler: () => Promise.resolve(keptAtImport()),
          }),
        });
      },
    },
    ...(world === undefined ? {} : { world }),
  });

const kept = {
  noop: makeFunctionReference<"query", Record<string, never>, null>(
    "kept:noop",
  ),
  read: makeFunctionReference<"query", Record<string, never>, unknown>(
    "kept:read",
  ),
  host: makeFunctionReference<"query", Record<string, never>, number>(
    "kept:host",
  ),
};

/**
 * An invocation whose stream, and its world's, cycles through `values`.
 */
const boundTo = (values: ReadonlyArray<number>): Invocation.Invocation => ({
  world: { ...worldOf("bound"), random: cycling(values) },
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
  random: cycling(values),
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
    "a query, a mutation and an action may each draw from Math.random and crypto, refuse the fills the binary refuses, and generate a key only in an action",
    () =>
      Effect.gen(function* () {
        const query = yield* sample("query");
        const mutation = yield* sample("mutation");
        const action = yield* sample("action");
        expect({
          query: normalize(query),
          mutation: normalize(mutation),
          action: normalize(action),
        }).toEqual(expectedOnKernel);
      }),
  );

  it.effect(
    "the probe's normalisation fails a sample whose fills, draws or UUIDs a zero-filled source replaced",
    () =>
      Effect.gen(function* () {
        const real = yield* sample("query");
        expect(normalize(real)).toEqual(expectedOnKernel.query);
        const zeroed = {
          mathRandom: [0],
          getRandomValues: [0, 0, 0, 0],
          largestFill: [65_536, 1],
          detachedFill: [0, 0, 0, 0],
          randomUUID: [36, 0],
          loadMathRandom: [0],
          loadGetRandomValues: [0, 0, 0, 0],
          loadRandomUUID: [36, 0],
        } as const;
        for (const [field, value] of Rec.toEntries(zeroed)) {
          const replaced = { ...real, [field]: { ...real[field], value } };
          expect(normalize(replaced), field).not.toEqual(
            expectedOnKernel.query,
          );
        }
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

  it.effect(
    "a Math.random and getRandomValues a module keeps while it loads draw, in a handler, from that handler's stream, not the load's",
    () =>
      Effect.gen(function* () {
        const t = keepingAtLoad(worldOf("load"));
        // An unbound call opens the backend under its own world, whose
        // stream starts at 0.125, and the module keeps its references then.
        const opened = yield* settle(() => t.query(kept.noop, {}));
        expect(opened).toEqual({ value: null });
        const drawn = yield* Effect.promise(() =>
          Invocation.bind(boundTo([0.625, 0.375]), () =>
            t.query(kept.read, {}),
          ),
        );
        expect(drawn).toEqual([0.625, 96]);
      }),
  );

  it.effect(
    "a reference a module keeps during an open with no world refuses nothing later, and draws from the stream of the invocation that calls it",
    () =>
      Effect.gen(function* () {
        const t = keepingAtLoad();
        // An unbound call opens the backend with no world. The module draws
        // nothing while it loads, so the open succeeds.
        const opened = yield* settle(() => t.query(kept.noop, {}));
        expect(opened).toEqual({ value: null });
        const drawn = yield* settle(() =>
          Invocation.bind(boundTo([0.625, 0.375]), () =>
            t.query(kept.read, {}),
          ),
        );
        expect(drawn).toEqual({ value: [0.625, 96] });
      }),
  );

  it.effect(
    "a Math.random kept before the kernel ran any code stays the host's, under a bound invocation too",
    () =>
      Effect.gen(function* () {
        const t = keepingAtLoad(worldOf("load"));
        const drawn = yield* Effect.promise(() =>
          Invocation.bind(boundTo([0.625]), () => t.query(kept.host, {})),
        );
        // The host's draw, which a real `Math.random` makes 0.625 with
        // vanishing probability.
        expect(drawn).not.toBe(0.625);
        expect(drawn).toBeGreaterThanOrEqual(0);
        expect(drawn).toBeLessThan(1);
      }),
  );

  it("two processes running a plain query, mutation and action, a component's query and a lazily imported module, each under its own bound stream, draw the same bytes, and each draws its stream's values", () => {
    const loader = pathToFileURL(
      createRequire(import.meta.url).resolve("tsx/esm"),
    ).href;
    const script = fileURLToPath(
      new URL("fixtures/handlerDrawReplay.ts", import.meta.url),
    );
    const replay = () =>
      spawnSync(process.execPath, ["--import", loader, script], {
        encoding: "utf8",
      });
    const [one, two] = [replay(), replay()];
    expect([one.status, one.stderr, two.status, two.stderr]).toEqual([
      0,
      "",
      0,
      "",
    ]);
    expect(one.stdout).toBe(two.stdout);
    const fromStreams = Rec.fromEntries(
      Arr.map(Rec.keys(calls), (name, index) => [
        name,
        drawnFrom(streamFor(index)),
      ]),
    );
    expect(Json.parse(one.stdout)).toEqual(fromStreams);
  }, 120_000);

  it.effect(
    "a function with no invocation bound draws from the backend's own world, a plain one and a component's in call order, and with no world refuses with FunctionRandomUnavailable",
    () =>
      Effect.gen(function* () {
        const t = drawingBackend({
          ...worldOf("own"),
          random: streamFor(100),
        });
        const query = yield* settle(() => t.query(calls.query[1], {}));
        const component = yield* settle(() => t.query(calls.component[1], {}));
        const own = streamFor(100);
        expect([query, component]).toEqual([
          { value: drawnFrom(own) },
          { value: drawnFrom(own) },
        ]);
        const refused = yield* settle(() =>
          drawingBackend().query(calls.query[1], {}),
        );
        expect(refused).toMatchObject({
          error: {
            _tag: "FunctionRandomUnavailable",
            componentPath: "",
            udfPath: "draws:query",
          },
        });
      }),
  );

  it("two processes running unbound functions through TestConfect.layer with one seed draw the same bytes from its world, and another seed moves them", () => {
    const loader = pathToFileURL(
      createRequire(import.meta.url).resolve("tsx/esm"),
    ).href;
    const script = fileURLToPath(
      new URL("fixtures/unboundDrawReplay.ts", import.meta.url),
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
    // Nothing loads or schedules a draw first, so the first run's first draw
    // is Mulberry32 from seed 0's first, 0.26642920868471265.
    expect(Json.parse(one.stdout)).toMatchObject([
      { random: 0.26642920868471265 },
      {},
    ]);
  }, 120_000);

  it("the entropy install's refusal, built without the class's parser, is what UnguardableGlobal.make builds", () => {
    const failures = [
      { global: "Math", holds: "a non-writable value", fixed: true },
      { global: "crypto", holds: "a getter with no setter", fixed: false },
    ];
    const trusted = KernelRefusal.uninstallableEntropy(failures);
    const parsed = KernelRefusal.UnguardableGlobal.make({
      reason: trusted.reason,
      globals: trusted.globals,
      message: trusted.message,
    });
    expect(trusted).toBeInstanceOf(KernelRefusal.UnguardableGlobal);
    expect(Schema.is(KernelRefusal.UnguardableGlobal)(trusted)).toBe(true);
    const shape = (error: KernelRefusal.UnguardableGlobal) => [
      error._tag,
      error.reason,
      error.globals,
      error.message,
      Reflect.ownKeys(error),
    ];
    expect(shape(trusted)).toEqual(shape(parsed));
    expect([trusted.reason, trusted.globals]).toEqual([
      "installFailed",
      ["Math", "crypto"],
    ]);
  });

  describe("a Math or crypto the kernel cannot redefine refuses with UnguardableGlobal before any code runs", () => {
    const loader = pathToFileURL(
      createRequire(import.meta.url).resolve("tsx/esm"),
    ).href;
    const script = fileURLToPath(
      new URL("fixtures/unguardableEntropy.ts", import.meta.url),
    );
    const outcome = (name: string): unknown => {
      const run = spawnSync(
        process.execPath,
        ["--import", loader, script, name],
        { encoding: "utf8" },
      );
      expect([run.status, run.stderr], name).toEqual([0, ""]);
      return Json.parse(run.stdout) as unknown;
    };
    const refused = (global: string, holds: string, loaded: boolean) => ({
      outcome: "refused",
      _tag: "UnguardableGlobal",
      reason: "notConfigurable",
      globals: [global],
      message: expect.stringContaining(
        `globalThis.${global} is ${holds} that cannot be redefined`,
      ),
      loaded,
      ran: false,
    });
    it("a frozen Math refuses the open before the module loads", () => {
      expect(outcome("frozen-math")).toEqual(
        refused("Math", "a non-writable value", false),
      );
    }, 60_000);
    it("a frozen crypto refuses the open before the module loads", () => {
      expect(outcome("frozen-crypto")).toEqual(
        refused("crypto", "a non-writable value", false),
      );
    }, 60_000);
    it("a getter-only crypto refuses the open before the module loads", () => {
      expect(outcome("getter-only-crypto")).toEqual(
        refused("crypto", "a getter with no setter", false),
      );
    }, 60_000);
    it("a crypto accessor whose setter ignores the assignment refuses the open, because the read-back answers the host's", () => {
      expect(outcome("ignoring-setter-crypto")).toEqual(
        refused(
          "crypto",
          "an accessor whose setter did not take the assignment",
          false,
        ),
      );
    }, 60_000);
    it("a crypto getter that puts the host's Math back after Math's install refuses the open, and the next function after an open, through the final read-back pass", () => {
      const undone = (loaded: boolean) => ({
        outcome: "refused",
        _tag: "UnguardableGlobal",
        reason: "installFailed",
        globals: ["Math"],
        message: expect.stringContaining(
          "globalThis.Math is no longer the kernel's after a later step of the install replaced it",
        ),
        loaded,
        ran: false,
      });
      expect({
        atOpen: outcome("crypto-getter-restores-math"),
        afterOpen: outcome("crypto-getter-restores-math-after-open"),
      }).toEqual({ atOpen: undone(false), afterOpen: undone(true) });
    }, 60_000);
    it("a configurable Math getter that throws gets a tagged UnguardableGlobal, built without the ambient Math", () => {
      const run = spawnSync(
        process.execPath,
        [
          "--import",
          loader,
          fileURLToPath(new URL("fixtures/throwingMath.ts", import.meta.url)),
        ],
        { encoding: "utf8" },
      );
      expect([run.status, run.stderr]).toEqual([0, ""]);
      expect(Json.parse(run.stdout)).toEqual({
        outcome: "refused",
        _tag: "UnguardableGlobal",
        reason: "installFailed",
        globals: ["Math"],
        message: expect.stringContaining(
          "globalThis.Math is an accessor whose install threw TypeError: Math getter fails",
        ),
        loaded: false,
        ran: false,
      });
    }, 60_000);
    it("a crypto accessor whose getter throws refuses the open with UnguardableGlobal, non-configurable or configurable, never the raw error", () => {
      const thrownBy = (reason: string, holds: string) => ({
        outcome: "refused",
        _tag: "UnguardableGlobal",
        reason,
        globals: ["crypto"],
        message: expect.stringContaining(`globalThis.crypto is ${holds}`),
        loaded: false,
        ran: false,
      });
      expect({
        fixed: outcome("throwing-getter-crypto"),
        configurable: outcome("throwing-getter-crypto-configurable"),
      }).toEqual({
        fixed: thrownBy(
          "notConfigurable",
          "an accessor that cannot be redefined whose install threw TypeError: crypto getter fails",
        ),
        configurable: thrownBy(
          "installFailed",
          "an accessor whose install threw TypeError: crypto getter fails",
        ),
      });
    }, 60_000);
    it("a crypto setter that throws an Error whose message getter throws refuses with UnguardableGlobal, describing the value by fixed text", () => {
      expect(outcome("undescribable-throw-crypto")).toEqual({
        outcome: "refused",
        _tag: "UnguardableGlobal",
        reason: "notConfigurable",
        globals: ["crypto"],
        message: expect.stringContaining(
          "globalThis.crypto is an accessor that cannot be redefined whose install threw a thrown value that could not be described",
        ),
        loaded: false,
        ran: false,
      });
    }, 60_000);
    it("a crypto left non-configurable but writable runs a bound Confect handler, a Confect component's handler and a component's scheduled function, each drawing from the stream", () => {
      const run = spawnSync(
        process.execPath,
        [
          "--import",
          loader,
          fileURLToPath(
            new URL("fixtures/writableCryptoBound.ts", import.meta.url),
          ),
        ],
        { encoding: "utf8" },
      );
      expect([run.status, run.stderr]).toEqual([0, ""]);
      expect(Json.parse(run.stdout)).toEqual({
        confect: { outcome: "ran", value: expectedOnKernel.query },
        component: { outcome: "ran", value: { first: [], second: [] } },
        // The drain ran the component's scheduled create.
        scheduled: { outcome: "ran", value: { first: [17], second: [] } },
      });
    }, 60_000);
    it("a crypto accessor whose setter throws refuses the open with UnguardableGlobal, never the raw error", () => {
      expect(outcome("throwing-setter-crypto")).toEqual({
        outcome: "refused",
        _tag: "UnguardableGlobal",
        reason: "notConfigurable",
        globals: ["crypto"],
        message: expect.stringContaining(
          "globalThis.crypto is an accessor that cannot be redefined whose install threw TypeError: crypto is read-only here",
        ),
        loaded: false,
        ran: false,
      });
    }, 60_000);
    it("a crypto left non-configurable but writable installs the kernel's in place, signing draws exactly the 32 seed values, and a worldless restore signs with the same key", () => {
      const run = spawnSync(
        process.execPath,
        [
          "--import",
          loader,
          fileURLToPath(
            new URL("fixtures/writableCryptoSigning.ts", import.meta.url),
          ),
        ],
        { encoding: "utf8" },
      );
      expect([run.status, run.stderr]).toEqual([0, ""]);
      expect(Json.parse(run.stdout)).toEqual({
        installedInPlace: true,
        signed: "ran",
        signingDraws: 32,
        restoredSigned: "ran",
        restoredRefusal: null,
        sameKey: true,
      });
    }, 60_000);
    it("a Math frozen after the open refuses the next function before its handler runs", () => {
      expect(outcome("frozen-math-after-open")).toEqual(
        refused("Math", "a non-writable value", true),
      );
    }, 60_000);
  });

  /**
   * A socket subscribed to a plain query that reads `ticks` and draws, then a
   * mutation bound to `committer` that commits to `ticks`. The socket is opened
   * inside `opener`'s invocation when given, and every frame is sent from
   * unbound test code. With `mutate`, the socket also sends a Mutation frame
   * for a mutation that draws and writes nothing, between the first run and the
   * commit. Answers the runs' values, then the mutation's result.
   */
  const socketRuns = (
    committer: () => number,
    opener?: () => number,
    mutate = false,
  ) =>
    Effect.gen(function* () {
      const t: KernelControls = convexTest({
        schema: defineSchema({ ticks: defineTable({ n: v.number() }) }),
        world: { ...worldOf("own"), random: streamFor(200) },
        modules: {
          "_generated/server.ts": () => Promise.resolve({}),
          "ticks.ts": () =>
            Promise.resolve({
              read: queryGeneric({
                args: {},
                handler: (ctx) =>
                  ctx.db
                    .query("ticks")
                    .collect()
                    .then((rows) => ({
                      count: rows.length,
                      // oxlint-disable-next-line effecttsgo/global-random -- A plain query reads the ambient Math.random the kernel gives it.
                      draw: Math.random(),
                    })),
              }),
              bump: mutationGeneric({
                args: {},
                handler: (ctx) =>
                  ctx.db.insert("ticks", { n: 1 }).then(() => null),
              }),
              drawM: mutationGeneric({
                args: {},
                // oxlint-disable-next-line effecttsgo/global-random -- A plain mutation reads the ambient Math.random the kernel gives it.
                handler: () => Promise.resolve(Math.random()),
              }),
            }),
        },
      });
      const received: Array<Record<string, any>> = [];
      const open = () => {
        const socket = new (t.sync().WebSocket)("ws://kernel.invalid");
        // oxlint-disable-next-line unicorn/prefer-add-event-listener -- The kernel's socket has only the `on*` handlers the Convex client uses.
        socket.onmessage = (event) => {
          // A frame arrives in the socket's callback, which cannot run an Effect.
          received.push(Json.parse(event.data) as Record<string, any>);
        };
        const { promise: opened, resolve } = Promise.withResolvers<void>();
        // oxlint-disable-next-line unicorn/prefer-add-event-listener -- See above.
        socket.onopen = () => resolve();
        return { socket, opened };
      };
      const { socket: ws, opened } =
        opener === undefined
          ? open()
          : yield* Effect.promise(() =>
              Invocation.bind(invocationOf(opener), () =>
                Promise.resolve(open()),
              ),
            );
      yield* Effect.promise(() => opened);
      const send = (message: object) =>
        Effect.sync(() => ws.send(Json.stringify(message))).pipe(
          Effect.andThen(Effect.sleep(Duration.millis(50))),
        );
      yield* send({
        type: "Connect",
        sessionId: "draws",
        connectionCount: 0,
        lastCloseReason: "InitialConnect",
        clientTs: 0,
      });
      yield* send({
        type: "ModifyQuerySet",
        baseVersion: 0,
        newVersion: 1,
        modifications: [
          { type: "Add", queryId: 0, udfPath: "ticks:read", args: [{}] },
        ],
      });
      if (mutate) {
        yield* send({
          type: "Mutation",
          requestId: 0,
          udfPath: "ticks:drawM",
          args: [{}],
        });
      }
      yield* Effect.promise(() =>
        Invocation.bind(invocationOf(committer), () =>
          t.mutation(makeFunctionReference<"mutation">("ticks:bump"), {}),
        ),
      );
      yield* Effect.sleep(Duration.millis(100));
      ws.close();
      const transitions: ReadonlyArray<Record<string, any>> = Arr.filter(
        received,
        (message) => message["type"] === "Transition",
      );
      const mutated = Arr.map(
        Arr.filter(
          received,
          (message) => message["type"] === "MutationResponse",
        ),
        (message) => message["result"] as unknown,
      );
      return [
        ...Arr.flatMap(transitions, (message): ReadonlyArray<unknown> =>
          Arr.map(
            message["modifications"] as ReadonlyArray<Record<string, any>>,
            (modification) => modification["value"],
          ),
        ),
        ...mutated,
      ];
    });

  it.live(
    "a sync socket's rerun of a query a bound mutation's commit invalidated draws from the backend's own world, never the committer's stream",
    () =>
      Effect.gen(function* () {
        const committer = streamFor(300);
        const values = yield* socketRuns(committer);
        // Both runs are the socket's own, unbound requests: the first and the
        // second draw of the backend's world.
        const own = streamFor(200);
        expect(values).toEqual([
          { count: 0, draw: own() },
          { count: 1, draw: own() },
        ]);
        // The committing mutation drew nothing, and the rerun left its stream
        // alone.
        expect(committer()).toBe(streamFor(300)());
      }),
  );

  it.live(
    "a sync socket opened under a bound invocation runs its first query, a mutation it sends and its rerun from that invocation's stream, whoever sent the frame or committed",
    () =>
      Effect.gen(function* () {
        const committer = streamFor(300);
        const values = yield* socketRuns(committer, streamFor(400), true);
        // The first run, then the socket's mutation, then the rerun, each the
        // opener's next draw.
        const opener = streamFor(400);
        const [first, mutation, rerun] = [opener(), opener(), opener()];
        expect(values).toEqual([
          { count: 0, draw: first },
          { count: 1, draw: rerun },
          mutation,
        ]);
        expect(committer()).toBe(streamFor(300)());
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
