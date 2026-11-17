import * as UsageLimit from "@confect/alchemy/UsageLimit";
import {
  ConvexApiError,
  ConvexClient,
  type UsageLimit as Limit,
} from "@confect/alchemy/ConvexClient";
import { Providers } from "@confect/alchemy/Providers";
import { expect, it } from "@effect/vitest";
import * as Provider from "alchemy/Provider";
import { StateStoreError } from "alchemy/State/State";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Array from "effect/Array";
import { inspect } from "node:util";
import { makeEngine } from "../fixtures/Engine";
import { mockClient } from "../fixtures/ConvexClient";

const props: UsageLimit.UsageLimitProps = {
  deployment: { name: "paid-cloud", url: "https://paid-cloud.convex.cloud" },
  metric: "functionCalls",
  window: "month",
  limit: 100000,
};
const resource = (news = props) =>
  Effect.gen(function* () {
    const limit = yield* UsageLimit.UsageLimit("Limit", news);
    return { id: limit.id, deployment: limit.deployment, limit: limit.limit };
  });
const providers = (client: Layer.Layer<ConvexClient>) =>
  Layer.effect(Providers, Provider.collection([UsageLimit.UsageLimit])).pipe(
    Layer.provide(UsageLimit.layer),
    Layer.provide(client),
  );

it.effect.each([false, true])(
  "recovers a lost create response with adoption=%s",
  (adopt) =>
    Effect.gen(function* () {
      const fixture = mockClient({ deployKey: "made-up-never-output-token" });
      const engine = yield* makeEngine(
        Layer.succeed(ConvexClient, {
          ...fixture.client,
          createUsageLimit: (url, input) =>
            fixture.client.createUsageLimit(url, input).pipe(
              Effect.andThen(
                Effect.fail(
                  ConvexApiError.make({
                    operation: "createUsageLimit",
                    code: "TransportError",
                  }),
                ),
              ),
            ),
        }).pipe(providers),
      );
      const first = yield* engine.run(resource()).pipe(Effect.result);
      expect(first).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConvexApiError" },
      });
      expect(fixture.state.limits).toHaveLength(1);
      const second = yield* engine
        .run(resource(), { adopt })
        .pipe(Effect.result);
      if (adopt) {
        expect(second).toEqual(
          Result.succeed({
            id: "limit-1",
            deployment: props.deployment,
            limit: 100000,
          }),
        );
        yield* engine.run(resource());
        const rows = yield* engine.rows();
        expect(rows).toMatchObject([
          { status: "created", attr: { id: "limit-1" } },
        ]);
      } else {
        expect(second).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "OwnedBySomeoneElse",
            message: expect.stringContaining("--adopt"),
          },
        });
      }
      expect(fixture.state.limits).toHaveLength(1);
      expect(fixture.client.createUsageLimit).toHaveBeenCalledTimes(1);
      const rows = yield* engine.rows();
      expect(
        inspect([first, second, engine.logs, engine.plans, rows]),
      ).not.toContain("made-up-never-output-token");
    }),
);

it.effect("keeps the create checkpoint when the final state write fails", () =>
  Effect.gen(function* () {
    const fixture = mockClient();
    let reject = true;
    const engine = yield* makeEngine(providers(fixture.layer), (store) => ({
      ...store,
      set: (request) =>
        Effect.suspend(() => {
          if (request.value.status === "created" && reject) {
            reject = false;
            return Effect.fail(
              new StateStoreError({ message: "Injected final state failure" }),
            );
          }
          return store.set(request);
        }),
    }));
    const result = yield* engine.run(resource()).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    const interrupted = yield* engine.rows();
    expect(interrupted).toMatchObject([
      { status: "creating", attr: { id: "limit-1" } },
    ]);
    yield* engine.run(resource());
    expect(fixture.client.createUsageLimit).toHaveBeenCalledTimes(1);
    const saved = yield* engine.rows();
    expect(saved).toMatchObject([
      { status: "created", attr: { id: "limit-1" } },
    ]);
  }),
);

it.effect("replaces a target that changes only its URL", () =>
  Effect.gen(function* () {
    const fixture = mockClient();
    const limits = new Map<string, Limit[]>();
    let nextId = 0;
    const client = Layer.succeed(ConvexClient, {
      ...fixture.client,
      listUsageLimits: (url) => Effect.sync(() => limits.get(url) ?? []),
      createUsageLimit: (url, input) =>
        Effect.sync(() => {
          const created = { ...input, id: `limit-${++nextId}` };
          limits.set(url, [...(limits.get(url) ?? []), created]);
          return created;
        }),
      deleteUsageLimit: (url, id) =>
        Effect.sync(() => {
          limits.set(
            url,
            Array.filter(limits.get(url) ?? [], (limit) => limit.id !== id),
          );
        }),
    });
    const engine = yield* makeEngine(client.pipe(providers));
    yield* engine.run(resource());
    const news = {
      ...props,
      deployment: { ...props.deployment, url: "https://other.convex.cloud" },
    };
    const output = yield* engine.run(resource(news));
    expect(engine.plans.at(-1)).toEqual([
      { fqn: "Limit", action: "replace", deleteFirst: false },
    ]);
    expect(output).toEqual({
      id: "limit-2",
      deployment: news.deployment,
      limit: 100000,
    });
    expect(limits.get(props.deployment.url)).toEqual([]);
    expect(limits.get(news.deployment.url)).toHaveLength(1);
    yield* engine.run(resource(news));
    const saved = yield* engine.rows();
    expect(saved).toHaveLength(1);
  }),
);

it.effect.each([0, -5, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "rejects limit %s during plan without an API call",
  (limit) =>
    Effect.gen(function* () {
      const fixture = mockClient();
      const engine = yield* makeEngine(fixture.layer.pipe(providers));
      const result = yield* engine
        .run(resource({ ...props, limit }), { apply: false })
        .pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "InvalidUsageLimit" },
      });
      expect(fixture.client.listUsageLimits).not.toHaveBeenCalled();
      expect(fixture.client.createUsageLimit).not.toHaveBeenCalled();
    }),
);
