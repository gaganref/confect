import type { UserIdentity } from "convex/server";
import { compareValues, convexToJson, type Value } from "convex/values";
import * as Execution from "./Execution.js";
import * as Kernel from "./Kernel.js";

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
 * it read, as an attempt's read set conflicts, or it read its subscriber's
 * identity and that identity has changed. The clock never makes a run stale.
 * The binary does not rerun a query because time passed, so a run keeps the
 * time it read until something else invalidates it.
 */
export const invalidation = (
  run: Run,
  state: Kernel.State,
  identityVersion: number,
): Invalidation | undefined => {
  const change = Kernel.conflict(state, run.snapshot, run.reads);
  if (change !== undefined) return { kind: "commit", change };
  if (run.observedIdentity && run.identityVersion !== identityVersion) {
    return { kind: "identity", from: run.identityVersion, to: identityVersion };
  }
  return undefined;
};

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
  JSON.stringify(
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
  items.reduce<Promise<Array<B>>>(
    (previous, item) =>
      previous.then((kept) =>
        f(item).then((b) => (b === undefined ? kept : [...kept, b])),
      ),
    Promise.resolve([]),
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

  constructor(
    private readonly registry: Registry,
    private who: Execution.Caller,
  ) {
    this.version = registry.identityEpoch();
  }

  get caller(): Execution.Caller {
    return this.who;
  }

  get identityVersion(): number {
    return this.version;
  }

  subscribe(reference: unknown, args?: unknown): Promise<Subscription> {
    return this.registry.subscribe(this, reference, args ?? {});
  }

  /**
   * Replace the caller's identity, or sign it out with `null`. Each
   * subscription that read the identity is stale until the next refresh.
   */
  authenticate(identity: Partial<UserIdentity> | null) {
    this.who =
      identity === null
        ? { ...this.who, identity: null, token: null }
        : Execution.withIdentity(this.who, identity);
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

  constructor(private readonly world: Execution.World) {}

  subscriber(caller: Execution.Caller): Subscriber {
    this.world.registerSubscriber();
    return new Subscriber(this, caller);
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
  ): Promise<Subscription> {
    return this.run(subscriber, reference, args, { journal: null }).then(
      (run) => {
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
          current: () => live.run,
          unsubscribe: () => {
            this.live.delete(live.id);
          },
        };
      },
    );
  }

  /**
   * Rerun each stale subscription at the latest commit and the kernel's time
   * now, oldest first, until none is stale. Lists each one whose value
   * changed.
   */
  refresh(): Promise<ReadonlyArray<Transition>> {
    const stale = Array.from(this.live.values()).flatMap((live) => {
      const because = invalidation(
        live.run,
        this.world.state,
        live.subscriber.identityVersion,
      );
      return because === undefined ? [] : [{ live, because }];
    });
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
      this.refresh().then((later) => [...transitions, ...later]),
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
    return this.world
      .subscribed(subscriber.caller, reference, args, pinned)
      .then((run) => ({ ...run, identityVersion }));
  }
}
