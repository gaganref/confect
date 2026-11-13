// oxlint-disable effecttsgo/async-function, effecttsgo/new-promise, effecttsgo/global-timers, effecttsgo/global-date, unicorn/prefer-add-event-listener, eslint/no-await-in-loop -- The legs drive the unmodified Convex client, whose surface is promises, host timers and `on*` socket handlers, the same way on both targets, one step after another.
/**
 * The three legs of the sync protocol probe, each a script the unmodified
 * `convex` client (`BaseConvexClient`) runs against one target: the test
 * kernel's `Sync` in process, or a binary over its WebSocket. Each leg returns
 * its normalised observations, which the probe compares between targets. The
 * kernel's own suite runs the same legs against the kernel alone.
 *
 * Normalised means what a client can rely on: per-socket query values with
 * consecutive duplicates removed, mutation outcomes as values or error data,
 * and terminal views. Batching, timestamps, timing, version tuples and retry
 * counts are never observed.
 */
import { BaseConvexClient } from "convex/browser";
import { convexToJson, type JSONValue, type Value } from "convex/values";

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
  readonly contention: (since: number) => Promise<number>;
}

const settleWithin = 20_000;

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

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
  const uncaught = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.includes("Uncaught "));
  return {
    message: (uncaught ?? text.split("\n")[0] ?? "").replace(
      /^.*Uncaught /,
      "",
    ),
  };
};

const outcomeOf = (promise: Promise<unknown>): Promise<JSONValue> =>
  promise.then(
    (value) => ({ value: convexToJson(value as Value) }),
    (error: unknown) => ({ failed: normaliseError(error) }),
  );

/**
 * A promise that resolves `fallback` after `ms` unless `promise` settles first.
 */
const within = <A>(promise: Promise<A>, ms: number, fallback: A) =>
  Promise.race([promise, wait(ms).then(() => fallback)]);

/**
 * One client of `target` and everything the probe watches it do: its queries'
 * values, any message its handler threw on, and its sockets.
 */
export const connect = (target: Target) => {
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
      this.socket.onopen = (event) => this.onopen?.(event);
      this.socket.onclose = (event) => this.onclose?.(event);
      this.socket.onerror = (event) => this.onerror?.(event);
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
        (JSON.parse(event.data) as { readonly type: string }).type ===
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
      const value = client.localQueryResult(udfPath, args);
      return value === undefined
        ? undefined
        : { value: convexToJson(value as Value) };
    } catch (error) {
      return { failed: normaliseError(error) };
    }
  };

  const client: BaseConvexClient = new BaseConvexClient(
    target.address,
    () => {
      for (const label of watched.keys()) {
        const value = read(label);
        const sequence = sequences.get(label)!;
        if (value !== undefined && !same(sequence.at(-1), value)) {
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

  /**
   * Whether `predicate` holds after some transition within `ms`.
   */
  const until = (predicate: () => boolean, ms = settleWithin) =>
    predicate()
      ? Promise.resolve(true)
      : new Promise<boolean>((resolve) => {
          const done = (held: boolean) => {
            listeners.delete(check);
            clearTimeout(timer);
            resolve(held);
          };
          const check = () => {
            if (predicate()) done(true);
          };
          const timer = setTimeout(() => done(false), ms);
          listeners.add(check);
        });

  return {
    rejections,
    sockets,
    watch: (label: string, udfPath: string, args: Record<string, Value>) => {
      client.subscribe(udfPath, args);
      watched.set(label, { udfPath, args });
      sequences.set(label, []);
    },
    value: (label: string): JSONValue | undefined => read(label),
    sequences: (): Record<string, ReadonlyArray<JSONValue>> =>
      Object.fromEntries(sequences),
    terminal: (): Record<string, JSONValue | null> =>
      Object.fromEntries(
        Array.from(watched.keys(), (label) => [label, read(label) ?? null]),
      ),
    until,
    mutation: (udfPath: string, args: Record<string, Value>) =>
      outcomeOf(client.mutation(udfPath, args)),
    /**
     * Present `token`, resolving whether the client saw the server confirm it
     * within the settling time.
     */
    setAuth: (token: string) =>
      within(
        new Promise<boolean>((resolve) => {
          client.setAuth(
            () => Promise.resolve(token),
            (authenticated) => resolve(authenticated),
          );
        }),
        settleWithin,
        false,
      ),
    clearAuth: () => client.clearAuth(),
    /**
     * Lose the next mutation response this client is sent, and drop its socket,
     * so it reconnects under its session and resends the mutation.
     */
    loseNextMutationResponse: () => {
      state.dropResponse = true;
    },
    close: () => client.close(),
  };
};

export type Client = ReturnType<typeof connect>;

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
 */
export const observable = async (
  target: Target,
  run: string,
  tokens: Tokens,
  secret: string,
) => {
  const name = names(run);
  const a = connect(target);
  const b = connect(target);
  try {
    for (const c of [a, b]) {
      c.watch("counter", "sync:counter", { name: name.counter });
      c.watch("barrier", "sync:counter", { name: name.barrier });
      c.watch("whoami", "sync:whoami", {});
    }
    a.watch("notes", "sync:notes", { name: name.counter });
    b.watch("peek", "sync:peek", { secret });
    const outcomes: Array<JSONValue> = [];
    let step = 0;
    const barrier = async () => {
      step++;
      outcomes.push(await a.mutation("sync:increment", { name: name.barrier }));
      const reached = { value: step };
      return Promise.all(
        [a, b].map((c) => c.until(() => same(c.value("barrier"), reached))),
      );
    };
    await Promise.all(
      [a, b].map((c) =>
        c.until(
          () =>
            c.value("barrier") !== undefined && c.value("whoami") !== undefined,
        ),
      ),
    );
    outcomes.push(await a.mutation("sync:increment", { name: name.counter }));
    await barrier();
    outcomes.push(
      await b.mutation("sync:add", { name: name.counter, text: "first" }),
    );
    await barrier();
    outcomes.push(await a.mutation("sync:refuse", { code: "nope" }));
    await barrier();
    outcomes.push({ authenticated: await a.setAuth(tokens.person) });
    await barrier();
    outcomes.push(
      await b.mutation("sync:add", { name: name.counter, text: "second" }),
    );
    await barrier();
    outcomes.push({ authenticated: await a.setAuth(tokens.other) });
    await barrier();
    a.clearAuth();
    await barrier();
    outcomes.push(
      await b.mutation("sync:remember", { name: name.counter, secret }),
    );
    await barrier();
    outcomes.push(await a.mutation("sync:reveal", { secret }));
    await barrier();
    return {
      sockets: { a: a.sequences(), b: b.sequences() },
      outcomes,
      terminal: { a: a.terminal(), b: b.terminal() },
      rejections: [...a.rejections, ...b.rejections],
    };
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
};

/**
 * Leg 2, the OCC counter. Four clients each send eight increments of one
 * counter at once. Both targets must show contention, and the counter must end
 * at the number of increments that succeeded: no update is lost and none counts
 * twice. A target that shows no contention in a round runs another, up to
 * three, since contention on a binary depends on timing.
 */
export const occ = async (target: Target, run: string) => {
  const clients = [0, 1, 2, 3].map(() => connect(target));
  try {
    let observation = { contended: false, consistent: false, rounds: 0 };
    for (let round = 1; round <= 3; round++) {
      const name = `${names(run).contended}:${round}`;
      const since = Date.now();
      const outcomes = await Promise.all(
        clients.flatMap((c) =>
          Array.from({ length: 8 }, () =>
            c.mutation("sync:increment", { name }),
          ),
        ),
      );
      const succeeded = outcomes.filter((o) => "value" in (o as object)).length;
      const watcher = clients[0]!;
      watcher.watch(name, "sync:counter", { name });
      const expected = { value: succeeded };
      await watcher.until(() => same(watcher.value(name), expected));
      const contention = await target.contention(since);
      observation = {
        contended: contention > 0,
        consistent: same(watcher.value(name), expected),
        rounds: round,
      };
      if (observation.contended || !observation.consistent) break;
    }
    return {
      contended: observation.contended,
      consistent: observation.consistent,
    };
  } finally {
    await Promise.all(clients.map((c) => c.close()));
  }
};

/**
 * Leg 3, client acceptance. One client signs in, increments, loses a mutation
 * response with its socket and reconnects under its session, changes token and
 * increments again. The unmodified client must accept every message: none
 * thrown on, each token confirmed, each mutation settled, and the counter at
 * exactly the increments it made, so the resent mutation applied once.
 */
export const acceptance = async (
  target: Target,
  run: string,
  tokens: Tokens,
) => {
  const name = names(run).accepted;
  const c = connect(target);
  try {
    c.watch("counter", "sync:counter", { name });
    const confirmed = [await c.setAuth(tokens.person)];
    const settled: Array<boolean> = [];
    const increment = () =>
      within(
        c.mutation("sync:increment", { name }).then(() => true),
        settleWithin,
        false,
      );
    settled.push(await increment());
    c.loseNextMutationResponse();
    settled.push(await increment());
    confirmed.push(await c.setAuth(tokens.other));
    settled.push(await increment());
    const expected = { value: 3 };
    await c.until(() => same(c.value("counter"), expected));
    return {
      thrownOn: c.rejections,
      confirmed,
      settled,
      reconnected: c.sockets.length > 1,
      terminal: c.terminal(),
    };
  } finally {
    await c.close();
  }
};

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
