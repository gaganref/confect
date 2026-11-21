import { deepEqual, isResolved } from "alchemy/Diff";
import type { InputProps } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Array from "effect/Array";
import * as Provider from "alchemy/Provider";
import {
  Resource,
  type ResourceClass,
  type ResourceConstructor,
} from "alchemy/Resource";
import { Stack } from "alchemy/Stack";
import { State } from "alchemy/State/State";
import * as Effect from "effect/Effect";
import * as Effectable from "effect/Effectable";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ConvexClient from "./ConvexClient.js";
import {
  DeploymentAccess,
  localLayer as localAccess,
} from "./DeploymentAccess.js";
import type { Providers } from "./Providers.js";
import { checkpointCreate } from "./internal/Lifecycle.js";
import { Topics, type Config as LiveConfig } from "./internal/LogStream.js";

type Config<A = ConvexClient.CreateLogStreamInput> = A extends {
  readonly logStreamType: infer K;
}
  ? { readonly kind: K } & Omit<A, "logStreamType">
  : never;
type Keys<A> = A extends unknown ? keyof A : never;
type StrictUnion<A, All = A> = A extends unknown
  ? A & { readonly [K in Exclude<Keys<All>, keyof A>]?: never }
  : never;
type NonEmptySelection<A> = A extends readonly (infer T)[]
  ? readonly [T, ...T[]]
  : A;
type NonEmptyTopics<A> = {
  readonly [K in keyof A]: K extends "topics" ? NonEmptySelection<A[K]> : A[K];
};

export type LogStreamProps = StrictUnion<
  NonEmptyTopics<
    Extract<Config, { readonly kind: "axiom" | "sentry" | "webhook" }>
  >
> & {
  /**
   * The deployment's URL. The credential comes from the run's
   * `DeploymentAccess`, so no key is a prop.
   */
  readonly deploymentUrl: string;
};

export interface LogStreamAttributes {
  readonly id: string;
  readonly kind: LogStreamProps["kind"];
  readonly hmacSecret?: Redacted.Redacted<string>;
}

export type LogStream = Resource<
  "Convex.LogStream",
  LogStreamProps,
  LogStreamAttributes,
  never,
  Providers
>;
const logStream = Resource<LogStream>("Convex.LogStream");

// Validate topics and computed URLs before Alchemy checkpoints props.
export const LogStream: ResourceClass<LogStream> = Object.assign(
  new Proxy(logStream, {
    apply: <PropsReq>(
      target: ResourceClass<LogStream>,
      _this: unknown,
      args:
        | [methods: object]
        | [
            id: string,
            props:
              | InputProps<LogStreamProps>
              | Effect.Effect<InputProps<LogStreamProps>, never, PropsReq>,
          ],
    ) => {
      if (args.length === 1) return Object.assign(LogStream, args[0]);
      const [id, props] = args;
      return target(
        id,
        (Effect.isEffect(props) ? props : Effect.succeed(props)).pipe(
          Effect.flatMap(checkedProps),
        ),
      );
    },
  }),
  Effectable.Prototype<Effect.Effect<ResourceConstructor<LogStream>>>({
    label: "Resource<Convex.LogStream>",
    evaluate: () => Effect.succeed(LogStream),
  }),
);

export class LogStreamNotEnabled extends Schema.TaggedError<
  LogStreamNotEnabled,
  { readonly brand: unique symbol }
>()("LogStreamNotEnabled", {
  kind: Schema.String,
  message: Schema.String,
}) {}

export class LogStreamRecoveryRequired extends Schema.TaggedError<
  LogStreamRecoveryRequired,
  { readonly brand: unique symbol }
>()("LogStreamRecoveryRequired", {
  kind: Schema.String,
  ids: Schema.Array(Schema.String),
  message: Schema.String,
}) {}

export class LogStreamDrift extends Schema.TaggedError<
  LogStreamDrift,
  { readonly brand: unique symbol }
>()("LogStreamDrift", {
  id: Schema.String,
  kind: Schema.String,
  message: Schema.String,
}) {}

export class LogStreamInvalidUrl extends Schema.TaggedError<
  LogStreamInvalidUrl,
  { readonly brand: unique symbol }
>()("LogStreamInvalidUrl", { message: Schema.String }) {}

export class LogStreamUrlRequiresRedacted extends Schema.TaggedError<
  LogStreamUrlRequiresRedacted,
  { readonly brand: unique symbol }
>()("LogStreamUrlRequiresRedacted", { message: Schema.String }) {}

export class LogStreamEmptyTopics extends Schema.TaggedError<
  LogStreamEmptyTopics,
  { readonly brand: unique symbol }
>()("LogStreamEmptyTopics", {
  kind: Schema.String,
  message: Schema.String,
}) {}

const validateTopics = (kind: string, topics: unknown) =>
  Array.isArray(topics) && topics.length === 0
    ? Result.fail(
        LogStreamEmptyTopics.make({
          kind,
          message:
            "Select at least one log topic or omit topics to subscribe to all topics.",
        }),
      )
    : Result.succeed(undefined);

const parseUrl = (value: string) =>
  Result.try({
    try: () => new URL(value),
    catch: () =>
      LogStreamInvalidUrl.make({
        message:
          "The log stream URL could not be parsed. Supply an absolute URL.",
      }),
  });

const normalizeUrl = (value: string) =>
  parseUrl(value).pipe(Result.map((url) => url.href));

const validateWebhookUrl = (value: string | Redacted.Redacted<string>) =>
  parseUrl(Redacted.isRedacted(value) ? Redacted.value(value) : value).pipe(
    Result.flatMap((url) =>
      !Redacted.isRedacted(value) &&
      (url.username !== "" || url.password !== "")
        ? Result.fail(
            LogStreamUrlRequiresRedacted.make({
              message:
                "The webhook URL contains credentials. Pass the URL as Redacted to keep credentials out of plans and state.",
            }),
          )
        : Result.succeed(undefined),
    ),
  );

type WebhookUrl = Extract<LogStreamProps, { readonly kind: "webhook" }>["url"];
const checkedProps = <P extends InputProps<LogStreamProps>>(
  options: P,
): Effect.Effect<P> =>
  Effect.gen(function* () {
    if (
      (options.kind === "axiom" || options.kind === "webhook") &&
      "topics" in options
    )
      yield* Effect.fromResult(
        validateTopics(options.kind, options.topics),
      ).pipe(Effect.orDie);
    return "url" in options && Output.isOutput(options.url)
      ? {
          ...options,
          url: options.url.pipe(
            Output.mapEffect((value: WebhookUrl | undefined) =>
              value === undefined
                ? Effect.succeed(value)
                : Effect.fromResult(validateWebhookUrl(value)).pipe(
                    Effect.orDie,
                    Effect.as(value),
                  ),
            ),
          ),
        }
      : options;
  });

const normalizeTopics = (
  topics: readonly (typeof Topics)[number][] | null | undefined,
) =>
  topics == null
    ? topics
    : Array.filter(Topics, (topic) => Array.contains(topics, topic));

const input = (props: Config) => {
  if ("topics" in props) {
    const result = validateTopics(props.kind, props.topics);
    if (Result.isFailure(result)) return Effect.fail(result.failure);
  }
  switch (props.kind) {
    case "axiom":
      return Effect.succeed({
        logStreamType: props.kind,
        apiKey: props.apiKey,
        datasetName: props.datasetName,
        attributes: props.attributes,
        ingestUrl: props.ingestUrl ?? null,
        topics: props.topics ?? null,
      });
    case "sentry":
      return Effect.succeed({
        logStreamType: props.kind,
        dsn: props.dsn,
        tags: props.tags ?? null,
      });
    case "webhook":
      return Effect.fromResult(validateWebhookUrl(props.url)).pipe(
        Effect.as({
          logStreamType: props.kind,
          url: props.url,
          format: props.format,
          topics: props.topics ?? null,
        }),
      );
    case "datadog":
    case "postHogLogs":
    case "postHogErrorTracking":
    case "s3Export":
      return Effect.fail(
        LogStreamNotEnabled.make({
          kind: props.kind,
          message: "This log stream kind is not switched on.",
        }),
      );
  }
};

const recover = (
  kind: LogStreamProps["kind"],
  ids: readonly string[],
  reason: string,
) =>
  LogStreamRecoveryRequired.make({
    kind,
    ids,
    message: `${reason} Fix the stream or ownership record manually before continuing.`,
  });

const identify = Effect.fn("LogStream.identify")(function* (
  output: LogStreamAttributes,
  live: ConvexClient.LogStreamConfig,
) {
  const config = Redacted.value(live);
  if (config.id !== output.id || config.logStreamType !== output.kind)
    return yield* recover(
      output.kind,
      [output.id],
      "The response identifies a different log stream.",
    );
});

const drift = (output: LogStreamAttributes) =>
  LogStreamDrift.make({
    id: output.id,
    kind: output.kind,
    message:
      "Readable log stream fields differ from the previous and desired configuration. An earlier update may not have finished. If so, apply that same change again before changing or reverting it. If the stream was edited outside the stack, restore those fields or change the stack to match.",
  });

const readable = (
  config: Effect.Success<ReturnType<typeof input>> | typeof LiveConfig.Type,
): Result.Result<Readonly<Record<string, unknown>>, LogStreamInvalidUrl> => {
  switch (config.logStreamType) {
    case "axiom": {
      const base = {
        logStreamType: config.logStreamType,
        datasetName: config.datasetName,
        attributes: config.attributes,
        topics: normalizeTopics(config.topics),
      };
      return config.ingestUrl == null
        ? Result.succeed({
            ...base,
            ...(config.ingestUrl === undefined ? {} : { ingestUrl: null }),
          })
        : Result.map(normalizeUrl(config.ingestUrl), (ingestUrl) => ({
            ...base,
            ingestUrl,
          }));
    }
    case "sentry":
      return Result.succeed({
        logStreamType: config.logStreamType,
        ...(config.tags === undefined ? {} : { tags: config.tags }),
      });
    case "webhook":
      return Result.map(
        normalizeUrl(
          Redacted.isRedacted(config.url)
            ? Redacted.value(config.url)
            : config.url,
        ),
        (url) => ({
          logStreamType: config.logStreamType,
          url,
          format: config.format,
          topics: normalizeTopics(config.topics),
        }),
      );
    default:
      return Result.succeed({ logStreamType: config.logStreamType });
  }
};

const differences = Effect.fn("LogStream.differences")(function* (
  props: LogStreamProps,
  live: ConvexClient.LogStreamConfig,
) {
  const desired = yield* input(props);
  // Compare only fields Convex returns, excluding its generated webhook secret.
  const expected = yield* Effect.fromResult(readable(desired));
  const actual = yield* live.pipe(Redacted.value, readable, Effect.fromResult);
  return Array.filter(
    Array.dedupe([...Record.keys(expected), ...Record.keys(actual)]),
    (key) =>
      !deepEqual(
        { value: expected[key] },
        { value: actual[key] },
        { stripNullish: true },
      ),
  );
});

const validate = Effect.fn("LogStream.validate")(function* (
  props: LogStreamProps,
  output: LogStreamAttributes,
  live: ConvexClient.LogStreamConfig,
) {
  yield* identify(output, live);
  if ((yield* differences(props, live)).length > 0) return yield* drift(output);
});

const resourceState = Effect.fn("LogStream.resourceState")(function* (
  fqn: string,
  instanceId: string,
) {
  const stack = yield* Effect.serviceOption(Stack);
  const state = yield* Effect.serviceOption(State);
  if (Option.isNone(stack) || Option.isNone(state)) return;
  const store = yield* state.value;
  const row = yield* store.get({
    stack: stack.value.name,
    stage: stack.value.stage,
    fqn,
  });
  return row !== undefined &&
    row.kind !== "action" &&
    row.instanceId === instanceId
    ? row
    : undefined;
});

const attributes = (
  live: ConvexClient.LogStreamConfig,
): Pick<LogStreamAttributes, "hmacSecret"> => {
  const config = Redacted.value(live);
  return config.logStreamType === "webhook"
    ? { hmacSecret: Redacted.make(config.hmacSecret) }
    : {};
};

/**
 * @stability unstable
 */
export const provider = Effect.gen(function* () {
  const client = yield* ConvexClient.ConvexClient;
  const access = yield* DeploymentAccess;
  const get = Effect.fn("LogStream.get")(function* (
    props: LogStreamProps,
    id: string,
  ) {
    const key = yield* access.api(props.deploymentUrl);
    return yield* client
      .getLogStream(props.deploymentUrl, key, id)
      .pipe(Effect.catchTag("ConvexNotFound", () => Effect.void));
  });
  const observe = Effect.fn("LogStream.observe")(function* (
    props: LogStreamProps,
    output: LogStreamAttributes,
  ) {
    const live = yield* get(props, output.id);
    if (live === undefined)
      return yield* recover(
        output.kind,
        [output.id],
        "The recorded log stream was deleted.",
      );
    yield* identify(output, live);
    return live;
  });
  const cold = Effect.fn("LogStream.cold")(function* (props: LogStreamProps) {
    yield* input(props);
    const key = yield* access.api(props.deploymentUrl);
    const streams = yield* client.listLogStreams(props.deploymentUrl, key);
    const matches = Array.filter(
      streams,
      (stream) =>
        Redacted.value(stream).logStreamType === props.kind &&
        Redacted.value(stream).status.type !== "deleting",
    );
    if (matches.length > 0)
      return yield* recover(
        props.kind,
        Array.map(matches, (stream) => Redacted.value(stream).id),
        "A stream of this kind exists without an ownership record. Another resource in this stack may already manage this kind. A backend holds one stream per kind.",
      );
    return streams;
  });
  return {
    diff: Effect.fn("LogStream.diff")(function* ({
      fqn,
      instanceId,
      olds,
      news,
      output,
    }) {
      const kind: unknown = "kind" in news ? news.kind : undefined;
      switch (kind) {
        case "datadog":
        case "postHogLogs":
        case "postHogErrorTracking":
        case "s3Export":
          return yield* LogStreamNotEnabled.make({
            kind,
            message: "This log stream kind is not switched on.",
          });
      }
      if (kind === "webhook" && "url" in news && typeof news.url === "string")
        yield* Effect.fromResult(validateWebhookUrl(news.url));
      if ((kind === "axiom" || kind === "webhook") && "topics" in news)
        yield* Effect.fromResult(validateTopics(kind, news.topics));
      const live =
        output === undefined ? undefined : yield* observe(olds, output);
      const changed = live === undefined ? [] : yield* differences(olds, live);
      if (!isResolved(news)) {
        if (changed.length > 0) {
          yield* Effect.logWarning(
            `Log stream ${output?.id} differs in fields ${Array.join(changed, ", ")}. Apply will check for an unfinished update or an external edit.`,
          );
          return { action: "update" };
        }
        return;
      }
      yield* input(news);
      if (output === undefined) {
        yield* cold(news);
        return;
      }
      if (
        news.kind !== output.kind ||
        news.deploymentUrl !== olds.deploymentUrl
      ) {
        yield* cold(news);
        return { action: "replace" };
      }
      const row = yield* resourceState(fqn, instanceId);
      const clean = row?.status === "created" || row?.status === "updated";
      if (changed.length > 0 && live !== undefined) {
        if ((yield* differences(news, live)).length > 0 && clean)
          return yield* drift(output);
        yield* Effect.logWarning(
          `Log stream ${output.id} differs in fields ${Array.join(changed, ", ")}. Apply will check for an unfinished update or an external edit.`,
        );
        return { action: "update" };
      }
      if (
        (news.kind !== "webhook" && row !== undefined && !clean) ||
        !deepEqual(news, olds) ||
        (live !== undefined &&
          !deepEqual(attributes(live).hmacSecret, output.hmacSecret))
      )
        return { action: "update" };
    }),
    read: Effect.fn("LogStream.read")(function* ({ olds, output }) {
      if (output !== undefined) {
        const live = yield* observe(olds, output);
        yield* validate(olds, output, live);
        return { id: output.id, kind: output.kind, ...attributes(live) };
      }
      if (isResolved(olds)) yield* cold(olds);
      return undefined;
    }),
    reconcile: Effect.fn("LogStream.reconcile")(function* ({
      fqn,
      instanceId,
      news,
      olds,
      output,
    }) {
      const config = yield* input(news);
      if (output !== undefined) {
        if (olds === undefined) {
          const row = yield* resourceState(fqn, instanceId);
          if (
            row?.status === "creating" &&
            row.attr?.id === output.id &&
            row.attr?.kind === output.kind &&
            row.props.deploymentUrl === news.deploymentUrl &&
            news.kind === output.kind
          ) {
            const live = yield* observe(news, output);
            yield* validate(news, output, live);
            return { id: output.id, kind: output.kind, ...attributes(live) };
          }
          return yield* recover(
            output.kind,
            [output.id],
            "The prior ownership props are missing.",
          );
        }
        const observed = yield* observe(olds, output);
        if (
          news.kind !== output.kind ||
          news.deploymentUrl !== olds.deploymentUrl
        )
          return yield* recover(
            output.kind,
            [output.id],
            "A kind or deployment change needs replacement.",
          );
        const desiredChanges = yield* differences(news, observed);
        if (
          desiredChanges.length > 0 &&
          (yield* differences(olds, observed)).length > 0
        )
          return yield* drift(output);
        if (news.kind === "webhook" && desiredChanges.length === 0)
          return { id: output.id, kind: output.kind, ...attributes(observed) };
        const key = yield* access.api(news.deploymentUrl);
        yield* client.updateLogStream(
          news.deploymentUrl,
          key,
          output.id,
          config,
        );
        const live = yield* get(news, output.id);
        if (live === undefined)
          return yield* recover(
            news.kind,
            [output.id],
            "Update succeeded but the stream could not be read.",
          );
        const updated = {
          id: output.id,
          kind: output.kind,
          ...attributes(live),
        };
        yield* validate(news, updated, live);
        return updated;
      }
      yield* cold(news);
      yield* checkpointCreate(fqn, instanceId, news);
      const key = yield* access.api(news.deploymentUrl);
      const response = yield* client
        .createLogStream(news.deploymentUrl, key, config)
        .pipe(
          Effect.catchTag("ConvexConflict", () =>
            Effect.gen(function* () {
              const streams = yield* cold(news);
              const deleting = Array.filter(streams, (stream) => {
                const live = Redacted.value(stream);
                return (
                  live.logStreamType === news.kind &&
                  live.status.type === "deleting"
                );
              });
              if (deleting.length > 0)
                return yield* LogStreamRecoveryRequired.make({
                  kind: news.kind,
                  ids: Array.map(
                    deleting,
                    (stream) => Redacted.value(stream).id,
                  ),
                  message:
                    "A stream of this kind is still deleting. Run the deploy again once deletion finishes.",
                });
              return yield* recover(
                news.kind,
                [],
                "A concurrent create conflicted with this stream.",
              );
            }),
          ),
        );
      const created = Redacted.value(response);
      const owned: LogStreamAttributes = {
        id: created.id,
        kind: news.kind,
        ...(created.logStreamType === "webhook"
          ? { hmacSecret: Redacted.make(created.hmacSecret) }
          : {}),
      };
      yield* checkpointCreate(fqn, instanceId, news, owned);
      if (created.logStreamType !== news.kind)
        return yield* recover(
          news.kind,
          [created.id],
          "Create returned a different stream kind.",
        );
      const live = yield* get(news, created.id);
      if (live === undefined)
        return yield* recover(
          news.kind,
          [created.id],
          "Create succeeded but the stream could not be read.",
        );
      const createdOutput: LogStreamAttributes = {
        id: created.id,
        kind: news.kind,
        ...attributes(live),
      };
      yield* validate(news, createdOutput, live);
      yield* checkpointCreate(fqn, instanceId, news, createdOutput);
      return createdOutput;
    }),
    delete: Effect.fn("LogStream.delete")(function* ({ olds, output }) {
      const live = yield* get(olds, output.id);
      if (live === undefined) return;
      yield* identify(output, live);
      const key = yield* access.api(olds.deploymentUrl);
      yield* client
        .deleteLogStream(olds.deploymentUrl, key, output.id)
        .pipe(Effect.catchTag("ConvexNotFound", () => Effect.void));
    }),
  } satisfies Provider.ProviderServiceInput<LogStream>;
});

/**
 * @stability unstable
 */
export const layer = Provider.effect(LogStream, provider);
/**
 * @stability unstable
 */
export const localLayer = Provider.effect(LogStream, provider).pipe(
  Layer.provide(
    Layer.mergeAll(
      ConvexClient.layer({ mode: "local" }).pipe(
        Layer.provide(FetchHttpClient.layer),
      ),
      localAccess,
    ),
  ),
);
