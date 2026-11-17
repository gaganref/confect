import { deepEqual, isResolved } from "alchemy/Diff";
import * as Array from "effect/Array";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ConvexClient from "./ConvexClient.js";
import type { Providers } from "./Providers.js";
import { checkpointCreate } from "./internal/Lifecycle.js";

type Config<A = ConvexClient.CreateLogStreamInput> = A extends {
  readonly logStreamType: infer K;
}
  ? { readonly kind: K } & Omit<A, "logStreamType">
  : never;
type Keys<A> = A extends unknown ? keyof A : never;
type StrictUnion<A, All = A> = A extends unknown
  ? A & { readonly [K in Exclude<Keys<All>, keyof A>]?: never }
  : never;

export type LogStreamProps = StrictUnion<Config> & {
  readonly deploymentUrl: string;
  readonly deployKey: Redacted.Redacted<string>;
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
export const LogStream = Resource<LogStream>("Convex.LogStream");

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

const input = (props: LogStreamProps) => {
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
      return Effect.succeed({
        logStreamType: props.kind,
        url: props.url,
        format: props.format,
        topics: props.topics ?? null,
      });
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

const validate = Effect.fn("LogStream.validate")(function* (
  props: LogStreamProps,
  output: LogStreamAttributes,
  live: ConvexClient.LogStreamConfig,
) {
  yield* identify(output, live);
  const desired = yield* input(props);
  const { id: _id, status: _status, ...config } = Redacted.value(live);
  // Compare only fields Convex returns, excluding its generated webhook secret.
  const expected =
    desired.logStreamType === "axiom"
      ? Struct.omit(desired, ["apiKey"])
      : desired.logStreamType === "sentry"
        ? Struct.omit(desired, ["dsn"])
        : {
            ...desired,
            url: Redacted.isRedacted(desired.url)
              ? Redacted.value(desired.url)
              : desired.url,
          };
  const actual =
    config.logStreamType === "webhook"
      ? Struct.omit(config, ["hmacSecret"])
      : config;
  if (!deepEqual(expected, actual, { stripNullish: true }))
    return yield* LogStreamDrift.make({
      id: output.id,
      kind: output.kind,
      message:
        "A readable log stream field changed outside this resource. Restore it manually before continuing.",
    });
});

const attributes = (
  live: ConvexClient.LogStreamConfig,
): Pick<LogStreamAttributes, "hmacSecret"> => {
  const config = Redacted.value(live);
  return config.logStreamType === "webhook"
    ? { hmacSecret: Redacted.make(config.hmacSecret) }
    : {};
};

export const provider = Effect.gen(function* () {
  const client = yield* ConvexClient.ConvexClient;
  const get = Effect.fn("LogStream.get")(function* (
    props: LogStreamProps,
    id: string,
  ) {
    return yield* client
      .getLogStream(props.deploymentUrl, props.deployKey, id)
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
    yield* validate(props, output, live);
    return live;
  });
  const cold = Effect.fn("LogStream.cold")(function* (props: LogStreamProps) {
    yield* input(props);
    const streams = yield* client.listLogStreams(
      props.deploymentUrl,
      props.deployKey,
    );
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
  });
  return {
    diff: Effect.fn("LogStream.diff")(function* ({ olds, news, output }) {
      const kind = "kind" in news ? news.kind : undefined;
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
      if (output !== undefined) yield* observe(olds, output);
      if (!isResolved(news)) return;
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
      if (!deepEqual(news, olds)) return { action: "update" };
    }),
    read: Effect.fn("LogStream.read")(function* ({ olds, output }) {
      if (output !== undefined) {
        const live = yield* observe(olds, output);
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
        if (olds === undefined)
          return yield* recover(
            output.kind,
            [output.id],
            "The prior ownership props are missing.",
          );
        yield* observe(olds, output);
        if (
          news.kind !== output.kind ||
          news.deploymentUrl !== olds.deploymentUrl
        )
          return yield* recover(
            output.kind,
            [output.id],
            "A kind or deployment change needs replacement.",
          );
        yield* client.updateLogStream(
          news.deploymentUrl,
          news.deployKey,
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
      const response = yield* client
        .createLogStream(news.deploymentUrl, news.deployKey, config)
        .pipe(
          Effect.catchTag("ConvexConflict", () =>
            Effect.gen(function* () {
              yield* cold(news);
              return yield* recover(
                news.kind,
                [],
                "A concurrent create conflicted with this stream.",
              );
            }),
          ),
        );
      const created = Redacted.value(response);
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
      yield* client
        .deleteLogStream(olds.deploymentUrl, olds.deployKey, output.id)
        .pipe(Effect.catchTag("ConvexNotFound", () => Effect.void));
    }),
  } satisfies Provider.ProviderServiceInput<LogStream>;
});

export const layer = Provider.effect(LogStream, provider);
export const localLayer = Provider.effect(LogStream, provider).pipe(
  Layer.provide(
    ConvexClient.layer({ mode: "local" }).pipe(
      Layer.provide(FetchHttpClient.layer),
    ),
  ),
);
