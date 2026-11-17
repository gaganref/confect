import { inspect } from "node:util";
import { it, expect, assert } from "@effect/vitest";
import * as Logger from "effect/Logger";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { PushLock } from "../src/internal/PushLock";
import * as Layer from "effect/Layer";
import * as ConvexClientModule from "@confect/alchemy/ConvexClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { adopt, Unowned } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as EnvironmentVariables from "@confect/alchemy/EnvironmentVariables";
import {
  ConvexApiError,
  ConvexClient,
  ConvexNotFound,
} from "@confect/alchemy/ConvexClient";
import { lifecycle, mockClient } from "./fixtures/ConvexClient";
import * as Record from "effect/Record";
import * as Str from "effect/String";

const props: EnvironmentVariables.EnvironmentVariablesProps = {
  url: "https://happy-otter-123.convex.cloud",
  deployKey: Redacted.make("test-key"),
  variables: { MANAGED: Redacted.make("desired-secret") },
};

it.effect("deletes idempotently when the deployment is already gone", () => {
  const mock = mockClient();
  return Effect.gen(function* () {
    const provider = yield* EnvironmentVariables.provider;
    yield* provider.delete({
      ...lifecycle,
      olds: props,
      output: {
        url: props.url,
        deployKey: props.deployKey,
        ownedNames: ["MANAGED"],
        variables: { MANAGED: Redacted.make("desired-secret") },
        originals: {},
      },
    });
    expect(mock.client.updateEnvironmentVariables).not.toHaveBeenCalled();
  }).pipe(
    Effect.provideService(ConvexClient, {
      ...mock.client,
      listEnvironmentVariables: () =>
        Effect.fail(
          ConvexNotFound.make({
            operation: "listEnvironmentVariables",
            status: 404,
            code: "HttpError",
          }),
        ),
    }),
  );
});

it.effect(
  "updates only differences, repairs drift, and preserves unrelated variables",
  () => {
    const mock = mockClient();
    mock.state.variables = { OTHER: Redacted.make("unrelated") };
    return Effect.gen(function* () {
      const services = yield* Layer.build(mock.layer);
      return yield* Effect.gen(function* () {
        const provider = yield* EnvironmentVariables.provider;
        const first = yield* provider.reconcile({
          ...lifecycle,
          news: props,
          olds: undefined,
          output: undefined,
        });
        const again = yield* provider.reconcile({
          ...lifecycle,
          news: props,
          olds: props,
          output: first,
        });
        expect(again).toEqual(first);
        expect(mock.client.updateEnvironmentVariables).toHaveBeenCalledTimes(1);
        expect(Redacted.value(mock.state.variables.OTHER)).toBe("unrelated");
        mock.state.variables.MANAGED = Redacted.make("drift");
        const observed = yield* provider.read({
          ...lifecycle,
          olds: props,
          output: first,
        });
        assert(observed);
        expect(Redacted.value(observed.variables.MANAGED)).toBe("drift");
        const diff2 = yield* provider.diff({
          ...lifecycle,
          olds: props,
          news: props,
          output: first,
          oldBindings: [],
          newBindings: [],
        });
        expect(diff2).toEqual({ action: "update" });
        yield* provider.reconcile({
          ...lifecycle,
          news: props,
          olds: props,
          output: observed,
        });
        expect(Redacted.value(mock.state.variables.MANAGED)).toBe(
          "desired-secret",
        );
        const encoded = yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.Unknown),
        )(first);
        expect(encoded).not.toContain("desired-secret");
        const encoded2 = yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.Unknown),
        )(first);
        expect(encoded2).not.toContain("test-key");
        yield* provider.delete({ ...lifecycle, olds: props, output: first });
        yield* provider.delete({ ...lifecycle, olds: props, output: first });
        expect(Record.keys(mock.state.variables)).toEqual(["OTHER"]);
        expect(mock.client.updateEnvironmentVariables).toHaveBeenCalledTimes(3);
      }).pipe(Effect.provideContext(services));
    });
  },
);

it.effect(
  "requires cold adoption and restores adopted values on release",
  () => {
    const mock = mockClient();
    mock.state.variables = {
      MANAGED: Redacted.make("original-secret"),
      OTHER: Redacted.make("unrelated"),
    };
    return Effect.gen(function* () {
      const services2 = yield* Layer.build(mock.layer);
      return yield* Effect.gen(function* () {
        const provider = yield* EnvironmentVariables.provider;
        const found = yield* provider.read({
          ...lifecycle,
          olds: props,
          output: undefined,
        });
        expect(Unowned.is(found)).toBe(true);
        const rejected = yield* Effect.flip(
          provider.reconcile({
            ...lifecycle,
            news: props,
            olds: undefined,
            output: undefined,
          }),
        );
        expect(rejected._tag).toBe("OwnedBySomeoneElse");
        const adopted = yield* provider.reconcile({
          ...lifecycle,
          news: props,
          olds: undefined,
          output: found,
        });
        expect(Redacted.value(adopted.originals.MANAGED)).toBe(
          "original-secret",
        );
        yield* provider.reconcile({
          ...lifecycle,
          news: { ...props, variables: {} },
          olds: props,
          output: adopted,
        });
        expect(Redacted.value(mock.state.variables.MANAGED)).toBe(
          "original-secret",
        );
        expect(Redacted.value(mock.state.variables.OTHER)).toBe("unrelated");
        mock.state.variables.MANAGED = Redacted.make("desired-secret");
        yield* provider.delete({ ...lifecycle, olds: props, output: adopted });
        expect(Redacted.value(mock.state.variables.MANAGED)).toBe(
          "original-secret",
        );
      }).pipe(Effect.provideContext(services2));
    });
  },
);

it.effect(
  "refuses target changes and newly introduced foreign variable collisions",
  () => {
    const mock = mockClient();
    return Effect.gen(function* () {
      const services3 = yield* Layer.build(mock.layer);
      return yield* Effect.gen(function* () {
        const provider = yield* EnvironmentVariables.provider;
        const first = yield* provider.reconcile({
          ...lifecycle,
          news: props,
          olds: undefined,
          output: undefined,
        });
        const target = yield* Effect.flip(
          provider.reconcile({
            ...lifecycle,
            news: {
              ...props,
              url: "https://token-in-url@other.convex.cloud/?key=secret-query",
            },
            olds: props,
            output: first,
          }),
        );
        expect(target._tag).toBe("EnvironmentTargetChange");
        const errorJson = yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.Unknown),
        )(target);
        expect(errorJson).not.toContain("token-in-url");
        expect(errorJson).not.toContain("secret-query");
        mock.state.variables.FOREIGN = Redacted.make("external");
        const collision = yield* Effect.flip(
          provider.reconcile({
            ...lifecycle,
            news: {
              ...props,
              variables: { ...props.variables, FOREIGN: "replacement" },
            },
            olds: props,
            output: first,
          }),
        );
        expect(collision._tag).toBe("OwnedBySomeoneElse");
        expect(Redacted.value(mock.state.variables.FOREIGN)).toBe("external");
        expect(mock.client.updateEnvironmentVariables).toHaveBeenCalledTimes(1);
      }).pipe(Effect.provideContext(services3));
    });
  },
);

it.effect(
  "removes only previously managed names when desired variables shrink",
  () => {
    const mock = mockClient();
    return Effect.gen(function* () {
      const services4 = yield* Layer.build(mock.layer);
      return yield* Effect.gen(function* () {
        const provider = yield* EnvironmentVariables.provider;
        const first = yield* provider.reconcile({
          ...lifecycle,
          news: props,
          olds: undefined,
          output: undefined,
        });
        mock.state.variables.OTHER = Redacted.make("external");
        const output = yield* provider.reconcile({
          ...lifecycle,
          news: { ...props, variables: { NEXT: "next" } },
          olds: props,
          output: first,
        });
        expect(output.ownedNames).toEqual(["NEXT"]);
        expect(Record.keys(mock.state.variables).sort()).toEqual([
          "NEXT",
          "OTHER",
        ]);
        expect(Redacted.isRedacted(output.variables.NEXT)).toBe(true);
        expect(props.variables).toHaveProperty("MANAGED");
      }).pipe(Effect.provideContext(services4));
    });
  },
);

it.effect(
  "treats prototype property names as ordinary environment variables",
  () => {
    const mock = mockClient();
    return Effect.gen(function* () {
      const services5 = yield* Layer.build(mock.layer);
      return yield* Effect.gen(function* () {
        const provider = yield* EnvironmentVariables.provider;
        const news = {
          ...props,
          variables: {
            constructor: "constructor-value",
            toString: "string-value",
          },
        };
        const read2 = yield* provider.read({
          ...lifecycle,
          olds: news,
          output: undefined,
        });
        expect(read2).toBeUndefined();
        const output = yield* provider.reconcile({
          ...lifecycle,
          news,
          olds: undefined,
          output: undefined,
        });
        const diff2 = yield* provider.diff({
          ...lifecycle,
          olds: news,
          news,
          output,
          oldBindings: [],
          newBindings: [],
        });
        expect(diff2).toBeUndefined();
        yield* provider.delete({ ...lifecycle, olds: news, output });
        expect(Record.keys(mock.state.variables)).toEqual([]);
      }).pipe(Effect.provideContext(services5));
    });
  },
);

it.effect(
  "leaves a stopped local backend's variables in its data instead of failing removal",
  () => {
    const mock = mockClient();
    const failure = (code: "TransportError" | "HttpError") =>
      Effect.provideService(ConvexClient, {
        ...mock.client,
        listEnvironmentVariables: () =>
          Effect.fail(
            ConvexApiError.make({
              operation: "listEnvironmentVariables",
              code,
              ...(code === "HttpError" ? { status: 500 } : {}),
            }),
          ),
      });
    const remove = Effect.gen(function* () {
      const provider = yield* EnvironmentVariables.localProvider;
      return yield* provider.delete({
        ...lifecycle,
        olds: { ...props, url: "http://127.0.0.1:3300" },
        output: {
          url: "http://127.0.0.1:3300",
          deployKey: props.deployKey,
          ownedNames: ["MANAGED"],
          variables: { MANAGED: Redacted.make("desired-secret") },
          originals: {},
        },
      });
    });
    return Effect.gen(function* () {
      const removeResult = yield* remove.pipe(
        failure("TransportError"),
        Effect.result,
      );
      expect(removeResult).toEqual(Result.succeed(undefined));
      const removeResult2 = yield* remove.pipe(
        failure("HttpError"),
        Effect.result,
      );
      expect(removeResult2).toEqual(
        Result.fail(
          ConvexApiError.make({
            operation: "listEnvironmentVariables",
            code: "HttpError",
            status: 500,
          }),
        ),
      );
    });
  },
);

const snapshot: EnvironmentVariables.EnvironmentVariablesAttributes = {
  url: props.url,
  deployKey: props.deployKey,
  ownedNames: ["MANAGED"],
  variables: { MANAGED: Redacted.make("last-written-secret") },
  originals: {},
};

it.effect.each(["read", "diff", "reconcile", "delete"] as const)(
  "refuses owned drift during %s without exposing values or refreshing the snapshot",
  (operation) => {
    const mock = mockClient();
    mock.state.variables = { MANAGED: Redacted.make("live-secret") };
    return Effect.gen(function* () {
      const provider = yield* EnvironmentVariables.provider;
      const safe = { ...props, driftPolicy: "error" as const };
      const input = { ...lifecycle, olds: safe, output: snapshot };
      const error = yield* Effect.gen(function* () {
        if (operation === "diff")
          return yield* provider.diff({
            ...input,
            news: { ...safe, variables: {} },
            oldBindings: [],
            newBindings: [],
          });
        if (operation === "reconcile")
          return yield* provider.reconcile({ ...input, news: safe });
        if (operation === "read") return yield* provider.read(input);
        return yield* provider.delete(input);
      }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "EnvironmentVariableDrift",
        variableName: "MANAGED",
      });
      const encoded = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Unknown),
      )(error);
      for (const secret of [
        "last-written-secret",
        "live-secret",
        "desired-secret",
        "test-key",
      ]) {
        expect(encoded).not.toContain(secret);
        expect(String(error)).not.toContain(secret);
        expect(inspect(error)).not.toContain(secret);
      }
      expect(Redacted.value(snapshot.variables.MANAGED)).toBe(
        "last-written-secret",
      );
      expect(mock.client.updateEnvironmentVariables).not.toHaveBeenCalled();
    }).pipe(Effect.provideService(ConvexClient, mock.client));
  },
);

it.effect(
  "checks resolved names before diff returns with other desired values unresolved",
  () => {
    const mock = mockClient();
    mock.state.variables = { MANAGED: Redacted.make("live-secret") };
    return Effect.gen(function* () {
      const provider = yield* EnvironmentVariables.provider;
      const safe = { ...props, driftPolicy: "error" as const };
      const error = yield* provider
        .diff({
          ...lifecycle,
          olds: safe,
          output: snapshot,
          news: {
            ...safe,
            variables: {
              MANAGED: "desired-secret",
              PENDING: Effect.succeed("unresolved-secret"),
            },
          },
          oldBindings: [],
          newBindings: [],
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "EnvironmentVariableDrift",
        variableName: "MANAGED",
      });
    }).pipe(Effect.provideService(ConvexClient, mock.client));
  },
);

it.effect(
  "allows desired changes when the live owned value still matches the last write",
  () => {
    const mock = mockClient();
    mock.state.variables = { ...snapshot.variables };
    return Effect.gen(function* () {
      const provider = yield* EnvironmentVariables.provider;
      const safe = { ...props, driftPolicy: "error" as const };
      const result = yield* provider.reconcile({
        ...lifecycle,
        olds: safe,
        news: safe,
        output: snapshot,
      });
      expect(Redacted.value(result.variables.MANAGED)).toBe("desired-secret");
    }).pipe(Effect.provideService(ConvexClient, mock.client));
  },
);

it.effect.each([false, true])(
  "adopts matching live names and logs only their names with general adoption=%s",
  (generalAdoption) => {
    const mock = mockClient();
    mock.state.variables = { MANAGED: Redacted.make("desired-secret") };
    const logs: unknown[] = [];
    return Effect.gen(function* () {
      const logging = yield* Layer.build(
        Logger.layer([
          Logger.make((event) => {
            logs.push(event.message);
          }),
        ]),
      );
      return yield* Effect.gen(function* () {
        const provider = yield* EnvironmentVariables.provider;
        const news = { ...props, adoptMatching: true };
        const found = yield* provider.read({
          ...lifecycle,
          olds: news,
          output: undefined,
        });
        expect(found).toBeUndefined();
        const output = yield* provider.reconcile({
          ...lifecycle,
          news,
          olds: undefined,
          output: undefined,
        });
        expect(output.ownedNames).toEqual(["MANAGED"]);
        expect(mock.client.updateEnvironmentVariables).not.toHaveBeenCalled();
        expect(inspect(logs)).toContain("Adopted environment variable MANAGED");
        expect(inspect(logs)).not.toContain("desired-secret");
        yield* provider.delete({ ...lifecycle, olds: news, output });
        expect(Redacted.value(mock.state.variables.MANAGED)).toBe(
          "desired-secret",
        );
      }).pipe(Effect.provideContext(logging));
    }).pipe(
      Effect.provideService(ConvexClient, mock.client),
      adopt(generalAdoption),
    );
  },
);

it.effect("does not adopt a live name with a different value", () => {
  const mock = mockClient();
  mock.state.variables = { MANAGED: Redacted.make("different-secret") };
  return Effect.gen(function* () {
    const provider = yield* EnvironmentVariables.provider;
    const error = yield* provider
      .reconcile({
        ...lifecycle,
        news: { ...props, adoptMatching: true },
        olds: undefined,
        output: undefined,
      })
      .pipe(Effect.flip);
    expect(error._tag).toBe("OwnedBySomeoneElse");
    expect(mock.client.updateEnvironmentVariables).not.toHaveBeenCalled();
  }).pipe(Effect.provideService(ConvexClient, mock.client));
});

it.effect.each(["read", "diff", "reconcile", "delete"] as const)(
  "refuses unrelated unowned names during %s",
  (operation) => {
    const mock = mockClient();
    mock.state.variables = {
      ...snapshot.variables,
      FOREIGN: Redacted.make("foreign-secret"),
    };
    return Effect.gen(function* () {
      const provider = yield* EnvironmentVariables.provider;
      const safe = { ...props, unownedPolicy: "error" as const };
      const input = { ...lifecycle, olds: safe, output: snapshot };
      const error = yield* Effect.gen(function* () {
        if (operation === "read") return yield* provider.read(input);
        if (operation === "delete") return yield* provider.delete(input);
        if (operation === "reconcile")
          return yield* provider.reconcile({ ...input, news: safe });
        return yield* provider.diff({
          ...input,
          news: { ...safe, variables: {} },
          oldBindings: [],
          newBindings: [],
        });
      }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "EnvironmentVariableUnowned",
        variableName: "FOREIGN",
      });
      expect(inspect(error)).not.toContain("foreign-secret");
      expect(mock.client.updateEnvironmentVariables).not.toHaveBeenCalled();
    }).pipe(Effect.provideService(ConvexClient, mock.client));
  },
);

it.effect.each([
  {
    serverCode: "OptimisticConcurrencyControlFailure",
    status: 503,
    failures: 2,
    maxAttempts: 3,
    expected: 3,
  },
  {
    serverCode: "OptimisticConcurrencyControlFailure",
    status: 503,
    failures: 10,
    maxAttempts: 3,
    expected: 3,
  },
  {
    serverCode: "OtherFailure",
    status: 503,
    failures: 10,
    maxAttempts: 3,
    expected: 1,
  },
  {
    serverCode: undefined,
    status: 503,
    failures: 10,
    maxAttempts: 3,
    expected: 1,
  },
  {
    serverCode: "BadRequest",
    status: 400,
    failures: 10,
    maxAttempts: 3,
    expected: 1,
  },
  {
    serverCode: "OptimisticConcurrencyControlFailure",
    status: 503,
    failures: 10,
    maxAttempts: undefined,
    expected: 1,
  },
])(
  "bounds retries to the server write-conflict code ($serverCode, $status, $maxAttempts)",
  ({ serverCode, status, failures, maxAttempts, expected }) => {
    const mock = mockClient();
    let attempts = 0;
    const client = {
      ...mock.client,
      updateEnvironmentVariables: (
        ...args: Parameters<typeof mock.client.updateEnvironmentVariables>
      ) =>
        Effect.suspend(() => {
          attempts++;
          return attempts <= failures
            ? Effect.fail(
                ConvexApiError.make({
                  operation: "updateEnvironmentVariables",
                  code: "HttpError",
                  status,
                  ...(serverCode === undefined ? {} : { serverCode }),
                }),
              )
            : mock.client.updateEnvironmentVariables(...args);
        }),
    };
    return Effect.gen(function* () {
      const provider = yield* EnvironmentVariables.provider;
      const news = {
        ...props,
        ...(maxAttempts === undefined
          ? {}
          : { retry: { maxAttempts, delay: "100 millis" as const } }),
      };
      const fiber = yield* provider
        .reconcile({ ...lifecycle, news, olds: undefined, output: undefined })
        .pipe(Effect.result, Effect.forkScoped);
      yield* TestClock.adjust("1 second");
      const result = yield* Fiber.join(fiber);
      expect(attempts).toBe(expected);
      expect(mock.client.listEnvironmentVariables).toHaveBeenCalledTimes(
        expected,
      );
      expect(Result.isSuccess(result)).toBe(failures < expected);
    }).pipe(Effect.provideService(ConvexClient, client));
  },
);

it.effect.each(["reconcile", "delete"] as const)(
  "rechecks drift after a write conflict during %s",
  (operation) => {
    const mock = mockClient();
    mock.state.variables = { ...snapshot.variables };
    let attempts = 0;
    const client = {
      ...mock.client,
      updateEnvironmentVariables: () =>
        Effect.suspend(() => {
          attempts++;
          mock.state.variables.MANAGED = Redacted.make("external-secret");
          return Effect.fail(
            ConvexApiError.make({
              operation: "updateEnvironmentVariables",
              code: "HttpError",
              status: 503,
              serverCode: "OptimisticConcurrencyControlFailure",
            }),
          );
        }),
    };
    return Effect.gen(function* () {
      const provider = yield* EnvironmentVariables.provider;
      const safe = {
        ...props,
        driftPolicy: "error" as const,
        retry: { maxAttempts: 3, delay: "100 millis" as const },
      };
      const input = { ...lifecycle, olds: safe, output: snapshot };
      const effect = Effect.gen(function* () {
        if (operation === "delete") return yield* provider.delete(input);
        return yield* provider.reconcile({ ...input, news: safe });
      });
      const fiber = yield* effect.pipe(Effect.flip, Effect.forkScoped);
      yield* TestClock.adjust("1 second");
      const error = yield* Fiber.join(fiber);
      expect(error).toMatchObject({
        _tag: "EnvironmentVariableDrift",
        variableName: "MANAGED",
      });
      expect(attempts).toBe(1);
      expect(mock.client.listEnvironmentVariables).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provideService(ConvexClient, client));
  },
);

it.effect.each(["diff", "read", "reconcile", "delete"] as const)(
  "holds the deployment push lock throughout %s",
  (operation) => {
    const mock = mockClient();
    mock.state.variables = { ...snapshot.variables };
    let held = false;
    const client = {
      ...mock.client,
      listEnvironmentVariables: () =>
        Effect.suspend(() => {
          expect(held).toBe(true);
          return mock.client.listEnvironmentVariables();
        }),
      updateEnvironmentVariables: (
        ...args: Parameters<typeof mock.client.updateEnvironmentVariables>
      ) =>
        Effect.suspend(() => {
          expect(held).toBe(true);
          return mock.client.updateEnvironmentVariables(...args);
        }),
    };
    return Effect.gen(function* () {
      const provider = yield* EnvironmentVariables.provider;
      const safe = {
        ...props,
        lock: { deploymentName: "happy-otter-123" },
        driftPolicy: "error" as const,
      };
      const input = { ...lifecycle, olds: safe, output: snapshot };
      if (operation === "diff")
        yield* provider.diff({
          ...input,
          news: safe,
          oldBindings: [],
          newBindings: [],
        });
      else if (operation === "read") yield* provider.read(input);
      else if (operation === "delete") yield* provider.delete(input);
      else yield* provider.reconcile({ ...input, news: safe });
      expect(held).toBe(false);
    }).pipe(
      Effect.provideService(ConvexClient, client),
      Effect.provideService(PushLock, {
        withLock: (deploymentName, effect) => {
          expect(deploymentName).toBe("happy-otter-123");
          return Effect.acquireUseRelease(
            Effect.sync(() => {
              held = true;
            }),
            () => effect,
            () =>
              Effect.sync(() => {
                held = false;
              }),
          );
        },
      }),
    );
  },
);

it.effect.each([
  { maxAttempts: 0, delay: 100, option: "maxAttempts" },
  { maxAttempts: 11, delay: 100, option: "maxAttempts" },
  { maxAttempts: 1.5, delay: 100, option: "maxAttempts" },
  { maxAttempts: Number.NaN, delay: 100, option: "maxAttempts" },
  { maxAttempts: 3, delay: 0, option: "delay" },
  { maxAttempts: 3, delay: 10001, option: "delay" },
  { maxAttempts: 3, delay: Number.POSITIVE_INFINITY, option: "delay" },
])(
  "rejects an invalid retry $option before touching the deployment ($maxAttempts, $delay)",
  ({ maxAttempts, delay, option }) => {
    const mock = mockClient();
    return Effect.gen(function* () {
      const provider = yield* EnvironmentVariables.provider;
      const error = yield* provider
        .reconcile({
          ...lifecycle,
          olds: undefined,
          output: undefined,
          news: { ...props, retry: { maxAttempts, delay } },
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "EnvironmentVariablesInvalidOption",
        option,
      });
      expect(mock.client.listEnvironmentVariables).not.toHaveBeenCalled();
      expect(mock.client.updateEnvironmentVariables).not.toHaveBeenCalled();
    }).pipe(Effect.provideService(ConvexClient, mock.client));
  },
);

it.effect.each([
  { maxAttempts: 1, delay: "100 millis" as const },
  { maxAttempts: 10, delay: "100 millis" as const },
  { maxAttempts: 3, delay: 10000 },
])(
  "accepts retry maxAttempts=$maxAttempts and delay=$delay",
  ({ maxAttempts, delay }) => {
    const mock = mockClient();
    return Effect.gen(function* () {
      const provider = yield* EnvironmentVariables.provider;
      const output = yield* provider.reconcile({
        ...lifecycle,
        olds: undefined,
        output: undefined,
        news: { ...props, retry: { maxAttempts, delay } },
      });
      expect(output.ownedNames).toEqual(["MANAGED"]);
    }).pipe(Effect.provideService(ConvexClient, mock.client));
  },
);

it.effect(
  "fails a requested lock explicitly when no push-lock service was provided",
  () => {
    const mock = mockClient();
    return Effect.gen(function* () {
      const provider = yield* EnvironmentVariables.provider;
      const error = yield* provider
        .reconcile({
          ...lifecycle,
          olds: undefined,
          output: undefined,
          news: { ...props, lock: { deploymentName: "happy-otter-123" } },
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "PushLockError",
        deploymentName: "happy-otter-123",
        reason: "configuration",
      });
      expect(error.message).toBe(
        "Push lock for happy-otter-123 needs the PushLock service to be provided",
      );
      expect(mock.client.listEnvironmentVariables).not.toHaveBeenCalled();
    }).pipe(Effect.provideService(ConvexClient, mock.client));
  },
);

it.effect.each(["drift", "unowned", "lock"] as const)(
  "honors a newly enabled %s option when desired values remain unresolved",
  (option) => {
    const mock = mockClient();
    mock.state.variables = {
      MANAGED: Redacted.make(
        option === "drift" ? "live-secret" : "last-written-secret",
      ),
      FOREIGN: Redacted.make("foreign-secret"),
    };
    let held = false;
    let locks = 0;
    const client = {
      ...mock.client,
      listEnvironmentVariables: () =>
        Effect.suspend(() => {
          if (option === "lock") expect(held).toBe(true);
          return mock.client.listEnvironmentVariables();
        }),
    };
    return Effect.gen(function* () {
      const provider = yield* EnvironmentVariables.provider;
      const result = yield* provider
        .diff({
          ...lifecycle,
          olds: props,
          output: snapshot,
          news: {
            ...props,
            variables:
              option === "drift"
                ? {
                    MANAGED: "desired-secret",
                    PENDING: Effect.succeed("unresolved-secret"),
                  }
                : { MANAGED: Effect.succeed("unresolved-secret") },
            ...(option === "drift" ? { driftPolicy: "error" as const } : {}),
            ...(option === "unowned"
              ? { unownedPolicy: "error" as const }
              : {}),
            ...(option === "lock"
              ? { lock: { deploymentName: "happy-otter-123" } }
              : {}),
          },
          oldBindings: [],
          newBindings: [],
        })
        .pipe(Effect.result);
      if (option === "lock") {
        expect(Result.isSuccess(result)).toBe(true);
        expect(locks).toBe(1);
      } else {
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(result.failure).toMatchObject({
            _tag:
              option === "drift"
                ? "EnvironmentVariableDrift"
                : "EnvironmentVariableUnowned",
            variableName: option === "drift" ? "MANAGED" : "FOREIGN",
          });
      }
      expect(mock.client.updateEnvironmentVariables).not.toHaveBeenCalled();
    }).pipe(
      Effect.provideService(ConvexClient, client),
      Effect.provideService(PushLock, {
        withLock: (_name, effect) =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              held = true;
              locks++;
            }),
            () => effect,
            () =>
              Effect.sync(() => {
                held = false;
              }),
          ),
      }),
    );
  },
);

it.effect(
  "recognizes new desired names while their values remain unresolved",
  () => {
    const mock = mockClient();
    mock.state.variables = {
      ...snapshot.variables,
      NEW: Redacted.make("new-secret"),
    };
    return Effect.gen(function* () {
      const provider = yield* EnvironmentVariables.provider;
      const safe = { ...props, unownedPolicy: "error" as const };
      yield* provider.diff({
        ...lifecycle,
        olds: safe,
        output: snapshot,
        news: {
          ...safe,
          variables: {
            MANAGED: Effect.succeed("unresolved-secret"),
            NEW: Effect.succeed("new-secret"),
          },
        },
        oldBindings: [],
        newBindings: [],
      });
      expect(mock.client.updateEnvironmentVariables).not.toHaveBeenCalled();
    }).pipe(Effect.provideService(ConvexClient, mock.client));
  },
);

it.effect(
  "defers unowned-name checks until an unresolved desired map exposes its names",
  () => {
    const mock = mockClient();
    mock.state.variables = {
      ...snapshot.variables,
      NEW: Redacted.make("new-secret"),
    };
    return Effect.gen(function* () {
      const provider = yield* EnvironmentVariables.provider;
      const safe = { ...props, unownedPolicy: "error" as const };
      yield* provider.diff({
        ...lifecycle,
        olds: safe,
        output: snapshot,
        news: {
          ...safe,
          variables: Effect.succeed({
            MANAGED: "desired-secret",
            NEW: "new-secret",
          }),
        },
        oldBindings: [],
        newBindings: [],
      });
      const error = yield* provider
        .diff({
          ...lifecycle,
          olds: safe,
          output: snapshot,
          news: safe,
          oldBindings: [],
          newBindings: [],
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "EnvironmentVariableUnowned",
        variableName: "NEW",
      });
      expect(mock.client.updateEnvironmentVariables).not.toHaveBeenCalled();
    }).pipe(Effect.provideService(ConvexClient, mock.client));
  },
);

it.effect.each([
  { code: "OptimisticConcurrencyControlFailure", expected: 3 },
  { code: "OtherFailure", expected: 1 },
  { code: "prod:happy-otter-123|planted-secret", expected: 1 },
])(
  "retries only a validated HTTP conflict identifier ($expected attempts)",
  ({ code, expected }) => {
    let attempts = 0;
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        const isRead = Str.endsWith("list_environment_variables")(request.url);
        if (!isRead) attempts++;
        const response = isRead
          ? Response.json({ environmentVariables: {} })
          : Response.json({ code, message: "planted-secret" }, { status: 503 });
        return HttpClientResponse.fromWeb(request, response);
      }),
    );
    return Effect.gen(function* () {
      const services = yield* Layer.build(
        ConvexClientModule.layer().pipe(
          Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
        ),
      );
      return yield* Effect.gen(function* () {
        const provider = yield* EnvironmentVariables.provider;
        const fiber = yield* provider
          .reconcile({
            ...lifecycle,
            olds: undefined,
            output: undefined,
            news: { ...props, retry: { maxAttempts: 3, delay: "100 millis" } },
          })
          .pipe(Effect.result, Effect.forkScoped);
        yield* TestClock.adjust("1 second");
        const result = yield* Fiber.join(fiber);
        expect(Result.isFailure(result)).toBe(true);
        expect(attempts).toBe(expected);
        expect(inspect(result)).not.toContain("planted-secret");
      }).pipe(Effect.provideContext(services));
    });
  },
);

it.effect.each(["", "../../escape", "Happy-Otter-123", "happy-otter-123"])(
  "validates the deployment lock name before acquiring it (%s)",
  (deploymentName) => {
    const mock = mockClient();
    let locks = 0;
    return Effect.gen(function* () {
      const provider = yield* EnvironmentVariables.provider;
      const result = yield* provider
        .reconcile({
          ...lifecycle,
          olds: undefined,
          output: undefined,
          news: { ...props, lock: { deploymentName } },
        })
        .pipe(Effect.result);
      if (deploymentName === "happy-otter-123") {
        expect(Result.isSuccess(result)).toBe(true);
        expect(locks).toBe(1);
      } else {
        if (Result.isSuccess(result))
          return expect.unreachable("Expected an invalid lock name");
        expect(result.failure).toMatchObject({
          _tag: "EnvironmentVariablesInvalidOption",
          option: "deploymentName",
        });
        expect(inspect(result.failure)).not.toContain(
          deploymentName || "desired-secret",
        );
        expect(locks).toBe(0);
        expect(mock.client.listEnvironmentVariables).not.toHaveBeenCalled();
        expect(mock.client.updateEnvironmentVariables).not.toHaveBeenCalled();
      }
    }).pipe(
      Effect.provideService(ConvexClient, mock.client),
      Effect.provideService(PushLock, {
        withLock: (_name, effect) =>
          Effect.sync(() => {
            locks++;
          }).pipe(Effect.andThen(effect)),
      }),
    );
  },
);
