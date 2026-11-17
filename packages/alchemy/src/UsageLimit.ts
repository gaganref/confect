import type {
  UsageLimitMetric,
  UsageLimitType,
  UsageLimitWindow,
} from "@convex-dev/platform/deploymentApi";
import { OwnedBySomeoneElse, Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ConvexClient, type UsageLimitInput } from "./ConvexClient.js";
import type { Providers } from "./Providers.js";
import { checkpointCreate, shouldAdopt } from "./internal/Lifecycle.js";

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

export class AmbiguousUsageLimit extends Schema.TaggedError<
  AmbiguousUsageLimit,
  { readonly brand: unique symbol }
>()("AmbiguousUsageLimit", {
  deploymentName: Schema.String,
  metric: Schema.String,
  window: Schema.String,
  limitType: Schema.String,
  limitIds: Schema.Array(Schema.String),
}) {
  override get message() {
    return `Usage limit ${this.metric}/${this.window}/${this.limitType} on ${this.deploymentName} matches multiple ids: ${Array.join(this.limitIds, ", ")}.`;
  }
}

export class InvalidUsageLimit extends Schema.TaggedError<
  InvalidUsageLimit,
  { readonly brand: unique symbol }
>()("InvalidUsageLimit", { limit: Schema.String }) {
  override get message() {
    return `Usage limit ${this.limit} must be a positive safe integer.`;
  }
}

export class UnsupportedLocalUsageLimit extends Schema.TaggedError<
  UnsupportedLocalUsageLimit,
  { readonly brand: unique symbol }
>()("UnsupportedLocalUsageLimit", {}) {
  override get message() {
    return "Declare Convex.UsageLimit only for cloud stages.";
  }
}

const validateLimit = Effect.fn("UsageLimit.validateLimit")(function* (
  limit: number,
) {
  if (!Number.isSafeInteger(limit) || limit < 1)
    return yield* InvalidUsageLimit.make({ limit: String(limit) });
});

const desired = (props: UsageLimitProps): UsageLimitInput => ({
  metric: props.metric,
  window: props.window,
  limit: props.limit,
  limitType: props.limitType ?? "warning",
  enabled: props.enabled ?? true,
});
const sameTarget = (current: UsageLimitAttributes, props: UsageLimitProps) =>
  current.deployment.name === props.deployment.name;
const sameConfig = (current: UsageLimitInput, input: UsageLimitInput) =>
  current.metric === input.metric &&
  current.window === input.window &&
  current.limitType === input.limitType &&
  current.limit === input.limit &&
  current.enabled === input.enabled;

const ownershipConflict = (
  input: Pick<UsageLimitInput, "metric" | "window" | "limitType">,
) => {
  const physicalName = `${input.metric}/${input.window}/${input.limitType}`;
  return new OwnedBySomeoneElse({
    message: `Usage limit ${physicalName} already exists on this deployment. Declare one limit per metric, window and type. Re-run with --adopt or adopt(true) to take it over.`,
    resourceType: UsageLimit.Type,
    physicalName,
  });
};

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
  const findMatching = Effect.fn("UsageLimit.findMatching")(function* (
    deployment: UsageLimitProps["deployment"],
    input: Pick<UsageLimitInput, "metric" | "window" | "limitType">,
  ) {
    const limits = yield* client
      .listUsageLimits(deployment.url)
      .pipe(Effect.catchTag("ConvexNotFound", () => Effect.succeed([])));
    const matches = Array.filter(
      limits,
      (limit) =>
        limit.metric === input.metric &&
        limit.window === input.window &&
        limit.limitType === input.limitType,
    );
    if (matches.length > 1)
      return yield* AmbiguousUsageLimit.make({
        deploymentName: deployment.name,
        ...input,
        limitIds: Array.map(matches, (limit) => limit.id),
      });
    return matches[0];
  });
  return {
    diff: Effect.fn("UsageLimit.diff")(function* ({ news, output }) {
      if (!isResolved(news)) return;
      yield* validateLimit(news.limit);
      if (output === undefined) return;
      if (!sameTarget(output, news)) return { action: "replace" };
      const current = yield* find(output);
      if (
        output.deployment.url !== news.deployment.url ||
        current === undefined ||
        !sameConfig(current, desired(news))
      )
        return { action: "update" };
    }),
    read: Effect.fn("UsageLimit.read")(function* ({ fqn, olds, output }) {
      if (output === undefined) {
        if (olds.limit !== undefined) yield* validateLimit(olds.limit);
        if (
          olds.deployment === undefined ||
          olds.metric === undefined ||
          olds.window === undefined
        )
          return;
        const input = {
          metric: olds.metric,
          window: olds.window,
          limitType: olds.limitType ?? "warning",
        };
        const current = yield* findMatching(olds.deployment, input);
        if (current !== undefined && !(yield* shouldAdopt(fqn)))
          yield* Effect.logWarning(ownershipConflict(input).message);
        return current === undefined
          ? undefined
          : Unowned({ deployment: olds.deployment, ...current });
      }
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
      yield* validateLimit(news.limit);
      if (output === undefined) yield* checkpointCreate(fqn, instanceId, news);
      if (output !== undefined && !sameTarget(output, news))
        return yield* UsageLimitTargetChange.make({
          deploymentName: output.deployment.name,
        });
      const input = desired(news);
      let current = output === undefined ? undefined : yield* find(output);
      if (current === undefined) {
        const existing = yield* findMatching(news.deployment, input);
        if (existing !== undefined && !(yield* shouldAdopt(fqn)))
          return yield* ownershipConflict(input);
        current = existing;
      }
      if (current !== undefined) {
        yield* checkpointCreate(fqn, instanceId, news, {
          deployment: news.deployment,
          ...current,
        });
        const updated = sameConfig(current, input)
          ? current
          : yield* client.updateUsageLimit(
              news.deployment.url,
              current.id,
              input,
            );
        return { deployment: news.deployment, ...updated };
      }
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
