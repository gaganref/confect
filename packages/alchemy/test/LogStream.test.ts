import * as LogStream from "@confect/alchemy/LogStream";
import {
  ConvexClient,
  ConvexApiError,
  ConvexNotFound,
} from "@confect/alchemy/ConvexClient";
import { expect, it } from "@effect/vitest";
import { Stack } from "alchemy/Stack";
import { InMemoryService } from "alchemy/State/InMemoryState";
import type { ResourceState } from "alchemy/State/ResourceState";
import { State } from "alchemy/State/State";
import * as Effect from "effect/Effect";
import * as Array from "effect/Array";
import * as Redacted from "effect/Redacted";
import { lifecycle, mockClient } from "./fixtures/ConvexClient";

const target = {
  deploymentUrl: "https://happy-otter-123.convex.cloud",
  deployKey: Redacted.make("made-up-deploy-key"),
};
const axiom = {
  ...target,
  kind: "axiom",
  apiKey: Redacted.make("made-up-axiom-key"),
  datasetName: "backend",
  attributes: [{ key: "app", value: "notes" }],
} as const;
const sentry = {
  ...target,
  kind: "sentry",
  dsn: Redacted.make("made-up-sentry-dsn"),
  tags: { app: "notes" },
} as const;
const webhook = {
  ...target,
  kind: "webhook",
  url: "https://logs.example.test",
  format: "jsonl",
} as const;

const withProvider = <A, E, R>(
  body: (
    service: Effect.Success<typeof LogStream.provider>,
    mock: ReturnType<typeof mockClient>,
  ) => Effect.Effect<A, E, R>,
) => {
  const mock = mockClient();
  return Effect.flatMap(LogStream.provider, (service) =>
    body(service, mock),
  ).pipe(Effect.provideService(ConvexClient, mock.client));
};

const create = (
  service: Effect.Success<typeof LogStream.provider>,
  news: LogStream.LogStreamProps = axiom,
) =>
  service.reconcile({ ...lifecycle, news, olds: undefined, output: undefined });

it.effect.each([axiom, sentry, webhook])(
  "creates an owned $kind stream",
  (props) =>
    withProvider((service, mock) =>
      Effect.gen(function* () {
        const output = yield* create(service, props);
        expect(output).toMatchObject({
          id: "stream-1",
          kind: props.kind,
        });
        expect(output).toEqual({
          id: "stream-1",
          kind: props.kind,
          ...(props.kind === "webhook"
            ? { hmacSecret: Redacted.make("made-up-hmac-secret") }
            : {}),
        });
        const live = yield* mock.client.getLogStream(
          props.deploymentUrl,
          props.deployKey,
          output.id,
        );
        expect(Redacted.value(live).logStreamType).toBe(props.kind);
        if (props.kind === "webhook") {
          expect(Redacted.isRedacted(output.hmacSecret)).toBe(true);
          expect(output.hmacSecret && Redacted.value(output.hmacSecret)).toBe(
            "made-up-hmac-secret",
          );
        }
      }),
    ),
);

const diff = (
  service: Effect.Success<typeof LogStream.provider>,
  output: LogStream.LogStreamAttributes,
  news: LogStream.LogStreamProps = axiom,
  olds: LogStream.LogStreamProps = news,
) =>
  service.diff({
    ...lifecycle,
    output,
    news,
    olds,
    oldBindings: [],
    newBindings: [],
  });

const stack = {
  name: "test",
  stage: "test",
  resources: {},
  bindings: {},
  actions: {},
};
const ownedRow = (
  props: LogStream.LogStreamProps,
  output: LogStream.LogStreamAttributes,
): Extract<ResourceState, { status: "created" }> => ({
  status: "created",
  fqn: lifecycle.fqn,
  logicalId: lifecycle.id,
  instanceId: lifecycle.instanceId,
  resourceType: "Convex.LogStream",
  namespace: undefined,
  providerVersion: 0,
  downstream: [],
  bindings: [],
  props,
  attr: output,
});

it.effect.each(
  Array.flatMap([axiom, sentry], (props) =>
    Array.map(
      ["creating", "updating", "deleting", "replacing", "replaced"] as const,
      (status) => ({ props, status }),
    ),
  ),
)(
  "plans an update for an unfinished $props.kind $status row with matching readable fields",
  ({ props, status }) =>
    withProvider((service) =>
      Effect.gen(function* () {
        const output = yield* create(service, props);
        const clean = ownedRow(props, output);
        const rows = {
          creating: { ...clean, status: "creating" },
          updating: { ...clean, status: "updating", old: clean },
          deleting: { ...clean, status: "deleting" },
          replacing: {
            ...clean,
            status: "replacing",
            old: clean,
            deleteFirst: false,
          },
          replaced: {
            ...clean,
            status: "replaced",
            old: clean,
            deleteFirst: false,
          },
        } satisfies Record<typeof status, ResourceState>;
        const store = yield* InMemoryService({
          test: { test: { test: rows[status] } },
        });
        const planned = yield* diff(service, output, props).pipe(
          Effect.provideService(Stack, stack),
          Effect.provideService(State, Effect.succeed(store)),
        );
        expect(planned).toEqual({ action: "update" });
      }),
    ),
);

it.effect.each([
  { before: axiom, after: { ...axiom, datasetName: "next" } },
  {
    before: axiom,
    after: { ...axiom, apiKey: Redacted.make("made-up-new-axiom-key") },
  },
  { before: sentry, after: { ...sentry, tags: { app: "next" } } },
  {
    before: sentry,
    after: { ...sentry, dsn: Redacted.make("made-up-new-sentry-dsn") },
  },
  { before: webhook, after: { ...webhook, url: "https://new.example.test" } },
  { before: webhook, after: { ...webhook, format: "json" as const } },
])(
  "updates $before.kind in place when its configuration changes",
  ({ before, after }) =>
    withProvider((service, mock) =>
      Effect.gen(function* () {
        const first = yield* create(service, before);
        const planned = yield* diff(service, first, after, before);
        expect(planned).toEqual({ action: "update" });
        const updated = yield* service.reconcile({
          ...lifecycle,
          news: after,
          olds: before,
          output: first,
        });
        expect(updated).toMatchObject({
          id: first.id,
          kind: first.kind,
        });
        const stable = yield* diff(service, updated, after);
        expect(stable).toBeUndefined();
        expect(mock.client.createLogStream).toHaveBeenCalledTimes(1);
        expect(mock.client.updateLogStream).toHaveBeenCalledWith(
          after.deploymentUrl,
          after.deployKey,
          first.id,
          expect.objectContaining({ logStreamType: after.kind }),
        );
        const sent = mock.client.updateLogStream.mock.calls.at(-1)?.[3];
        expect(sent).toBeDefined();
        if (sent?.logStreamType === "axiom" && after.kind === "axiom") {
          expect(sent.apiKey).toBe(after.apiKey);
          expect(sent.datasetName).toBe(after.datasetName);
        }
        if (sent?.logStreamType === "sentry" && after.kind === "sentry") {
          expect(sent.dsn).toBe(after.dsn);
          expect(sent.tags).toEqual(after.tags);
        }
        if (sent?.logStreamType === "webhook" && after.kind === "webhook") {
          expect(sent.url).toBe(after.url);
          expect(sent.format).toBe(after.format);
        }
      }),
    ),
);

it.effect.each([
  {
    props: {
      ...axiom,
      ingestUrl: "https://api.axiom.co",
      topics: ["console" as const],
    },
    next: axiom,
    cleared: { ingestUrl: null, topics: null },
  },
  {
    props: sentry,
    next: { ...target, kind: "sentry", dsn: sentry.dsn } as const,
    cleared: { tags: null },
  },
  {
    props: { ...webhook, topics: ["console" as const] },
    next: webhook,
    cleared: { topics: null },
  },
])(
  "clears omitted optional $props.kind configuration with null",
  ({ props, next, cleared }) =>
    withProvider((service, mock) =>
      Effect.gen(function* () {
        const first = yield* create(service, props);
        yield* service.reconcile({
          ...lifecycle,
          news: next,
          olds: props,
          output: first,
        });
        expect(mock.client.updateLogStream).toHaveBeenCalledWith(
          next.deploymentUrl,
          next.deployKey,
          first.id,
          expect.objectContaining(cleared),
        );
      }),
    ),
);

const phases = ["diff", "read", "reconcile", "delete"] as const;
const observe = (
  service: Effect.Success<typeof LogStream.provider>,
  phase: (typeof phases)[number],
  output: LogStream.LogStreamAttributes,
  props: LogStream.LogStreamProps = axiom,
) => {
  switch (phase) {
    case "diff":
      return diff(service, output, props).pipe(Effect.asVoid);
    case "read":
      return service
        .read({ ...lifecycle, olds: props, output })
        .pipe(Effect.asVoid);
    case "reconcile":
      return service
        .reconcile({
          ...lifecycle,
          olds: props,
          news: props,
          output,
        })
        .pipe(Effect.asVoid);
    case "delete":
      return service.delete({ ...lifecycle, olds: props, output });
  }
};

it.effect.each(["read", "reconcile"] as const)(
  "stops %s on a readable hand edit",
  (phase) =>
    withProvider((service, mock) =>
      Effect.gen(function* () {
        const output = yield* create(service);
        const found = yield* mock.client.getLogStream(
          target.deploymentUrl,
          target.deployKey,
          output.id,
        );
        const live = Redacted.value(found);
        if (live.logStreamType !== "axiom")
          return yield* Effect.die("Expected Axiom fixture");
        mock.state.logStreams.set(target.deploymentUrl, [
          Redacted.make({ ...live, datasetName: "hand-edited" }),
        ]);
        const planned = yield* diff(service, output);
        expect(planned).toEqual({ action: "update" });
        const result = yield* observe(service, phase, output).pipe(
          Effect.result,
        );
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "LogStreamDrift", id: output.id, kind: "axiom" },
        });
        expect(mock.client.updateLogStream).not.toHaveBeenCalled();
        expect(mock.client.deleteLogStream).not.toHaveBeenCalled();
      }),
    ),
);

it.effect.each(["diff", "read", "reconcile"] as const)(
  "stops %s when the recorded stream was deleted",
  (phase) =>
    withProvider((service, mock) =>
      Effect.gen(function* () {
        const output = yield* create(service);
        mock.state.logStreams.set(target.deploymentUrl, []);
        const result = yield* observe(service, phase, output).pipe(
          Effect.result,
        );
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "LogStreamRecoveryRequired",
            kind: "axiom",
            ids: [output.id],
          },
        });
        expect(mock.client.createLogStream).toHaveBeenCalledTimes(1);
      }),
    ),
);

it.effect.each(["read", "reconcile"] as const)(
  "never adopts an existing stream during %s",
  (phase) =>
    withProvider((service, mock) =>
      Effect.gen(function* () {
        const first = yield* create(service);
        const operation =
          phase === "read"
            ? service.read({ ...lifecycle, olds: axiom, output: undefined })
            : create(service);
        const result = yield* operation.pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "LogStreamRecoveryRequired",
            kind: "axiom",
            ids: [first.id],
          },
        });
        expect(mock.client.createLogStream).toHaveBeenCalledTimes(1);
      }),
    ),
);

it.effect.each([
  sentry,
  { ...axiom, deploymentUrl: "https://another-otter.convex.cloud" },
])("replaces a changed kind or deployment", (news) =>
  withProvider((service) =>
    Effect.gen(function* () {
      const output = yield* create(service);
      const planned = yield* diff(service, output, news, axiom);
      expect(planned).toEqual({ action: "replace" });
      const result = yield* service
        .reconcile({ ...lifecycle, olds: axiom, news, output })
        .pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "LogStreamRecoveryRequired", ids: [output.id] },
      });
    }),
  ),
);

it.effect("ignores status transitions and is idempotent on removal", () =>
  withProvider((service, mock) =>
    Effect.gen(function* () {
      const output = yield* create(service, webhook);
      const found = yield* mock.client.getLogStream(
        target.deploymentUrl,
        target.deployKey,
        output.id,
      );
      const live = Redacted.value(found);
      mock.state.logStreams.set(target.deploymentUrl, [
        Redacted.make({
          ...live,
          status: { type: "failed", reason: "made-up-status-secret" },
        }),
      ]);
      const planned = yield* diff(service, output, webhook);
      expect(planned).toBeUndefined();
      const read = yield* service.read({ ...lifecycle, olds: webhook, output });
      expect(read).toEqual(output);
      yield* service.delete({ ...lifecycle, olds: webhook, output });
      yield* service.delete({ ...lifecycle, olds: webhook, output });
      const absent = yield* mock.client
        .getLogStream(target.deploymentUrl, target.deployKey, output.id)
        .pipe(Effect.result);
      expect(absent).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConvexNotFound" },
      });
    }),
  ),
);

// Exercise untyped callers that bypass the public props contract.
const disabled = [
  {
    ...target,
    kind: "datadog",
    siteLocation: "US1",
    ddApiKey: Redacted.make("made-up-datadog-key"),
    ddTags: [],
  },
  {
    ...target,
    kind: "postHogLogs",
    apiKey: Redacted.make("made-up-posthog-key"),
  },
  {
    ...target,
    kind: "postHogErrorTracking",
    apiKey: Redacted.make("made-up-posthog-error-key"),
  },
  {
    ...target,
    kind: "s3Export",
    bucket: "example",
    region: "us-east-1",
    accessKeyId: Redacted.make("made-up-s3-id"),
    secretAccessKey: Redacted.make("made-up-s3-key"),
    period: "hourly",
  },
] as unknown as ReadonlyArray<LogStream.LogStreamProps>;
it.effect.each(disabled)("refuses $kind before any network mutation", (props) =>
  withProvider((service, mock) =>
    Effect.gen(function* () {
      const reconciled = yield* create(service, props).pipe(Effect.result);
      expect(reconciled).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "LogStreamNotEnabled", kind: props.kind },
      });
      const read = yield* service
        .read({ ...lifecycle, olds: props, output: undefined })
        .pipe(Effect.result);
      expect(read).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "LogStreamNotEnabled", kind: props.kind },
      });
      const planned = yield* service
        .diff({
          ...lifecycle,
          news: props,
          olds: props,
          output: undefined,
          oldBindings: [],
          newBindings: [],
        })
        .pipe(Effect.result);
      expect(planned).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "LogStreamNotEnabled", kind: props.kind },
      });
      expect(mock.client.createLogStream).not.toHaveBeenCalled();
      expect(mock.client.updateLogStream).not.toHaveBeenCalled();
      expect(mock.client.listLogStreams).not.toHaveBeenCalled();
    }),
  ),
);

it.effect.each(disabled)(
  "rejects $kind before unresolved props during diff",
  (props) =>
    withProvider((service, mock) =>
      Effect.gen(function* () {
        const result = yield* service
          .diff({
            ...lifecycle,
            olds: props,
            news: {
              ...props,
              deploymentUrl: Effect.succeed(target.deploymentUrl),
            },
            output: undefined,
            oldBindings: [],
            newBindings: [],
          })
          .pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "LogStreamNotEnabled", kind: props.kind },
        });
        expect(mock.client.createLogStream).not.toHaveBeenCalled();
        expect(mock.client.listLogStreams).not.toHaveBeenCalled();
      }),
    ),
);

it.effect(
  "refuses a create response whose read identifies another stream",
  () =>
    withProvider((service, mock) =>
      Effect.gen(function* () {
        mock.client.getLogStream.mockImplementationOnce(() =>
          Effect.succeed(
            Redacted.make({
              id: "different-stream",
              logStreamType: "sentry",
              tags: null,
              status: { type: "active" },
            }),
          ),
        );
        const result = yield* create(service).pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "LogStreamRecoveryRequired",
            kind: "axiom",
            ids: ["stream-1"],
          },
        });
      }),
    ),
);

it.effect(
  "returns the live webhook secret when it changed between create and read",
  () =>
    withProvider((service, mock) =>
      Effect.gen(function* () {
        const original = mock.client.getLogStream.getMockImplementation();
        if (original === undefined)
          return yield* Effect.die("Missing fake get implementation");
        mock.client.getLogStream.mockImplementationOnce((url, key, id) =>
          original(url, key, id).pipe(
            Effect.map((stream) => {
              const live = Redacted.value(stream);
              return Redacted.make(
                live.logStreamType === "webhook"
                  ? { ...live, hmacSecret: "made-up-rotated-hmac" }
                  : live,
              );
            }),
          ),
        );
        const output = yield* create(service, webhook);
        expect(output.hmacSecret && Redacted.value(output.hmacSecret)).toBe(
          "made-up-rotated-hmac",
        );
      }),
    ),
);

it.effect(
  "refreshes the live HMAC on read and reconcile without mutating inputs",
  () =>
    withProvider((service, mock) =>
      Effect.gen(function* () {
        const output = yield* create(service, webhook);
        const found = yield* mock.client.getLogStream(
          target.deploymentUrl,
          target.deployKey,
          output.id,
        );
        const live = Redacted.value(found);
        if (live.logStreamType !== "webhook")
          return yield* Effect.die("Expected webhook fixture");
        mock.state.logStreams.set(target.deploymentUrl, [
          Redacted.make({ ...live, hmacSecret: "made-up-rotated-hmac" }),
        ]);
        const planned = yield* diff(service, output, webhook);
        expect(planned).toEqual({ action: "update" });
        const read = yield* service.read({
          ...lifecycle,
          olds: webhook,
          output,
        });
        const reconciled = yield* service.reconcile({
          ...lifecycle,
          olds: webhook,
          news: webhook,
          output,
        });
        for (const refreshed of [read, reconciled]) {
          expect(Redacted.isRedacted(refreshed?.hmacSecret)).toBe(true);
          expect(
            refreshed?.hmacSecret && Redacted.value(refreshed.hmacSecret),
          ).toBe("made-up-rotated-hmac");
          expect(refreshed).toEqual({
            id: output.id,
            kind: "webhook",
            hmacSecret: Redacted.make("made-up-rotated-hmac"),
          });
        }
        expect(output.hmacSecret && Redacted.value(output.hmacSecret)).toBe(
          "made-up-hmac-secret",
        );
        expect(mock.client.updateLogStream).not.toHaveBeenCalled();
        const stable = yield* diff(service, reconciled, webhook);
        expect(stable).toBeUndefined();
      }),
    ),
);

it.effect.each(["id", "kind"] as const)(
  "never deletes a response with a different %s",
  (field) =>
    withProvider((service, mock) =>
      Effect.gen(function* () {
        const output = yield* create(service, webhook);
        mock.client.getLogStream.mockReturnValueOnce(
          Effect.succeed(
            Redacted.make(
              field === "id"
                ? {
                    ...Redacted.value(
                      (
                        mock.state.logStreams.get(target.deploymentUrl) ?? []
                      )[0],
                    ),
                    id: "foreign-stream",
                  }
                : {
                    id: output.id,
                    logStreamType: "sentry",
                    tags: null,
                    status: { type: "active" },
                  },
            ),
          ),
        );
        const result = yield* service
          .delete({ ...lifecycle, olds: webhook, output })
          .pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "LogStreamRecoveryRequired" },
        });
        expect(mock.client.deleteLogStream).not.toHaveBeenCalled();
      }),
    ),
);

it.effect.each([401, 403])(
  "preserves HTTP %s as an authorization error during observation",
  (status) =>
    withProvider((service, mock) =>
      Effect.gen(function* () {
        const output = yield* create(service);
        const error = ConvexApiError.make({
          operation: "getLogStream",
          status,
          code: "HttpError",
        });
        const denied = yield* LogStream.provider.pipe(
          Effect.provideService(ConvexClient, {
            ...mock.client,
            getLogStream: () => Effect.fail(error),
          }),
        );
        for (const phase of phases) {
          const result = yield* observe(denied, phase, output).pipe(
            Effect.result,
          );
          expect(result).toMatchObject({ _tag: "Failure", failure: error });
        }
        expect(mock.client.createLogStream).toHaveBeenCalledTimes(1);
        expect(mock.client.deleteLogStream).not.toHaveBeenCalled();
      }),
    ),
);

it.effect("requires recovery after a successful create cannot be read", () =>
  withProvider((service, mock) =>
    Effect.gen(function* () {
      mock.client.getLogStream.mockReturnValueOnce(
        Effect.fail(
          ConvexNotFound.make({
            operation: "getLogStream",
            code: "HttpError",
            status: 404,
          }),
        ),
      );
      const first = yield* create(service).pipe(Effect.result);
      expect(first).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "LogStreamRecoveryRequired", ids: ["stream-1"] },
      });
      const retry = yield* create(service).pipe(Effect.result);
      expect(retry).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "LogStreamRecoveryRequired", ids: ["stream-1"] },
      });
      expect(mock.client.createLogStream).toHaveBeenCalledTimes(1);
    }),
  ),
);
