import { deepEqual, isResolved } from "alchemy/Diff";
import * as Array from "effect/Array";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
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
  readonly lastWrite: LogStreamProps;
  readonly readable: Redacted.Redacted<object>;
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

const snapshot = (stream: ConvexClient.LogStreamConfig) => {
  const { status: _, ...config } = Redacted.value(stream);
  return Redacted.make(config);
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

const validate = Effect.fn("LogStream.validate")(function* (
  output: LogStreamAttributes,
  live: ConvexClient.LogStreamConfig,
) {
  if (output.kind === "webhook" && !Redacted.isRedacted(output.hmacSecret))
    return yield* recover(
      output.kind,
      [output.id],
      "The create-time webhook HMAC is missing from state.",
    );
  const config = Redacted.value(live);
  if (config.id !== output.id || config.logStreamType !== output.kind)
    return yield* recover(
      output.kind,
      [output.id],
      "The response identifies a different log stream.",
    );
  const hmacChanged =
    config.logStreamType === "webhook" &&
    output.hmacSecret !== undefined &&
    config.hmacSecret !== Redacted.value(output.hmacSecret);
  if (hmacChanged || !deepEqual(snapshot(live), output.readable))
    return yield* LogStreamDrift.make({
      id: output.id,
      kind: output.kind,
      message:
        "A readable log stream field changed outside this resource. Restore it manually before continuing.",
    });
});

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
    output: LogStreamAttributes,
  ) {
    const live = yield* get(output.lastWrite, output.id);
    if (live === undefined)
      return yield* recover(
        output.kind,
        [output.id],
        "The recorded log stream was deleted.",
      );
    yield* validate(output, live);
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
      (stream) => Redacted.value(stream).logStreamType === props.kind,
    );
    if (matches.length > 0)
      return yield* recover(
        props.kind,
        Array.map(matches, (stream) => Redacted.value(stream).id),
        "A stream of this kind exists without an ownership record.",
      );
  });
  return {
    diff: Effect.fn("LogStream.diff")(function* ({ news, output }) {
      if (output !== undefined) yield* observe(output);
      if (!isResolved(news)) return;
      yield* input(news);
      if (output === undefined) {
        yield* cold(news);
        return;
      }
      if (
        news.kind !== output.kind ||
        news.deploymentUrl !== output.lastWrite.deploymentUrl
      ) {
        yield* cold(news);
        return { action: "replace" };
      }
      if (!deepEqual(news, output.lastWrite)) return { action: "update" };
    }),
    read: Effect.fn("LogStream.read")(function* ({ olds, output }) {
      if (output !== undefined) {
        yield* observe(output);
        return output;
      }
      if (isResolved(olds)) yield* cold(olds);
      return undefined;
    }),
    reconcile: Effect.fn("LogStream.reconcile")(function* ({
      fqn,
      instanceId,
      news,
      output,
    }) {
      const config = yield* input(news);
      if (output !== undefined) {
        yield* observe(output);
        if (
          news.kind !== output.kind ||
          news.deploymentUrl !== output.lastWrite.deploymentUrl
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
          ...output,
          lastWrite: news,
          readable: snapshot(live),
        };
        yield* validate(updated, live);
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
      const attributes: LogStreamAttributes = {
        id: created.id,
        kind: news.kind,
        lastWrite: news,
        readable: snapshot(live),
        ...(created.logStreamType === "webhook"
          ? { hmacSecret: Redacted.make(created.hmacSecret) }
          : {}),
      };
      yield* validate(attributes, live);
      yield* checkpointCreate(fqn, instanceId, news, attributes);
      return attributes;
    }),
    delete: Effect.fn("LogStream.delete")(function* ({ output }) {
      const live = yield* get(output.lastWrite, output.id);
      if (live === undefined) return;
      yield* validate(output, live);
      yield* client
        .deleteLogStream(
          output.lastWrite.deploymentUrl,
          output.lastWrite.deployKey,
          output.id,
        )
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
