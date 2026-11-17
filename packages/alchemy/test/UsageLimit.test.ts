import { Unowned, adopt } from "alchemy/AdoptPolicy";
import { expect, it } from "@effect/vitest";
import {
  ConvexApiError,
  ConvexClient,
  ConvexNotFound,
} from "@confect/alchemy/ConvexClient";
import * as UsageLimit from "@confect/alchemy/UsageLimit";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import { lifecycle, mockClient } from "./fixtures/ConvexClient";

const props: UsageLimit.UsageLimitProps = {
  deployment: {
    name: "happy-otter-123",
    url: "https://happy-otter-123.convex.cloud",
  },
  metric: "functionCalls",
  window: "month",
  limit: 100000,
};

it.effect(
  "uses the new URL for diff and reconcile when the saved URL returns 404",
  () =>
    Effect.gen(function* () {
      const mock = mockClient();
      const services = yield* Layer.build(mock.layer);
      const original = yield* UsageLimit.provider.pipe(
        Effect.provideContext(services),
      );
      const output = yield* original.reconcile({
        ...lifecycle,
        news: props,
        olds: undefined,
        output: undefined,
      });
      const news = {
        ...props,
        deployment: {
          ...props.deployment,
          url: "https://happy-otter-123.eu-west-1.convex.cloud",
        },
      };
      const urls: string[] = [];
      const provider = yield* UsageLimit.provider.pipe(
        Effect.provideService(ConvexClient, {
          ...mock.client,
          listUsageLimits: (url) => {
            urls.push(url);
            return url === props.deployment.url
              ? Effect.fail(
                  ConvexNotFound.make({
                    operation: "listUsageLimits",
                    code: "HttpError",
                    status: 404,
                  }),
                )
              : mock.client.listUsageLimits();
          },
        }),
      );
      const diff = yield* provider.diff({
        ...lifecycle,
        oldBindings: [],
        newBindings: [],
        news,
        olds: props,
        output,
      });
      const updated = yield* provider.reconcile({
        ...lifecycle,
        news,
        olds: props,
        output,
      });
      expect(diff).toEqual({ action: "update" });
      expect(updated).toEqual({ ...output, deployment: news.deployment });
      expect(urls).toEqual([news.deployment.url, news.deployment.url]);
      expect(mock.client.createUsageLimit).toHaveBeenCalledTimes(1);
      expect(mock.client.deleteUsageLimit).not.toHaveBeenCalled();
    }),
);

it.effect("creates an enabled warning limit by default", () => {
  const mock = mockClient();
  return Effect.gen(function* () {
    const services = yield* Layer.build(mock.layer);
    const provider = yield* UsageLimit.provider.pipe(
      Effect.provideContext(services),
    );
    const output = yield* provider.reconcile({
      ...lifecycle,
      news: props,
      olds: undefined,
      output: undefined,
    });
    expect(output).toEqual({
      deployment: props.deployment,
      id: "limit-1",
      metric: "functionCalls",
      window: "month",
      limitType: "warning",
      limit: 100000,
      enabled: true,
    });
  });
});

it.effect("reconciles twice without creating another limit", () => {
  const mock = mockClient();
  return Effect.gen(function* () {
    const services = yield* Layer.build(mock.layer);
    const provider = yield* UsageLimit.provider.pipe(
      Effect.provideContext(services),
    );
    const first = yield* provider.reconcile({
      ...lifecycle,
      news: props,
      olds: undefined,
      output: undefined,
    });
    const second = yield* provider.reconcile({
      ...lifecycle,
      news: props,
      olds: props,
      output: first,
    });
    const limits = yield* mock.client.listUsageLimits();
    expect({ second, limits }).toEqual({
      second: first,
      limits: [
        {
          id: "limit-1",
          metric: "functionCalls",
          window: "month",
          limitType: "warning",
          limit: 100000,
          enabled: true,
        },
      ],
    });
  });
});

it.effect.each([
  { limit: 200000 },
  { enabled: false },
  { metric: "aiGatewayCostDollars" as const },
  { window: "day" as const },
  { limitType: "disable" as const },
])(
  "updates $limit $enabled $metric $window $limitType under the same ID",
  (change) => {
    const mock = mockClient();
    return Effect.gen(function* () {
      const services = yield* Layer.build(mock.layer);
      const provider = yield* UsageLimit.provider.pipe(
        Effect.provideContext(services),
      );
      const first = yield* provider.reconcile({
        ...lifecycle,
        news: props,
        olds: undefined,
        output: undefined,
      });
      const news = { ...props, ...change };
      const diff = yield* provider.diff({
        ...lifecycle,
        oldBindings: [],
        newBindings: [],
        news,
        olds: props,
        output: first,
      });
      const updated = yield* provider.reconcile({
        ...lifecycle,
        news,
        olds: props,
        output: first,
      });
      expect({ diff, updated }).toEqual({
        diff: { action: "update" },
        updated: { ...first, ...change },
      });
    });
  },
);

it.effect(
  "restores a limit edited by hand even when props did not change",
  () => {
    const mock = mockClient();
    return Effect.gen(function* () {
      const services = yield* Layer.build(mock.layer);
      const provider = yield* UsageLimit.provider.pipe(
        Effect.provideContext(services),
      );
      const first = yield* provider.reconcile({
        ...lifecycle,
        news: props,
        olds: undefined,
        output: undefined,
      });
      yield* mock.client.updateUsageLimit(props.deployment.url, first.id, {
        metric: "dataEgressGb",
        window: "day",
        limitType: "disable",
        limit: 1,
        enabled: false,
      });
      const read = yield* provider.read({
        ...lifecycle,
        olds: props,
        output: first,
      });
      const diff = yield* provider.diff({
        ...lifecycle,
        oldBindings: [],
        newBindings: [],
        news: props,
        olds: props,
        output: first,
      });
      const restored = yield* provider.reconcile({
        ...lifecycle,
        news: props,
        olds: props,
        output: read,
      });
      expect({ observedLimit: read?.limit, diff, restored }).toEqual({
        observedLimit: 1,
        diff: { action: "update" },
        restored: first,
      });
    });
  },
);

it.effect("recreates a limit deleted by hand and deletes it on removal", () => {
  const mock = mockClient();
  return Effect.gen(function* () {
    const services = yield* Layer.build(mock.layer);
    const provider = yield* UsageLimit.provider.pipe(
      Effect.provideContext(services),
    );
    const first = yield* provider.reconcile({
      ...lifecycle,
      news: props,
      olds: undefined,
      output: undefined,
    });
    yield* mock.client.deleteUsageLimit(props.deployment.url, first.id);
    const read = yield* provider.read({
      ...lifecycle,
      olds: props,
      output: first,
    });
    const diff = yield* provider.diff({
      ...lifecycle,
      oldBindings: [],
      newBindings: [],
      news: props,
      olds: props,
      output: first,
    });
    const restored = yield* provider.reconcile({
      ...lifecycle,
      news: props,
      olds: props,
      output: first,
    });
    expect({ read, diff, restored }).toEqual({
      read: undefined,
      diff: { action: "update" },
      restored: first,
    });
    yield* provider.delete({ ...lifecycle, olds: props, output: restored });
    yield* provider.delete({ ...lifecycle, olds: props, output: restored });
    const limits = yield* mock.client.listUsageLimits();
    expect(limits).toEqual([]);
  });
});

it.effect("refuses an existing limit without saved ownership", () => {
  const mock = mockClient();
  return Effect.gen(function* () {
    const services = yield* Layer.build(mock.layer);
    const provider = yield* UsageLimit.provider.pipe(
      Effect.provideContext(services),
    );
    yield* provider.reconcile({
      ...lifecycle,
      news: props,
      olds: undefined,
      output: undefined,
    });
    const error = yield* provider
      .reconcile({
        ...lifecycle,
        news: props,
        olds: undefined,
        output: undefined,
      })
      .pipe(Effect.flip);
    expect(error._tag).toBe("OwnedBySomeoneElse");
    expect(error.message).toContain("functionCalls/month/warning");
    expect(error.message).toContain("--adopt");
  });
});

it.effect(
  "leaves an unchanged limit alone and replaces a changed deployment",
  () => {
    const mock = mockClient();
    return Effect.gen(function* () {
      const services = yield* Layer.build(mock.layer);
      const provider = yield* UsageLimit.provider.pipe(
        Effect.provideContext(services),
      );
      const output = yield* provider.reconcile({
        ...lifecycle,
        news: props,
        olds: undefined,
        output: undefined,
      });
      const same = yield* provider.diff({
        ...lifecycle,
        oldBindings: [],
        newBindings: [],
        news: props,
        olds: props,
        output,
      });
      const news = {
        ...props,
        deployment: { name: "other", url: "https://other.convex.cloud" },
      };
      const changed = yield* provider.diff({
        ...lifecycle,
        oldBindings: [],
        newBindings: [],
        news,
        olds: props,
        output,
      });
      const rejected = yield* provider
        .reconcile({ ...lifecycle, news, olds: props, output })
        .pipe(Effect.flip);
      expect({ same, changed, error: rejected._tag }).toEqual({
        same: undefined,
        changed: { action: "replace" },
        error: "UsageLimitTargetChange",
      });
    });
  },
);

it.effect.each([401, 403])(
  "does not read authorization status %s as absence",
  (status) => {
    const mock = mockClient();
    return Effect.gen(function* () {
      const services = yield* Layer.build(mock.layer);
      const provider = yield* UsageLimit.provider.pipe(
        Effect.provideContext(services),
      );
      const output = yield* provider.reconcile({
        ...lifecycle,
        news: props,
        olds: undefined,
        output: undefined,
      });
      const failing = yield* Layer.build(
        Layer.succeed(ConvexClient, {
          ...mock.client,
          listUsageLimits: () =>
            Effect.fail(
              ConvexApiError.make({
                operation: "listUsageLimits",
                code: "HttpError",
                status,
              }),
            ),
        }),
      );
      const denied = yield* UsageLimit.provider.pipe(
        Effect.provideContext(failing),
      );
      const error = yield* denied
        .read({ ...lifecycle, olds: props, output })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "ConvexApiError", status });
    });
  },
);

it.effect(
  "fails explicitly in local mode instead of claiming to enforce a limit",
  () =>
    Effect.gen(function* () {
      const provider = yield* UsageLimit.localProvider;
      const error = yield* provider.reconcile().pipe(Effect.flip);
      expect(error._tag).toBe("UnsupportedLocalUsageLimit");
      expect(error.message).toContain("only for cloud stages");
    }),
);

it.effect.each([0, -5, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid limit %s in diff and reconcile before using the client",
  (limit) =>
    Effect.gen(function* () {
      const mock = mockClient();
      const services = yield* Layer.build(mock.layer);
      const provider = yield* UsageLimit.provider.pipe(
        Effect.provideContext(services),
      );
      const news = { ...props, limit };
      const diff = yield* provider
        .diff({
          ...lifecycle,
          oldBindings: [],
          newBindings: [],
          news,
          olds: props,
          output: undefined,
        })
        .pipe(Effect.result);
      const reconcile = yield* provider
        .reconcile({ ...lifecycle, news, olds: undefined, output: undefined })
        .pipe(Effect.result);
      expect(diff).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "InvalidUsageLimit" },
      });
      expect(reconcile).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "InvalidUsageLimit" },
      });
      expect(mock.client.listUsageLimits).not.toHaveBeenCalled();
      expect(mock.client.createUsageLimit).not.toHaveBeenCalled();
    }),
);

it.effect("reports a matching limit without saved output as unowned", () =>
  Effect.gen(function* () {
    const mock = mockClient();
    const services = yield* Layer.build(mock.layer);
    const provider = yield* UsageLimit.provider.pipe(
      Effect.provideContext(services),
    );
    const created = yield* provider.reconcile({
      ...lifecycle,
      news: props,
      olds: undefined,
      output: undefined,
    });
    const recovered = yield* provider.read({
      ...lifecycle,
      olds: props,
      output: undefined,
    });
    expect(recovered).toEqual(created);
    expect(Unowned.is(recovered)).toBe(true);
    const adopted = yield* provider
      .reconcile({
        ...lifecycle,
        news: props,
        olds: undefined,
        output: undefined,
      })
      .pipe(adopt(true));
    expect(adopted).toEqual(created);
    expect(mock.client.createUsageLimit).toHaveBeenCalledTimes(1);
  }),
);
