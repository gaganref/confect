import type { UserIdentity } from "convex/server";
import { compareValues, convexToJson, type Value } from "convex/values";
import * as Execution from "./Execution.js";
import * as Kernel from "./Kernel.js";
import * as Arr from "effect/Array";
import * as Json from "./Json.js";

/**
 * One run of a subscribed query, and the identity version its subscriber had
 * when it ran.
 */
export interface Run extends Execution.QueryRun {
  readonly identityVersion: number;
}

/**
 * Why a run no longer shows what its query answers now.
 */
export type Invalidation =
  | { readonly kind: "commit"; readonly change: Kernel.Change }
  | {
      readonly kind: "identity";
      readonly from: number;
      readonly to: number;
    };

/**
 * Why `run` is stale, if it is: a commit since its snapshot changed something
 * it read, as an attempt's read set conflicts, or its subscriber's identity has
 * changed. A test's subscriber reruns only the runs that read the identity. A
 * sync socket's reruns every run, as the binary's worker does
 * (`crates/sync/src/worker.rs:948-962`), and its query cache decides which of
 * those reruns answer anything new. The clock never makes a run stale. The
 * binary does not rerun a query because time passed, so a run keeps the time it
 * read until something else invalidates it.
 */
export const invalidation = (
  run: Run,
  state: Kernel.State,
  identityVersion: number,
  everyRun = false,
): Invalidation | undefined => {
  const change = Kernel.conflict(state, run.snapshot, run.reads);
  if (change !== undefined) return { kind: "commit", change };
  if (
    (everyRun || run.observedIdentity) &&
    run.identityVersion !== identityVersion
  ) {
    return { kind: "identity", from: run.identityVersion, to: identityVersion };
  }
  return undefined;
};

/**
 * The binary's default `MAX_CACHE_AGE`: `DATABASE_UDF_USER_TIMEOUT` (1 s) plus
 * `DATABASE_UDF_SYSTEM_TIMEOUT` (15 s) plus a second
 * (`crates/application/src/cache/mod.rs:112-122`,
 * `crates/common/src/knobs.rs:982-994`).
 */
export const defaultCacheAge = 17_000;

/**
 * A thrown value as JSON: a Convex value as Convex writes it, and anything else
 * as its string, beside its type so `"1"` and `1` differ.
 */
const thrownKey = (thrown: unknown): unknown => {
  try {
    return [typeof thrown, convexToJson(thrown as Value)];
  } catch {
    return [typeof thrown, String(thrown)];
  }
};

const errorKey = (error: unknown): string =>
  Json.stringify(
    error instanceof Error
      ? [
          "error",
          error.name,
          error.message,
          thrownKey((error as { readonly data?: unknown }).data),
        ]
      : ["thrown", thrownKey(error)],
  );

/**
 * Whether two outcomes show a client the same thing: equal values, failures
 * with errors of the same name, message and data, or failures that threw equal
 * bare values.
 */
export const sameOutcome = (
  a: Execution.Outcome,
  b: Execution.Outcome,
): boolean =>
  a._tag === "returned"
    ? b._tag === "returned" && compareValues(a.value, b.value) === 0
    : b._tag === "failed" && errorKey(a.error) === errorKey(b.error);

/**
 * A subscription's value changed when a refresh reran it.
 */
export interface Transition {
  readonly subscription: string;
  readonly from: Execution.Outcome;
  readonly to: Execution.Outcome;
  readonly because: Invalidation;
}

/**
 * A subscription whose value differs from what a full rerun of its query
 * answers.
 */
export interface Disagreement {
  readonly subscription: string;
  readonly incremental: Execution.Outcome;
  readonly reference: Execution.Outcome;
}

/**
 * Run `f` over `items` one at a time, in order, and keep what it answers.
 */
const inTurn = <A, B>(
  items: ReadonlyArray<A>,
  f: (item: A) => Promise<B | undefined>,
): Promise<Array<B>> =>
  Arr.reduce(items, Promise.resolve<Array<B>>([]), (previous, item) =>
    previous.then((kept) =>
      f(item).then((b) => (b === undefined ? kept : [...kept, b])),
    ),
  );

export interface Subscription {
  readonly id: string;
  /**
   * The latest run: its value and the dependencies it took.
   */
  readonly current: () => Run;
  readonly unsubscribe: () => void;
}

interface Live {
  readonly id: string;
  readonly subscriber: Subscriber;
  readonly reference: unknown;
  readonly args: unknown;
  run: Run;
}

/**
 * One client's query set. Its subscriptions share one caller, whose identity
 * `authenticate` replaces, bumping the identity version.
 */
export class Subscriber {
  private version: number;
  /**
   * The latest presented token's verification. A subscription waits for it, so
   * it never runs under the identity the token replaces.
   */
  private presented: Promise<void> = Promise.resolve();

  constructor(
    private readonly registry: Registry,
    private who: Execution.Caller,
    /**
     * Whether `Sync` pushes this subscriber's changes to a socket. Only `Sync`
     * refreshes such a subscriber, so a test's `refresh` never takes a change
     * the socket is owed.
     */
    readonly pushed = false,
  ) {
    this.version = registry.identityEpoch();
  }

  get caller(): Execution.Caller {
    return this.who;
  }

  get identityVersion(): number {
    return this.version;
  }

  subscribe(
    reference: unknown,
    args?: unknown,
    journal: string | null = null,
  ): Promise<Subscription> {
    return this.presented.then(() =>
      this.registry.subscribe(this, reference, args ?? {}, journal),
    );
  }

  /**
   * Present `token`, as the sync protocol's Authenticate does: the kernel
   * verifies it against the app's `auth.config` at its time, then the verified
   * identity replaces the caller's, bumping the identity version. A refused
   * token leaves the identity as it was and rejects with `InvalidToken`.
   */
  present(token: string): Promise<void> {
    // A later presentation replaces a refused one, so it starts clean. Until
    // then, a subscription rejects with the refusal rather than run under an
    // identity the client never had confirmed.
    const verified = this.presented
      .catch(() => undefined)
      .then(() => this.registry.verify(this.who, token))
      .then((caller) => this.become(caller));
    this.presented = verified;
    return verified;
  }

  /**
   * Replace the caller's identity, or sign it out with `null`. Each
   * subscription that read the identity is stale until the next refresh.
   */
  authenticate(identity: Partial<UserIdentity> | null) {
    this.become(
      identity === null
        ? { ...this.who, identity: null, token: null }
        : Execution.withIdentity(this.who, identity),
    );
  }

  private become(caller: Execution.Caller) {
    this.who = caller;
    this.version = this.registry.nextIdentityEpoch();
  }
}

/**
 * Every live subscription on one world. A commit or an identity change makes a
 * subscription stale. `refresh` reruns the stale ones, and `reference` reruns
 * every one from scratch to check that none was missed.
 */
export class Registry {
  private readonly live = new Map<string, Live>();
  private nextId = 1;
  /**
   * The binary's query cache, for the runs of the subscribers `Sync` pushes:
   * each result under its function, arguments, journal and, when it read the
   * identity, that identity (`crates/application/src/cache/mod.rs:151-230`).
   */
  private readonly cache = new Map<string, Execution.QueryRun>();

  constructor(
    private readonly world: Execution.World,
    /**
     * How long a cached result that read the time stays valid, in the kernel's
     * milliseconds: the binary's `MAX_CACHE_AGE`.
     */
    private readonly cacheAge: number = defaultCacheAge,
  ) {}

  subscriber(caller: Execution.Caller, pushed = false): Subscriber {
    this.world.registerSubscriber();
    return new Subscriber(this, caller, pushed);
  }

  /**
   * The caller `token` makes from `caller`, verified by the world.
   */
  verify(caller: Execution.Caller, token: string): Promise<Execution.Caller> {
    return this.world.authenticate(caller, token);
  }

  /**
   * The reference a live subscription runs, for marking its diffs by the shape
   * of what its query returns.
   */
  referenceOf(subscription: string): unknown {
    return this.live.get(subscription)?.reference;
  }

  /**
   * The world's identity epoch, where a new subscriber's version starts.
   */
  identityEpoch(): number {
    return this.world.currentIdentityEpoch();
  }

  /**
   * Advance the world's identity epoch for a subscriber whose identity changed.
   */
  nextIdentityEpoch(): number {
    return this.world.nextIdentityEpoch();
  }

  subscribe(
    subscriber: Subscriber,
    reference: unknown,
    args: unknown,
    journal: string | null,
  ): Promise<Subscription> {
    return this.run(subscriber, reference, args, { journal }).then((run) => {
      const live: Live = {
        id: `subscription-${this.nextId++}`,
        subscriber,
        reference,
        args,
        run,
      };
      this.live.set(live.id, live);
      return {
        id: live.id,
        // The run's value is the client's own, so it stays raw. Its read
        // records are the kernel's, so they leave projected.
        current: () => ({
          ...live.run,
          reads: this.world.projectReads(live.run.reads),
        }),
        unsubscribe: () => {
          this.live.delete(live.id);
        },
      };
    });
  }

  /**
   * The stale subscriptions of `subscriber`, or of every subscriber the test
   * refreshes, and why each is stale.
   */
  private staleOf(subscriber: Subscriber | undefined) {
    return Arr.flatMap(Array.from(this.live.values()), (live) => {
      if (
        subscriber === undefined
          ? live.subscriber.pushed
          : live.subscriber !== subscriber
      ) {
        return [];
      }
      const because = invalidation(
        live.run,
        this.world.state,
        live.subscriber.identityVersion,
        live.subscriber.pushed,
      );
      return because === undefined ? [] : [{ live, because }];
    });
  }

  /**
   * Whether any of `subscriber`'s subscriptions is stale now.
   */
  stale(subscriber: Subscriber): boolean {
    return this.staleOf(subscriber).length > 0;
  }

  /**
   * Rerun each stale subscription at the latest commit and the kernel's time
   * now, oldest first, until none is stale. Lists each one whose value changed.
   * With `subscriber`, only its subscriptions; without, every subscriber's but
   * those `Sync` pushes.
   */
  refresh(subscriber?: Subscriber): Promise<ReadonlyArray<Transition>> {
    const stale = this.staleOf(subscriber);
    if (stale.length === 0) return Promise.resolve([]);
    return inTurn(stale, ({ live, because }) =>
      this.run(live.subscriber, live.reference, live.args, {
        journal: live.run.journal,
      }).then((run): Transition | undefined => {
        if (this.live.get(live.id) !== live) return undefined;
        const from = live.run.outcome;
        live.run = run;
        return sameOutcome(from, run.outcome)
          ? undefined
          : { subscription: live.id, from, to: run.outcome, because };
      }),
    ).then((transitions) =>
      this.refresh(subscriber).then((later) => [...transitions, ...later]),
    );
  }

  /**
   * Rerun every subscription's query from scratch, at the latest commit and
   * under its subscriber's identity now, and list each whose value differs. A
   * paginated run keeps its page end.
   */
  reference(): Promise<ReadonlyArray<Disagreement>> {
    return inTurn(Array.from(this.live.values()), (live) =>
      this.rerun(live).then(({ outcome }): Disagreement | undefined =>
        sameOutcome(live.run.outcome, outcome)
          ? undefined
          : {
              subscription: live.id,
              incremental: live.run.outcome,
              reference: outcome,
            },
      ),
    );
  }

  /**
   * A full rerun of `live`'s query. A run that read the time first reruns at
   * that time, since the clock alone never invalidates it. When that rerun's
   * own reads show the run was owed a rerun, it reruns again at the kernel's
   * time now, as `refresh` would. The rerun was owed when a commit since the
   * run changed something the rerun read, or the rerun read an identity that
   * has changed since. The check reads neither the run's recorded reads nor
   * `invalidation`, so a dependency `refresh` missed still disagrees.
   */
  private rerun(live: Live): Promise<Run> {
    const { run } = live;
    const now = () =>
      this.run(live.subscriber, live.reference, live.args, {
        journal: run.journal,
      });
    if (run.time === null) return now();
    return this.run(live.subscriber, live.reference, live.args, {
      journal: run.journal,
      time: run.time,
    }).then((atRunTime) =>
      Kernel.conflict(this.world.state, run.snapshot, atRunTime.reads) !==
        undefined ||
      (atRunTime.observedIdentity &&
        atRunTime.identityVersion !== run.identityVersion)
        ? now()
        : atRunTime,
    );
  }

  private run(
    subscriber: Subscriber,
    reference: unknown,
    args: unknown,
    pinned: { readonly time?: number; readonly journal: string | null },
  ): Promise<Run> {
    const identityVersion = subscriber.identityVersion;
    const caching = subscriber.pushed && pinned.time === undefined;
    const key = (identity: Execution.Caller["identity"] | undefined) =>
      cacheKey(this.world, reference, args, identity, pinned.journal);
    if (caching) {
      const hit = Arr.findFirst(
        [key(subscriber.caller.identity), key(undefined)],
        (candidate) => this.valid(candidate),
      );
      if (hit._tag === "Some") {
        return Promise.resolve({
          ...this.cache.get(hit.value)!,
          identityVersion,
        });
      }
    }
    const caller = subscriber.caller;
    return this.world
      .subscribed(caller, reference, args, pinned)
      .then((run) => {
        if (caching) {
          const identity = run.observedIdentity ? caller.identity : undefined;
          this.cache.set(key(identity), run);
          if (run.journal !== pinned.journal) {
            this.cache.set(
              cacheKey(this.world, reference, args, identity, run.journal),
              run,
            );
          }
        }
        return { ...run, identityVersion };
      });
  }

  /**
   * Whether the cached result under `key` still answers for the latest commit
   * and the kernel's time: no commit since it ran changed what it read, and a
   * result that read the time is no older or newer than the cache age
   * (`crates/application/src/cache/mod.rs:768-823`). A stale one is dropped.
   */
  private valid(key: string): boolean {
    const cached = this.cache.get(key);
    if (cached === undefined) return false;
    const fresh =
      Kernel.conflict(this.world.state, cached.snapshot, cached.reads) ===
        undefined &&
      (cached.time === null ||
        Math.abs(this.world.now() - cached.time) <= this.cacheAge);
    if (!fresh) this.cache.delete(key);
    return fresh;
  }
}

/**
 * A cache key: the function, the canonical arguments, the identity when the
 * result read it (`undefined` when it did not), and the journal.
 */
const cacheKey = (
  world: Execution.World,
  reference: unknown,
  args: unknown,
  identity: Execution.Caller["identity"] | undefined,
  journal: string | null,
): string => {
  const path = world.functionPathOf(reference);
  return Json.stringify([
    path?.componentPath ?? "",
    path?.udfPath ?? "",
    Json.canonical(convexToJson((args ?? {}) as Value)),
    identity === undefined ? "any" : Json.canonical(identity ?? null),
    journal,
  ]);
};
