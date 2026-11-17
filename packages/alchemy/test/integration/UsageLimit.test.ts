import * as UsageLimit from "@confect/alchemy/UsageLimit";
import {
  ConvexApiError,
  ConvexClient,
  layer as clientLayer,
  type UsageLimit as Limit,
} from "@confect/alchemy/ConvexClient";
import { Providers } from "@confect/alchemy/Providers";
import { expect, it } from "@effect/vitest";
import * as Provider from "alchemy/Provider";
import { StateStoreError } from "alchemy/State/State";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
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

it.effect("creates a changed deployment before deleting the old limit", () =>
  Effect.gen(function* () {
    const fixture = mockClient();
    const limits = new Map<string, Limit[]>();
    let nextId = 0;
    const events: string[] = [];
    const client = Layer.succeed(ConvexClient, {
      ...fixture.client,
      listUsageLimits: (url) => Effect.sync(() => limits.get(url) ?? []),
      createUsageLimit: (url, input) =>
        Effect.sync(() => {
          events.push(`create:${url}`);
          const created = { ...input, id: `limit-${++nextId}` };
          limits.set(url, [...(limits.get(url) ?? []), created]);
          return created;
        }),
      deleteUsageLimit: (url, id) =>
        Effect.sync(() => {
          events.push(`delete:${url}`);
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
      deployment: { name: "other", url: "https://other.convex.cloud" },
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
    expect(events).toEqual([
      `create:${props.deployment.url}`,
      `create:${news.deployment.url}`,
      `delete:${props.deployment.url}`,
    ]);
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

it.effect(
  "keeps the authenticated HTTP token out of errors, logs, plans and state",
  () =>
    Effect.gen(function* () {
      const token = "MadeUpUsageHttpToken";
      const authorizations: (string | undefined)[] = [];
      const http = HttpClient.make((request) => {
        authorizations.push(request.headers.authorization);
        const response =
          request.method === "GET"
            ? Response.json({ usageLimits: [] })
            : Response.json({ code: token }, { status: 403 });
        return Effect.succeed(HttpClientResponse.fromWeb(request, response));
      });
      const client = clientLayer({ token: Redacted.make(token) }).pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
      );
      const engine = yield* makeEngine(client.pipe(providers));
      const result = yield* engine.run(resource()).pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConvexApiError", status: 403 },
      });
      expect(
        Array.some(authorizations, (value) => value === `Convex ${token}`),
      ).toBe(true);
      const rows = yield* engine.rows();
      expect(
        inspect([result, engine.logs, engine.planOutputs, rows], {
          depth: null,
        }),
      ).not.toContain(token);
    }),
);

it.effect(
  "names the conflicting metric, window and type when a second resource is refused",
  () =>
    Effect.gen(function* () {
      const fixture = mockClient();
      const engine = yield* makeEngine(fixture.layer.pipe(providers));
      yield* engine.run(resource());
      const declarations = Effect.gen(function* () {
        yield* UsageLimit.UsageLimit("Limit", props);
        yield* UsageLimit.UsageLimit("Other", props);
        return {};
      });
      const refused = yield* engine.run(declarations).pipe(Effect.result);
      expect(refused).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "OwnedBySomeoneElse",
          message: expect.stringContaining("--adopt"),
        },
      });
      expect(Array.join(engine.logs, "\n")).toContain(
        "functionCalls/month/warning",
      );
      expect(fixture.client.createUsageLimit).toHaveBeenCalledTimes(1);
    }),
);

it.effect(
  "refuses ambiguous adoption with the triple and all matching ids",
  () =>
    Effect.gen(function* () {
      const fixture = mockClient();
      for (let index = 0; index < 2; index++) {
        yield* fixture.client.createUsageLimit(props.deployment.url, {
          metric: props.metric,
          window: props.window,
          limit: props.limit,
          limitType: "warning",
          enabled: true,
        });
      }
      const engine = yield* makeEngine(fixture.layer.pipe(providers));
      const result = yield* engine
        .run(resource(), { adopt: true })
        .pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "AmbiguousUsageLimit",
          deploymentName: props.deployment.name,
          metric: "functionCalls",
          window: "month",
          limitType: "warning",
          limitIds: ["limit-1", "limit-2"],
        },
      });
      expect(fixture.state.limits).toHaveLength(2);
      expect(fixture.client.deleteUsageLimit).not.toHaveBeenCalled();
    }),
);

it.effect("updates a URL-only change in place even with adoption enabled", () =>
  Effect.gen(function* () {
    const fixture = mockClient();
    const engine = yield* makeEngine(fixture.layer.pipe(providers));
    yield* engine.run(resource());
    const news = {
      ...props,
      deployment: {
        ...props.deployment,
        url: "https://paid-cloud.eu-west-1.convex.cloud",
      },
    };
    const output = yield* engine.run(resource(news), { adopt: true });
    expect(engine.plans.at(-1)).toEqual([
      { fqn: "Limit", action: "update", deleteFirst: false },
    ]);
    expect(output).toEqual({
      id: "limit-1",
      deployment: news.deployment,
      limit: props.limit,
    });
    expect(fixture.state.limits).toHaveLength(1);
    expect(fixture.client.createUsageLimit).toHaveBeenCalledTimes(1);
    expect(fixture.client.deleteUsageLimit).not.toHaveBeenCalled();
    const rows = yield* engine.rows();
    expect(rows).toMatchObject([
      {
        status: "updated",
        attr: { id: "limit-1", deployment: news.deployment },
      },
    ]);
  }),
);

it.effect(
  "replaces a changed deployment name even when its URL stays the same",
  () =>
    Effect.gen(function* () {
      const fixture = mockClient();
      const engine = yield* makeEngine(fixture.layer.pipe(providers));
      yield* engine.run(resource());
      yield* engine.run(
        resource({
          ...props,
          deployment: { ...props.deployment, name: "other" },
        }),
        { apply: false },
      );
      expect(engine.plans.at(-1)).toEqual([
        { fqn: "Limit", action: "replace", deleteFirst: false },
      ]);
      expect(fixture.state.limits).toHaveLength(1);
    }),
);

it.effect(
  "keeps warning and disable limits for the same metric and window",
  () =>
    Effect.gen(function* () {
      const fixture = mockClient();
      const engine = yield* makeEngine(fixture.layer.pipe(providers));
      yield* engine.run(resource());
      const declarations = Effect.gen(function* () {
        const warning = yield* UsageLimit.UsageLimit("Limit", props);
        const disable = yield* UsageLimit.UsageLimit("Disable", {
          ...props,
          limitType: "disable",
        });
        return { warning: warning.id, disable: disable.id };
      });
      const output = yield* engine.run(declarations, { adopt: true });
      expect(output).toEqual({ warning: "limit-1", disable: "limit-2" });
      expect(fixture.state.limits).toEqual([
        {
          id: "limit-1",
          metric: props.metric,
          window: props.window,
          limit: props.limit,
          limitType: "warning",
          enabled: true,
        },
        {
          id: "limit-2",
          metric: props.metric,
          window: props.window,
          limit: props.limit,
          limitType: "disable",
          enabled: true,
        },
      ]);
      const repeated = yield* engine.run(declarations);
      expect(repeated).toEqual(output);
      expect(fixture.state.limits).toHaveLength(2);
    }),
);

it.effect(
  "resumes a checkpointed replacement after its final state write fails",
  () =>
    Effect.gen(function* () {
      const fixture = mockClient();
      let reject = true;
      const engine = yield* makeEngine(providers(fixture.layer), (store) => ({
        ...store,
        set: (request) =>
          Effect.suspend(() => {
            if (request.value.status === "replaced" && reject) {
              reject = false;
              return Effect.fail(
                new StateStoreError({
                  message: "Injected replacement state failure",
                }),
              );
            }
            return store.set(request);
          }),
      }));
      yield* engine.run(resource());
      const news = {
        ...props,
        metric: "databaseIoGb" as const,
        deployment: { name: "other", url: "https://other.convex.cloud" },
      };
      const failed = yield* engine.run(resource(news)).pipe(Effect.result);
      expect(failed).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "StateStoreError" },
      });
      const interrupted = yield* engine.rows();
      expect(interrupted).toMatchObject([
        {
          status: "replacing",
          attr: { id: "limit-2" },
          old: { attr: { id: "limit-1" } },
        },
      ]);
      const output = yield* engine.run(resource(news));
      expect(output).toEqual({
        id: "limit-2",
        deployment: news.deployment,
        limit: props.limit,
      });
      expect(fixture.state.limits).toMatchObject([{ id: "limit-2" }]);
      expect(fixture.state.limits).toHaveLength(1);
      expect(fixture.client.createUsageLimit).toHaveBeenCalledTimes(2);
      const rows = yield* engine.rows();
      expect(rows).toMatchObject([
        { status: "created", attr: { id: "limit-2" } },
      ]);
    }),
);
