import { it, expect } from "@effect/vitest";
import { Stack } from "alchemy/Stack";
import { InMemoryService } from "alchemy/State/InMemoryState";
import type {
  CreatingResourceState,
  ResourceState,
  UpdatingReourceState,
} from "alchemy/State/ResourceState";
import {
  State,
  StateStoreError,
  type PersistedState,
} from "alchemy/State/State";
import * as Effect from "effect/Effect";
import { checkpointCreate, checkpointUpdate } from "../src/internal/Lifecycle";

const stack = {
  name: "test",
  stage: "test",
  resources: {},
  bindings: {},
  actions: {},
};
const creating = (): CreatingResourceState => ({
  status: "creating",
  fqn: "Key",
  logicalId: "Key",
  instanceId: "instance",
  resourceType: "Convex.DeployKey",
  namespace: undefined,
  providerVersion: 0,
  downstream: ["Backend"],
  bindings: [],
  removalPolicy: "destroy",
  props: {},
});

it.effect(
  "checkpoints resolved inputs and adoption output without changing the original row",
  () =>
    Effect.gen(function* () {
      const original = creating();
      const store = yield* InMemoryService({
        test: { test: { Key: original } },
      });
      const props = { deploymentName: "happy-otter-123" };
      const output = { name: "adopted" };
      yield* checkpointCreate("Key", "instance", props, output).pipe(
        Effect.provideService(Stack, stack),
        Effect.provideService(State, Effect.succeed(store)),
      );
      const saved = yield* store.get({
        stack: "test",
        stage: "test",
        fqn: "Key",
      });
      expect(saved).toEqual({ ...original, props, attr: output });
      expect(original.props).toEqual({});
      expect(original.attr).toBeUndefined();
    }),
);

it.effect("refuses a checkpoint for another resource incarnation", () =>
  Effect.gen(function* () {
    const original = creating();
    const store = yield* InMemoryService({ test: { test: { Key: original } } });
    const error = yield* checkpointCreate("Key", "other-instance", {}).pipe(
      Effect.provideService(Stack, stack),
      Effect.provideService(State, Effect.succeed(store)),
      Effect.flip,
    );
    expect(error._tag).toBe("LifecycleStateError");
    const get2 = yield* store.get({ stack: "test", stage: "test", fqn: "Key" });
    expect(get2).toBe(original);
  }),
);

it.effect(
  "propagates checkpoint failures instead of running a cloud mutation",
  () =>
    Effect.gen(function* () {
      const store = yield* InMemoryService({
        test: { test: { Key: creating() } },
      });
      let mutated = false;
      const error = yield* checkpointCreate("Key", "instance", {}).pipe(
        Effect.andThen(
          Effect.sync(() => {
            mutated = true;
          }),
        ),
        Effect.provideService(Stack, stack),
        Effect.provideService(
          State,
          Effect.succeed({
            ...store,
            set: () =>
              Effect.fail(new StateStoreError({ message: "unavailable" })),
          }),
        ),
        Effect.flip,
      );
      expect(error._tag).toBe("StateStoreError");
      expect(mutated).toBe(false);
    }),
);

const updating = (): UpdatingReourceState => ({
  ...creating(),
  status: "updating",
  props: { canonical: true },
  attr: { canonical: false },
  old: {
    props: { canonical: false },
    attr: { canonical: false },
    bindings: [],
  },
});

it.effect(
  "checkpoints update output only on its own row without mutating it",
  () =>
    Effect.gen(function* () {
      const original = updating();
      const sibling = { ...updating(), fqn: "Sibling", logicalId: "Sibling" };
      const store = yield* InMemoryService({
        test: { test: { Key: original, Sibling: sibling } },
      });
      const output = { canonical: true };
      yield* checkpointUpdate("Key", "instance", output).pipe(
        Effect.provideService(Stack, stack),
        Effect.provideService(State, Effect.succeed(store)),
      );
      const saved = yield* store.get({
        stack: "test",
        stage: "test",
        fqn: "Key",
      });
      expect(saved).toEqual({ ...original, attr: output });
      expect(original.attr).toEqual({ canonical: false });
      const other = yield* store.get({
        stack: "test",
        stage: "test",
        fqn: "Sibling",
      });
      expect(other).toBe(sibling);
    }),
);

it.effect.each(["missing", "action", "other-instance"] as const)(
  "refuses an update checkpoint for a %s row",
  (scenario) =>
    Effect.gen(function* () {
      const original: PersistedState | undefined =
        scenario === "missing"
          ? undefined
          : scenario === "action"
            ? {
                kind: "action",
                actionType: "Test",
                namespace: undefined,
                fqn: "Key",
                logicalId: "Key",
                status: "running",
                downstream: [],
                inputHash: "test",
                input: {},
              }
            : { ...updating(), instanceId: "other-instance" };
      const store = yield* InMemoryService();
      if (original !== undefined)
        yield* store.set({
          stack: "test",
          stage: "test",
          fqn: "Key",
          value: original,
        });
      const error = yield* checkpointUpdate("Key", "instance", {
        canonical: true,
      }).pipe(
        Effect.provideService(Stack, stack),
        Effect.provideService(State, Effect.succeed(store)),
        Effect.flip,
      );
      expect(error).toMatchObject({ _tag: "LifecycleStateError", fqn: "Key" });
      const saved = yield* store.get({
        stack: "test",
        stage: "test",
        fqn: "Key",
      });
      expect(saved).toBe(original);
    }),
);

it.effect("leaves every non-updating lifecycle row unchanged", () =>
  Effect.gen(function* () {
    const base = { ...creating(), attr: { canonical: false } };
    const rows: ResourceState[] = [
      base,
      { ...base, status: "created" },
      { ...base, status: "updated" },
      { ...base, status: "deleting" },
      { ...base, status: "replacing", old: base, deleteFirst: false },
      { ...base, status: "replaced", old: base, deleteFirst: false },
    ];
    for (const original of rows) {
      const store = yield* InMemoryService({
        test: { test: { Key: original } },
      });
      yield* checkpointUpdate("Key", "instance", { canonical: true }).pipe(
        Effect.provideService(Stack, stack),
        Effect.provideService(State, Effect.succeed(store)),
      );
      const saved = yield* store.get({
        stack: "test",
        stage: "test",
        fqn: "Key",
      });
      expect(saved).toBe(original);
    }
  }),
);

it.effect("propagates update checkpoint failure before a cloud mutation", () =>
  Effect.gen(function* () {
    const original = updating();
    const store = yield* InMemoryService({ test: { test: { Key: original } } });
    let mutated = false;
    const error = yield* checkpointUpdate("Key", "instance", {
      canonical: true,
    }).pipe(
      Effect.andThen(
        Effect.sync(() => {
          mutated = true;
        }),
      ),
      Effect.provideService(Stack, stack),
      Effect.provideService(
        State,
        Effect.succeed({
          ...store,
          set: () =>
            Effect.fail(new StateStoreError({ message: "unavailable" })),
        }),
      ),
      Effect.flip,
    );
    expect(error._tag).toBe("StateStoreError");
    expect(mutated).toBe(false);
    const saved = yield* store.get({
      stack: "test",
      stage: "test",
      fqn: "Key",
    });
    expect(saved).toBe(original);
  }),
);
