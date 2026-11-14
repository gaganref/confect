// One kernel backend, with a world, whose `Math` or `crypto` a test left as a
// property the kernel cannot redefine, printed as bytes. A frozen global
// cannot be undone in a process, so `Randomness.test.ts` runs each case in a
// process of its own. `process.argv[2]` names the case.
import {
  actionGeneric,
  defineSchema,
  makeFunctionReference,
  queryGeneric,
} from "convex/server";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { convexTest } from "../../src/internal/ConvexTest";
import * as DriverWorld from "../../src/internal/DriverWorld";
import { withSources } from "./inlineSources";

const UnknownJson = Schema.fromJsonString(Schema.Unknown);

const seen = { loaded: false, ran: false, fetched: 0, logged: 0 };

// The `fetch` a test's `Math` setter puts in place of the guard: a raw call the
// kernel never checks.
const rawFetch = () => {
  seen.fetched += 1;
  return Promise.resolve(new Response("raw"));
};

// The console a test's `Math` setter puts in place of the guard's view: a
// configurable, unfrozen object whose calls the kernel never drops.
const rawConsole = {
  log: () => {
    seen.logged += 1;
  },
};

const t = convexTest({
  schema: defineSchema({}),
  world: DriverWorld.make("unguardable", 0),
  ...withSources({
    "_generated/server.ts": () => Promise.resolve({}),
    "draws.ts": () => {
      seen.loaded = true;
      return Promise.resolve({
        noop: queryGeneric({ args: {}, handler: () => Promise.resolve(null) }),
        fetches: queryGeneric({
          args: {},
          handler: () => {
            seen.ran = true;
            // oxlint-disable-next-line effecttsgo/global-fetch -- The plain query calls whatever fetch the kernel leaves it, the guard or a raw replacement.
            return fetch("https://example.com/").then(
              (response) => response.text(),
              (error: unknown) => String(error),
            );
          },
        }),
        // An action that logs before it returns, and again after.
        logs: actionGeneric({
          args: {},
          handler: () => {
            seen.ran = true;
            // oxlint-disable-next-line effecttsgo/global-console -- The plain action logs through whatever console the kernel leaves it, the guard's view or a raw replacement.
            console.log("before");
            // oxlint-disable-next-line effecttsgo/global-timers, effecttsgo/global-console -- The plain action logs once more after it returns, on the runtime's own timer, through whatever console the kernel leaves it.
            setTimeout(() => console.log("after"), 0);
            return Promise.resolve(null);
          },
        }),
        read: queryGeneric({
          args: {},
          handler: () => {
            seen.ran = true;
            return Promise.resolve({
              // oxlint-disable-next-line effecttsgo/global-random -- The plain query reads the ambient Math.random the kernel gives it.
              random: Math.random(),
              // oxlint-disable-next-line effecttsgo/crypto-random-uuid -- The plain query reads the ambient crypto.randomUUID the kernel gives it.
              uuid: crypto.randomUUID(),
            });
          },
        }),
      });
    },
  }),
});

const noop = makeFunctionReference<"query">("draws:noop");
const fetches = makeFunctionReference<"query">("draws:fetches");
const read = makeFunctionReference<"query">("draws:read");
const logs = makeFunctionReference<"action">("draws:logs");

const host = { Math: globalThis.Math, crypto: globalThis.crypto };

const freezes: Record<string, () => void> = {
  "frozen-math": () =>
    Object.defineProperty(globalThis, "Math", {
      value: host.Math,
      writable: false,
      configurable: false,
    }),
  "frozen-crypto": () =>
    Object.defineProperty(globalThis, "crypto", {
      value: host.crypto,
      writable: false,
      configurable: false,
    }),
  "getter-only-crypto": () =>
    Object.defineProperty(globalThis, "crypto", {
      get: () => host.crypto,
      configurable: false,
    }),
  "ignoring-setter-crypto": () =>
    Object.defineProperty(globalThis, "crypto", {
      get: () => host.crypto,
      set: () => {},
      configurable: false,
    }),
  "crypto-getter-restores-math": () =>
    Object.defineProperty(globalThis, "crypto", {
      get: () => {
        // A hostile getter: it puts the host's Math back over the kernel's.
        Object.defineProperty(globalThis, "Math", {
          value: host.Math,
          writable: true,
          configurable: true,
        });
        return host.crypto;
      },
      configurable: true,
    }),
  "math-setter-replaces-fetch": () => {
    // A Math accessor the kernel cannot redefine, whose setter takes the
    // kernel's Math and replaces fetch on the way.
    let stored: unknown = globalThis.Math;
    Object.defineProperty(globalThis, "Math", {
      get: () => stored,
      set: (value: unknown) => {
        stored = value;
        Object.defineProperty(globalThis, "fetch", {
          value: rawFetch,
          writable: true,
          configurable: true,
        });
      },
      configurable: false,
    });
  },
  "fixed-console": () =>
    Object.defineProperty(globalThis, "console", {
      value: rawConsole,
      writable: false,
      configurable: false,
    }),
  "math-setter-replaces-console": () => {
    // As above, with console replaced by a configurable, unfrozen object.
    let stored: unknown = globalThis.Math;
    Object.defineProperty(globalThis, "Math", {
      get: () => stored,
      set: (value: unknown) => {
        stored = value;
        Object.defineProperty(globalThis, "console", {
          value: rawConsole,
          writable: true,
          configurable: true,
        });
      },
      configurable: false,
    });
  },
  "throwing-getter-crypto": () =>
    Object.defineProperty(globalThis, "crypto", {
      get: () => {
        throw new TypeError("crypto getter fails");
      },
      configurable: false,
    }),
  "throwing-getter-crypto-configurable": () =>
    Object.defineProperty(globalThis, "crypto", {
      get: () => {
        throw new TypeError("crypto getter fails");
      },
      configurable: true,
    }),
  "undescribable-throw-crypto": () => {
    // An Error whose message getter throws too.
    const thrown: unknown = Object.create(Error.prototype, {
      message: {
        get: () => {
          throw new Error("message getter fails");
        },
      },
    });
    Object.defineProperty(globalThis, "crypto", {
      get: () => host.crypto,
      set: () => {
        throw thrown;
      },
      configurable: false,
    });
  },
  "throwing-setter-crypto": () =>
    Object.defineProperty(globalThis, "crypto", {
      get: () => host.crypto,
      set: () => {
        throw new TypeError("crypto is read-only here");
      },
      configurable: false,
    }),
};

const settle = (call: () => Promise<unknown>) =>
  Effect.promise(() =>
    call().then(
      (value) => ({ outcome: "ran", value }),
      (error: unknown) => {
        const { _tag, reason, globals, message } = error as Record<
          string,
          unknown
        >;
        return { outcome: "refused", _tag, reason, globals, message };
      },
    ),
  );

const name = process.argv[2] ?? "";
const afterOpen = Str.endsWith("-after-open")(name);
const freeze =
  freezes[afterOpen ? Str.slice(0, -"-after-open".length)(name) : name];

const run = Effect.gen(function* () {
  if (freeze === undefined) throw new Error(`No case named "${name}".`);
  if (afterOpen) {
    // An unbound call opens the backend and loads the module first.
    const opened = yield* settle(() => t.query(noop, {}));
    if (opened.outcome !== "ran") throw new Error("The open did not run.");
  }
  freeze();
  const fetching = Str.startsWith("math-setter-replaces-fetch")(name);
  const logging = Str.startsWith("math-setter-replaces-console")(name);
  const result = yield* settle(() =>
    logging ? t.action(logs, {}) : t.query(fetching ? fetches : read, {}),
  );
  // Long enough for a log the action schedules after it returns.
  if (logging) yield* Effect.sleep(Duration.millis(50));
  const { fetched, logged, ...ranAndLoaded } = seen;
  const output = yield* Schema.encodeEffect(UnknownJson)({
    ...result,
    ...ranAndLoaded,
    ...(fetching ? { fetched } : {}),
    ...(logging ? { logged } : {}),
  });
  process.stdout.write(output);
});

void Effect.runPromise(run);
