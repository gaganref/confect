import type {
  UsageLimitMetric,
  UsageLimitType,
  UsageLimitWindow,
} from "@convex-dev/platform/deploymentApi";
import { OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ConvexClient, type UsageLimitInput } from "./ConvexClient.js";
import type { Providers } from "./Providers.js";
import { checkpointCreate } from "./internal/Lifecycle.js";

export interface UsageLimitProps {
  readonly deployment: { readonly name: string; readonly url: string };
  readonly metric: UsageLimitMetric;
  readonly window: UsageLimitWindow;
  readonly limit: number;
  readonly limitType?: UsageLimitType;
  readonly enabled?: boolean;
}

export interface UsageLimitAttributes {
  readonly deployment: { readonly name: string; readonly url: string };
  readonly id: string;
  readonly metric: UsageLimitMetric;
  readonly window: UsageLimitWindow;
  readonly limit: number;
  readonly limitType: UsageLimitType;
  readonly enabled: boolean;
}

export type UsageLimit = Resource<
  "Convex.UsageLimit",
  UsageLimitProps,
  UsageLimitAttributes,
  never,
  Providers
>;
export const UsageLimit = Resource<UsageLimit>("Convex.UsageLimit");

export class UsageLimitTargetChange extends Schema.TaggedError<
  UsageLimitTargetChange,
  { readonly brand: unique symbol }
>()("UsageLimitTargetChange", { deploymentName: Schema.String }) {}

export class UnsupportedLocalUsageLimit extends Schema.TaggedError<
  UnsupportedLocalUsageLimit,
  { readonly brand: unique symbol }
>()("UnsupportedLocalUsageLimit", {}) {}

const desired = (props: UsageLimitProps): UsageLimitInput => ({
  metric: props.metric,
  window: props.window,
  limit: props.limit,
  limitType: props.limitType ?? "warning",
  enabled: props.enabled ?? true,
});
const sameTarget = (current: UsageLimitAttributes, props: UsageLimitProps) =>
  current.deployment.name === props.deployment.name &&
  current.deployment.url === props.deployment.url;
const sameConfig = (current: UsageLimitInput, input: UsageLimitInput) =>
  current.metric === input.metric &&
  current.window === input.window &&
  current.limitType === input.limitType &&
  current.limit === input.limit &&
  current.enabled === input.enabled;

export const provider = Effect.gen(function* () {
  const client = yield* ConvexClient;
  const find = Effect.fn("UsageLimit.find")(function* (
    output: UsageLimitAttributes,
  ) {
    const limits = yield* client
      .listUsageLimits(output.deployment.url)
      .pipe(Effect.catchTag("ConvexNotFound", () => Effect.succeed([])));
    return Option.getOrUndefined(
      Array.findFirst(limits, (limit) => limit.id === output.id),
    );
  });
  return {
    diff: Effect.fn("UsageLimit.diff")(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return;
      if (!sameTarget(output, news)) return { action: "replace" };
      const current = yield* find(output);
      if (current === undefined || !sameConfig(current, desired(news)))
        return { action: "update" };
    }),
    read: Effect.fn("UsageLimit.read")(function* ({ output }) {
      if (output === undefined) return;
      const current = yield* find(output);
      return current === undefined
        ? undefined
        : { deployment: output.deployment, ...current };
    }),
    reconcile: Effect.fn("UsageLimit.reconcile")(function* ({
      fqn,
      instanceId,
      news,
      output,
    }) {
      if (output === undefined) yield* checkpointCreate(fqn, instanceId, news);
      if (output !== undefined && !sameTarget(output, news))
        return yield* UsageLimitTargetChange.make({
          deploymentName: output.deployment.name,
        });
      const input = desired(news);
      const current = output === undefined ? undefined : yield* find(output);
      if (current !== undefined) {
        const updated = sameConfig(current, input)
          ? current
          : yield* client.updateUsageLimit(
              news.deployment.url,
              current.id,
              input,
            );
        return { deployment: news.deployment, ...updated };
      }
      const limits = yield* client.listUsageLimits(news.deployment.url);
      if (
        Array.some(
          limits,
          (limit) =>
            limit.metric === input.metric &&
            limit.window === input.window &&
            limit.limitType === input.limitType,
        )
      )
        return yield* new OwnedBySomeoneElse({
          message: "An existing usage limit is not owned by this resource.",
          resourceType: UsageLimit.Type,
          physicalName: `${input.metric}/${input.window}/${input.limitType}`,
        });
      const created = yield* client.createUsageLimit(
        news.deployment.url,
        input,
      );
      const attributes = { deployment: news.deployment, ...created };
      yield* checkpointCreate(fqn, instanceId, news, attributes);
      return attributes;
    }),
    delete: Effect.fn("UsageLimit.delete")(function* ({ output }) {
      yield* client
        .deleteUsageLimit(output.deployment.url, output.id)
        .pipe(Effect.catchTag("ConvexNotFound", () => Effect.void));
    }),
  } satisfies Provider.ProviderServiceInput<UsageLimit>;
});

export const localProvider = Effect.succeed({
  reconcile: () => Effect.fail(UnsupportedLocalUsageLimit.make({})),
  delete: () => Effect.void,
} satisfies Provider.ProviderServiceInput<UsageLimit>);

export const layer = Provider.effect(UsageLimit, provider);
export const localLayer = Provider.effect(UsageLimit, localProvider);
