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

it.effect(
  "keeps the authenticated HTTP token out of errors, logs, plans and state",
  () =>
    Effect.gen(function* () {
      const token = "made-up-usage-http-token";
      const authorizations: (string | undefined)[] = [];
      const http = HttpClient.make((request) => {
        authorizations.push(request.headers.authorization);
        const response =
          request.method === "GET"
            ? Response.json({ usageLimits: [] })
            : new Response(token, { status: 403 });
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
