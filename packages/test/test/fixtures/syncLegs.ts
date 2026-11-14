/**
 * The three legs of the sync protocol probe, each a script the unmodified
 * `convex` client (`BaseConvexClient`) runs against one target: the test
 * kernel's `Sync` in process, or a binary over its WebSocket. Each leg is an
 * Effect that answers its normalised observations, which the probe compares
 * between targets. The kernel's own suite runs the same legs against the kernel
 * alone.
 *
 * Normalised means what a client can rely on: per-socket query values with
 * consecutive duplicates removed, mutation outcomes as values or error data,
 * and terminal views. Batching, timestamps, timing, version tuples and retry
 * counts are never observed. A value that is the time is observed only as the
 * position of each change, since two clocks never agree on its digits.
 *
 * Every step has a deadline, so a target that stops answering ends its leg
 * instead of holding it. A leg writes what it has observed so far into its
 * `progress` after each step, so a leg that fails still leaves its partial
 * observations for the record. The legs run on the real clock: a test that runs
 * them is live.
 */
import { BaseConvexClient } from "convex/browser";
import { convexToJson, type JSONValue, type Value } from "convex/values";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import type * as Scope from "effect/Scope";
import * as Str from "effect/String";
import * as Json from "../../src/internal/Json";

/**
 * Where a leg runs. `address` is only the client's own setting: a kernel target
 * answers through `WebSocket` whatever it says.
 */
export interface Target {
  readonly name: "kernel" | "binary";
  readonly address: string;
  readonly WebSocket: new (url: string) => {
    onopen: ((event: unknown) => void) | null;
    onmessage: ((event: { readonly data: string }) => void) | null;
    onclose: ((event: unknown) => void) | null;
    onerror: ((event: unknown) => void) | null;
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
  };
  /**
   * How many times `sync:increment` lost a conflict to another commit and ran
   * again, since `since` (milliseconds on the host clock).
   */
  readonly contention: (since: number) => Effect.Effect<number>;
}

/**
 * What a leg has observed so far, rewritten after each step.
 */
export interface Progress {
  observed: unknown;
}

export const progress = (): Progress => ({ observed: null });

/**
 * How long one step may take before the leg gives up on it.
 */
export const stepDeadline = Duration.seconds(20);

// The client's frames and values are read inside its own callbacks, which
// cannot run an Effect, so they go through the kernel's synchronous JSON.
const same = (a: unknown, b: unknown) =>
  Json.stringify(a) === Json.stringify(b);

/**
 * A failure as a client can rely on it: a `ConvexError`'s data, or the
 * message's uncaught line without the request ID, server prefix or stack.
 */
export const normaliseError = (error: unknown): JSONValue => {
  const data = (error as { readonly data?: unknown } | null)?.data;
  if (data !== undefined) {
    try {
      return { data: convexToJson(data as Value) };
    } catch {
      return { data: { unencodable: typeof data } };
    }
  }
  const text = error instanceof Error ? error.message : String(error);
  const lines = Arr.map(Str.split(text, "\n"), Str.trim);
  const line = Option.getOrElse(
    Arr.findFirst(lines, Str.includes("Uncaught ")),
    () => Option.getOrElse(Arr.head(lines), () => ""),
  );
  return { message: Str.replace(/^.*Uncaught /, "")(line) };
};

const unanswered: JSONValue = {
  failed: { message: "no answer within the step deadline" },
};

/**
 * A step that yields `fallback` once the step deadline passes.
 */
const bounded = <A>(step: Effect.Effect<A>, fallback: A) =>
  step.pipe(
    Effect.timeoutOrElse({
      duration: stepDeadline,
      orElse: () => Effect.succeed(fallback),
    }),
  );

/**
 * One client of `target` and everything the probe watches it do: its queries'
 * values, any message its handler threw on, and its sockets.
 */
const openClient = (target: Target) => {
  const rejections: Array<string> = [];
  const sockets: Array<{ readonly drop: () => void }> = [];
  const sequences = new Map<string, Array<JSONValue>>();
  const watched = new Map<
    string,
    { readonly udfPath: string; readonly args: Record<string, Value> }
  >();
  const listeners = new Set<() => void>();
  const state = { dropResponse: false };

  // A socket that hands the client every event of `target`'s socket, records
  // a message the client's handler throws on instead of failing the run, and
  // can lose the next mutation response, as a dropped connection would.
  class Observed {
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { readonly data: string }) => void) | null = null;
    onclose: ((event: unknown) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    private readonly socket: InstanceType<Target["WebSocket"]>;
    private dropped = false;

    constructor(url: string) {
      this.socket = new target.WebSocket(url);
      sockets.push({ drop: () => this.drop() });
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- The kernel's socket has only the `on*` handlers the Convex client uses, so the wrapper forwards through them on both targets.
      this.socket.onopen = (event) => this.onopen?.(event);
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- See above.
      this.socket.onclose = (event) => this.onclose?.(event);
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- See above.
      this.socket.onerror = (event) => this.onerror?.(event);
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- See above.
      this.socket.onmessage = (event) => this.message(event);
    }

    get readyState() {
      return this.socket.readyState;
    }

    send(data: string) {
      this.socket.send(data);
    }

    close(code?: number, reason?: string) {
      this.socket.close(code, reason);
    }

    private drop() {
      this.dropped = true;
      this.socket.close();
    }

    private message(event: { readonly data: string }) {
      if (this.dropped) return;
      if (
        state.dropResponse &&
        (Json.parse(event.data) as { readonly type: string }).type ===
          "MutationResponse"
      ) {
        state.dropResponse = false;
        this.drop();
        return;
      }
      try {
        this.onmessage?.(event);
      } catch (error) {
        rejections.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  const read = (label: string): JSONValue | undefined => {
    const { udfPath, args } = watched.get(label)!;
    try {
      const value = convex.localQueryResult(udfPath, args);
      return value === undefined
        ? undefined
        : { value: convexToJson(value as Value) };
    } catch (error) {
      return { failed: normaliseError(error) };
    }
  };

  const convex: BaseConvexClient = new BaseConvexClient(
    target.address,
    () => {
      for (const label of watched.keys()) {
        const value = read(label);
        const sequence = sequences.get(label)!;
        if (
          value !== undefined &&
          !same(Option.getOrUndefined(Arr.last(sequence)), value)
        ) {
          sequence.push(value);
        }
      }
      for (const listener of listeners) listener();
    },
    {
      webSocketConstructor: Observed as unknown as typeof WebSocket,
      skipConvexDeploymentUrlCheck: true,
      unsavedChangesWarning: false,
      logger: false,
    },
  );

  return {
    rejections,
    sockets,
    watch: (label: string, udfPath: string, args: Record<string, Value>) => {
      convex.subscribe(udfPath, args);
      watched.set(label, { udfPath, args });
      sequences.set(label, []);
    },
    value: (label: string): JSONValue | undefined => read(label),
    sequences: (): Record<string, ReadonlyArray<JSONValue>> =>
      Rec.fromEntries(Array.from(sequences)),
    terminal: (): Record<string, JSONValue | null> =>
      Rec.fromEntries(
        Arr.map(Array.from(watched.keys()), (label) => [
          label,
          read(label) ?? null,
        ]),
      ),
    /**
     * Whether `predicate` holds after some transition within the step deadline.
     */
    until: (predicate: () => boolean) =>
      bounded(
        Effect.callback<boolean>((resume) => {
          if (predicate()) {
            resume(Effect.succeed(true));
            return;
          }
          const check = () => {
            if (predicate()) resume(Effect.succeed(true));
          };
          listeners.add(check);
          return Effect.sync(() => {
            listeners.delete(check);
          });
        }),
        false,
      ),
    mutation: (udfPath: string, args: Record<string, Value>) =>
      bounded(
        Effect.promise(() =>
          convex.mutation(udfPath, args).then(
            (value): JSONValue => ({ value: convexToJson(value as Value) }),
            (error: unknown): JSONValue => ({ failed: normaliseError(error) }),
          ),
        ),
        unanswered,
      ),
    /**
     * Present `token`, answering whether the client saw the server confirm it
     * within the step deadline.
     */
    setAuth: (token: string) =>
      bounded(
        Effect.callback<boolean>((resume) => {
          convex.setAuth(
            () => Promise.resolve(token),
            (authenticated) => resume(Effect.succeed(authenticated)),
          );
        }),
        false,
      ),
    clearAuth: () => convex.clearAuth(),
    /**
     * Lose the next mutation response this client is sent, and drop its socket,
     * so it reconnects under its session and resends the mutation.
     */
    loseNextMutationResponse: () => {
      state.dropResponse = true;
    },
    close: bounded(
      Effect.promise(() => convex.close()),
      undefined,
    ),
  };
};

export type Client = ReturnType<typeof openClient>;

/**
 * A client of `target` for the scope, closed when the scope closes.
 */
export const connect = (
  target: Target,
): Effect.Effect<Client, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => openClient(target)),
    (opened) => opened.close,
  );

/**
 * `sequence` with each value replaced by the position of its first appearance:
 * what a client can rely on about a value that is the time.
 */
const ordinals = (sequence: ReadonlyArray<JSONValue>): ReadonlyArray<number> =>
  Arr.map(sequence, (value) =>
    Option.getOrElse(
      Arr.findFirstIndex(sequence, (other) => same(other, value)),
      () => -1,
    ),
  );

/**
 * The names one run's rows go under, fresh so rows an earlier run left on a
 * binary never reach what this one compares.
 */
export const names = (run: string) => ({
  counter: `${run}:counter`,
  barrier: `${run}:barrier`,
  contended: `${run}:contended`,
  accepted: `${run}:accepted`,
});

/**
 * The tokens a leg presents: two valid ones for different subjects.
 */
export interface Tokens {
  readonly person: string;
  readonly other: string;
}

/**
 * Leg 1, the observable protocol. Two clients watch overlapping queries while
 * one of them mutates, fails, signs in, changes identity and signs out, and the
 * other passes a secret through a mutation, a failure and a query. After each
 * step both clients wait until they see the barrier counter reach it, so each
 * socket's sequence of values is the same whatever the batching.
 *
 * A third client then watches a query that answers the time and reads no
 * identity, and one that fails with the time as its error data. It signs in at
 * once, within the cache age: the binary reruns every query on an identity
 * change, and its cache answers the first with the value it already sent, while
 * the failure, never cached, runs again and fails anew. It waits out the cache
 * age and changes identity again: the cached value has expired, so both answer
 * a new time.
 */
export const observable = (
  target: Target,
  run: string,
  tokens: Tokens,
  secret: string,
  options: { readonly cacheAge: number; readonly progress?: Progress },
) =>
  Effect.gen(function* () {
    const name = names(run);
    const a = yield* connect(target);
    const b = yield* connect(target);
    const c = yield* connect(target);
    const outcomes: Array<JSONValue> = [];
    // Whether the failing clock's error changed on the sign-in within the
    // cache age and on the one after it. A rerun's count per sign-in follows
    // batching, so only whether each one changed the error is compared.
    const failing = { withinWindow: false, afterExpiry: false };
    const observed = () => ({
      sockets: {
        a: a.sequences(),
        b: b.sequences(),
        c: { clock: ordinals(c.sequences()["clock"] ?? []), failing },
      },
      outcomes,
      terminal: { a: a.terminal(), b: b.terminal() },
      rejections: [...a.rejections, ...b.rejections, ...c.rejections],
    });
    const record = Effect.sync(() => {
      if (options.progress !== undefined) {
        options.progress.observed = observed();
      }
    });
    const both = (predicate: (client: Client) => boolean) =>
      Effect.all(
        Arr.map([a, b], (client) => client.until(() => predicate(client))),
      );
    let step = 0;
    const barrier = Effect.gen(function* () {
      step++;
      const reached = { value: step };
      const outcome = yield* a.mutation("sync:increment", {
        name: name.barrier,
      });
      outcomes.push(outcome);
      yield* both((client) => same(client.value("barrier"), reached));
      yield* record;
    });
    const call = (
      client: Client,
      udfPath: string,
      args: Record<string, Value>,
    ) =>
      client
        .mutation(udfPath, args)
        .pipe(
          Effect.tap((outcome) => Effect.sync(() => outcomes.push(outcome))),
        );
    const signIn = (client: Client, token: string) =>
      client
        .setAuth(token)
        .pipe(
          Effect.tap((authenticated) =>
            Effect.sync(() => outcomes.push({ authenticated })),
          ),
        );

    return yield* Effect.gen(function* () {
      for (const client of [a, b]) {
        client.watch("counter", "sync:counter", { name: name.counter });
        client.watch("barrier", "sync:counter", { name: name.barrier });
        client.watch("whoami", "sync:whoami", {});
      }
      a.watch("notes", "sync:notes", { name: name.counter });
      b.watch("peek", "sync:peek", { secret });
      yield* both(
        (client) =>
          client.value("barrier") !== undefined &&
          client.value("whoami") !== undefined,
      );
      yield* call(a, "sync:increment", { name: name.counter });
      yield* barrier;
      yield* call(b, "sync:add", { name: name.counter, text: "first" });
      yield* barrier;
      yield* call(a, "sync:refuse", { code: "nope" });
      yield* barrier;
      yield* signIn(a, tokens.person);
      yield* barrier;
      yield* call(b, "sync:add", { name: name.counter, text: "second" });
      yield* barrier;
      yield* signIn(a, tokens.other);
      yield* barrier;
      a.clearAuth();
      yield* barrier;
      yield* call(b, "sync:remember", { name: name.counter, secret });
      yield* barrier;
      yield* call(a, "sync:reveal", { secret });
      yield* barrier;

      c.watch("clock", "sync:clock", { name: name.counter });
      c.watch("failing", "sync:failingClock", { name: name.counter });
      yield* c.until(
        () =>
          c.value("clock") !== undefined && c.value("failing") !== undefined,
      );
      const errors = () => (c.sequences()["failing"] ?? []).length;
      const first = errors();
      yield* signIn(c, tokens.person);
      // Let the reruns this sign-in owes arrive, well within the cache age.
      yield* Effect.sleep(Duration.millis(300));
      const within = errors();
      failing.withinWindow = within > first;
      yield* record;
      yield* Effect.sleep(Duration.millis(options.cacheAge + 1_500));
      yield* signIn(c, tokens.other);
      yield* c.until(() => (c.sequences()["clock"] ?? []).length > 1);
      // Let a late extra value show, should one come.
      yield* Effect.sleep(Duration.millis(500));
      failing.afterExpiry = errors() > within;
      return observed();
    }).pipe(Effect.ensuring(record));
  }).pipe(Effect.scoped);

/**
 * Leg 2, the OCC counter. Four clients each send eight increments of one
 * counter at once. Both targets must show contention, and the counter must end
 * at the number of increments that succeeded: no update is lost and none counts
 * twice. A target that shows no contention in a round runs another, up to
 * three, since contention on a binary depends on timing.
 */
export const occ = (
  target: Target,
  run: string,
  options: { readonly progress?: Progress } = {},
) =>
  Effect.gen(function* () {
    const clients = yield* Effect.all(
      Arr.map(Arr.range(1, 4), () => connect(target)),
    );
    const watcher = clients[0]!;
    let observation = { contended: false, consistent: false };
    for (let round = 1; round <= 3; round++) {
      const name = `${names(run).contended}:${round}`;
      const since = yield* Clock.currentTimeMillis;
      const outcomes = yield* Effect.all(
        Arr.flatMap(clients, (client) =>
          Arr.map(Arr.range(1, 8), () =>
            client.mutation("sync:increment", { name }),
          ),
        ),
        { concurrency: "unbounded" },
      );
      const succeeded = Arr.filter(
        outcomes,
        (outcome) => "value" in (outcome as object),
      ).length;
      watcher.watch(name, "sync:counter", { name });
      const expected = { value: succeeded };
      yield* watcher.until(() => same(watcher.value(name), expected));
      const contention = yield* bounded(target.contention(since), 0);
      observation = {
        contended: contention > 0,
        consistent: same(watcher.value(name), expected),
      };
      if (options.progress !== undefined) {
        options.progress.observed = { ...observation, round };
      }
      if (observation.contended || !observation.consistent) break;
    }
    return observation;
  }).pipe(Effect.scoped);

/**
 * Leg 3, client acceptance. One client signs in, increments, loses a mutation
 * response with its socket and reconnects under its session, changes token and
 * increments again. The unmodified client must accept every message: none
 * thrown on, each token confirmed, each mutation settled, and the counter at
 * exactly the increments it made, so the resent mutation applied once.
 */
export const acceptance = (
  target: Target,
  run: string,
  tokens: Tokens,
  options: { readonly progress?: Progress } = {},
) =>
  Effect.gen(function* () {
    const name = names(run).accepted;
    const c = yield* connect(target);
    const confirmed: Array<boolean> = [];
    const settled: Array<boolean> = [];
    const observed = () => ({
      thrownOn: c.rejections,
      confirmed,
      settled,
      reconnected: c.sockets.length > 1,
      terminal: c.terminal(),
    });
    const record = Effect.sync(() => {
      if (options.progress !== undefined) {
        options.progress.observed = observed();
      }
    });
    const increment = c.mutation("sync:increment", { name }).pipe(
      Effect.tap((outcome) =>
        Effect.sync(() => settled.push(outcome !== unanswered)),
      ),
      Effect.andThen(record),
    );
    const signIn = (token: string) =>
      c.setAuth(token).pipe(
        Effect.tap((authenticated) =>
          Effect.sync(() => confirmed.push(authenticated)),
        ),
        Effect.andThen(record),
      );
    return yield* Effect.gen(function* () {
      c.watch("counter", "sync:counter", { name });
      yield* signIn(tokens.person);
      yield* increment;
      c.loseNextMutationResponse();
      yield* increment;
      yield* signIn(tokens.other);
      yield* increment;
      const expected = { value: 3 };
      yield* c.until(() => same(c.value("counter"), expected));
      return observed();
    }).pipe(Effect.ensuring(record));
  }).pipe(Effect.scoped);

/**
 * What the acceptance leg must show on every target.
 */
export const accepted = {
  thrownOn: [],
  confirmed: [true, true],
  settled: [true, true, true],
  reconnected: true,
  terminal: { counter: { value: 3 } },
};
