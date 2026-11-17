import type { ScopedPlanStatusSession } from "alchemy/Report";
import type { PlatformUpdateDeploymentArgs } from "@convex-dev/platform/managementApi";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { vi } from "vitest";

import {
  ConvexClient,
  ConvexNotFound,
  ConvexConflict,
  ConvexApiError,
  type LogStreamConfig,
  type CreateLogStreamInput,
  type UpdateLogStreamInput,
  type CreatedLogStream,
  type Deployment,
  type DeployKey,
  type Project,
  type UsageLimit,
  type UsageLimitInput,
  type CreateDeploymentInput,
  type UpdateProjectInput,
} from "../../src/ConvexClient";
import * as Option from "effect/Option";
import * as Array from "effect/Array";
import * as Struct from "effect/Struct";

const topicOrder = [
  "verification",
  "console",
  "function_execution",
  "exception",
  "audit_log",
  "scheduler_stats",
  "scheduled_job_lag",
  "current_storage_usage",
  "concurrency_stats",
  "storage_api_bandwidth",
  "ai_gateway_usage",
  "log_stream_egress",
  "custom_audit",
] as const;
const normalizeTopics = (
  topics: readonly (typeof topicOrder)[number][] | null | undefined,
) =>
  topics == null
    ? null
    : Array.filter(topicOrder, (topic) => Array.contains(topics, topic));

export const lifecycle = {
  id: "test",
  fqn: "test",
  instanceId: "0123456789abcdef",
  bindings: [],
  session: {
    note: () => Effect.void,
  } satisfies ScopedPlanStatusSession,
};

export const project = (overrides: Partial<Project> = {}): Project => ({
  id: 1,
  teamId: 10,
  name: "example",
  slug: "example",
  teamSlug: "team",
  createTime: 0,
  ...overrides,
});

export const deployment = (
  overrides: Partial<Extract<Deployment, { kind: "cloud" }>> = {},
): Extract<Deployment, { kind: "cloud" }> => ({
  id: 1,
  name: "happy-otter-123",
  projectId: 1,
  deploymentType: "prod",
  kind: "cloud",
  reference: "example",
  region: "aws-us-east-1",
  deploymentUrl: "https://happy-otter-123.convex.cloud",
  isDefault: false,
  class: "default",
  createTime: 0,
  ...overrides,
});

export const key = (overrides: Partial<DeployKey> = {}): DeployKey => ({
  id: 1,
  name: "example",
  creationTime: 0,
  allowedActions: ["deployment:deploy"],
  ...overrides,
});

export const mockClient = (options: { readonly deployKey?: string } = {}) => {
  const issuedKeys = new Map<string, number>();
  const state: {
    logStreams: Map<string, LogStreamConfig[]>;
    logStreamSecrets: Map<string, Redacted.Redacted<string>>;
    limits: UsageLimit[];
    projects: Project[];
    deployments: Deployment[];
    keys: DeployKey[];
    variables: Record<string, Redacted.Redacted<string>>;
  } = {
    limits: [],
    projects: [],
    deployments: [],
    keys: [],
    variables: {},
    logStreams: new Map(),
    logStreamSecrets: new Map(),
  };
  let nextStreamId = 1;
  const missing = () =>
    ConvexNotFound.make({ operation: "test", code: "HttpError", status: 404 });
  const client = {
    listUsageLimits: vi.fn(() => Effect.sync(() => state.limits)),
    createUsageLimit: vi.fn((_url: string, input: UsageLimitInput) =>
      Effect.sync(() => {
        const created = { ...input, id: `limit-${state.limits.length + 1}` };
        state.limits.push(created);
        return created;
      }),
    ),
    updateUsageLimit: vi.fn(
      (_url: string, id: string, input: UsageLimitInput) =>
        Effect.suspend(() => {
          if (!Array.some(state.limits, (limit) => limit.id === id))
            return Effect.fail(missing());
          const updated = { ...input, id };
          state.limits = Array.map(state.limits, (limit) =>
            limit.id === id ? updated : limit,
          );
          return Effect.succeed(updated);
        }),
    ),
    deleteUsageLimit: vi.fn((_url: string, id: string) =>
      Effect.suspend(() => {
        if (!Array.some(state.limits, (limit) => limit.id === id))
          return Effect.fail(missing());
        state.limits = Array.filter(state.limits, (limit) => limit.id !== id);
        return Effect.void;
      }),
    ),
    runFunction: vi.fn(() => Effect.die("runFunction is not faked")),
    listProjects: vi.fn(() => Effect.sync(() => state.projects)),
    getProject: vi.fn((id: number) =>
      Effect.suspend(() => {
        const found = Option.getOrUndefined(
          Array.findFirst(state.projects, (value) => value.id === id),
        );
        return found !== undefined
          ? Effect.succeed(found)
          : Effect.fail(missing());
      }),
    ),
    createProject: vi.fn((_teamId: number, input: { projectName: string }) =>
      Effect.sync(() => {
        const created = project({ name: input.projectName });
        state.projects.push(created);
        return { id: created.id, projectId: created.id, slug: created.slug };
      }),
    ),
    updateProject: vi.fn((id: number, input: UpdateProjectInput) =>
      Effect.sync(() => {
        const updated = project({
          id,
          ...(input.name == null ? {} : { name: input.name }),
        });
        state.projects = Array.map(state.projects, (value) =>
          value.id === id ? updated : value,
        );
        return updated;
      }),
    ),
    deleteProject: vi.fn((id: number) =>
      Effect.suspend(() => {
        if (!Array.some(state.projects, (value) => value.id === id))
          return Effect.fail(missing());
        state.projects = Array.filter(
          state.projects,
          (value) => value.id !== id,
        );
        return Effect.void;
      }),
    ),
    listDeployments: vi.fn(() => Effect.sync(() => state.deployments)),
    getDeployment: vi.fn((name: string) =>
      Effect.suspend(() => {
        const found = Option.getOrUndefined(
          Array.findFirst(state.deployments, (value) => value.name === name),
        );
        return found !== undefined
          ? Effect.succeed(found)
          : Effect.fail(missing());
      }),
    ),
    createDeployment: vi.fn(
      (_projectId: number, input: CreateDeploymentInput) =>
        Effect.sync(() => {
          const created = deployment({
            deploymentType: input.type,
            reference: input.reference,
            region: input.region ?? "aws-us-east-1",
            class: input.class ?? "default",
            ...(input.expiresAt === undefined
              ? {}
              : { expiresAt: input.expiresAt }),
          });
          state.deployments.push(created);
          return created;
        }),
    ),
    updateDeployment: vi.fn(
      (name: string, input: PlatformUpdateDeploymentArgs) =>
        Effect.sync(() => {
          state.deployments = Array.map(state.deployments, (value) =>
            value.name === name && value.kind === "cloud"
              ? {
                  ...value,
                  reference: input.reference ?? value.reference,
                  class: input.class ?? value.class,
                  ...(input.expiresAt === undefined
                    ? {}
                    : { expiresAt: input.expiresAt }),
                }
              : value,
          );
        }),
    ),
    deleteDeployment: vi.fn((name: string) =>
      Effect.suspend(() => {
        if (!Array.some(state.deployments, (value) => value.name === name))
          return Effect.fail(missing());
        state.deployments = Array.filter(
          state.deployments,
          (value) => value.name !== name,
        );
        return Effect.void;
      }),
    ),
    listDeployKeys: vi.fn(() => Effect.sync(() => state.keys)),
    createDeployKey: vi.fn((_name: string, input: { name: string }) =>
      Effect.sync(() => {
        state.keys.push(key({ name: input.name }));
        const secret = options.deployKey ?? "test-secret";
        issuedKeys.set(secret, 1);
        return { deployKey: Redacted.make(secret) };
      }),
    ),
    deleteDeployKey: vi.fn(
      (_name: string, identifier: string | Redacted.Redacted<string>) =>
        Effect.suspend(() => {
          const value =
            typeof identifier === "string"
              ? identifier
              : Redacted.value(identifier);
          const id =
            issuedKeys.get(value) ??
            Option.getOrUndefined(
              Array.findFirst(
                state.keys,
                (candidate) => candidate.name === value,
              ),
            )?.id;
          if (!Array.some(state.keys, (candidate) => candidate.id === id))
            return Effect.fail(missing());
          state.keys = Array.filter(
            state.keys,
            (candidate) => candidate.id !== id,
          );
          return Effect.void;
        }),
    ),
    listLogStreams: vi.fn((url: string) =>
      Effect.sync(() => state.logStreams.get(url) ?? []),
    ),
    getLogStream: vi.fn(
      (url: string, _key: Redacted.Redacted<string>, id: string) =>
        Effect.suspend(() => {
          const stream = Option.getOrUndefined(
            Array.findFirst(
              state.logStreams.get(url) ?? [],
              (candidate) =>
                Redacted.value(candidate).id === id &&
                Redacted.value(candidate).status.type !== "deleting",
            ),
          );
          return stream === undefined
            ? Effect.fail(missing())
            : Effect.succeed(stream);
        }),
    ),
    createLogStream: vi.fn(
      (
        url: string,
        _key: Redacted.Redacted<string>,
        input: CreateLogStreamInput,
      ) =>
        Effect.gen(function* (): Effect.fn.Return<
          CreatedLogStream,
          ConvexConflict | ConvexApiError
        > {
          if ("topics" in input && input.topics?.length === 0)
            return yield* ConvexApiError.make({
              operation: "createLogStream",
              status: 400,
              code: "HttpError",
              serverCode: "EmptyLogTopics",
            });
          const streams = state.logStreams.get(url) ?? [];
          if (
            Array.some(
              streams,
              (stream) =>
                Redacted.value(stream).logStreamType === input.logStreamType &&
                Redacted.value(stream).status.type !== "deleting",
            )
          )
            return yield* ConvexConflict.make({
              operation: "createLogStream",
              status: 409,
              code: "HttpError",
            });
          const id = `stream-${nextStreamId++}`;
          const status = { type: "pending" } as const;
          let config: LogStreamConfig;
          switch (input.logStreamType) {
            case "axiom":
              config = Redacted.make({
                id,
                status,
                logStreamType: "axiom",
                datasetName: input.datasetName,
                attributes: input.attributes,
                ...(input.ingestUrl == null
                  ? {}
                  : { ingestUrl: input.ingestUrl }),
                topics: normalizeTopics(input.topics),
              });
              break;
            case "sentry":
              config = Redacted.make({
                id,
                status,
                logStreamType: "sentry",
                ...(input.tags == null ? {} : { tags: input.tags }),
              });
              break;
            case "webhook":
              config = Redacted.make({
                id,
                status,
                logStreamType: "webhook",
                url: new URL(
                  Redacted.isRedacted(input.url)
                    ? Redacted.value(input.url)
                    : input.url,
                ).href,
                format: input.format,
                topics: normalizeTopics(input.topics),
                hmacSecret: "made-up-hmac-secret",
              });
              break;
            default:
              return yield* Effect.die(
                "The log stream fake supports axiom, sentry and webhook.",
              );
          }
          state.logStreams.set(url, [...streams, config]);
          if (input.logStreamType === "axiom")
            state.logStreamSecrets.set(id, input.apiKey);
          if (input.logStreamType === "sentry")
            state.logStreamSecrets.set(id, input.dsn);
          const live = Redacted.value(config);
          return Redacted.make(
            live.logStreamType === "webhook"
              ? { id, logStreamType: "webhook", hmacSecret: live.hmacSecret }
              : { id, logStreamType: live.logStreamType },
          );
        }),
    ),
    updateLogStream: vi.fn(
      (
        url: string,
        _key: Redacted.Redacted<string>,
        id: string,
        input: UpdateLogStreamInput,
      ) =>
        Effect.suspend<void, ConvexApiError | ConvexNotFound, never>(() => {
          if ("topics" in input && input.topics?.length === 0)
            return Effect.fail(
              ConvexApiError.make({
                operation: "updateLogStream",
                status: 400,
                code: "HttpError",
                serverCode: "EmptyLogTopics",
              }),
            );
          const streams = state.logStreams.get(url) ?? [];
          if (
            !Array.some(streams, (stream) => Redacted.value(stream).id === id)
          )
            return Effect.fail(missing());
          if (input.logStreamType === "axiom" && input.apiKey != null)
            state.logStreamSecrets.set(id, input.apiKey);
          if (input.logStreamType === "sentry" && input.dsn != null)
            state.logStreamSecrets.set(id, input.dsn);
          state.logStreams.set(
            url,
            Array.map(streams, (stream) => {
              const live = Redacted.value(stream);
              if (live.id !== id) return stream;
              switch (input.logStreamType) {
                case "axiom":
                  if (live.logStreamType === "axiom")
                    return Redacted.make({
                      ...Struct.omit(live, ["ingestUrl"]),
                      datasetName: input.datasetName ?? live.datasetName,
                      attributes: input.attributes ?? live.attributes,
                      ...((input.ingestUrl === undefined
                        ? live.ingestUrl
                        : input.ingestUrl) == null
                        ? {}
                        : {
                            ingestUrl:
                              input.ingestUrl === undefined
                                ? live.ingestUrl
                                : input.ingestUrl,
                          }),
                      ...(input.topics === undefined
                        ? {}
                        : { topics: normalizeTopics(input.topics) }),
                    });
                  break;
                case "sentry":
                  if (live.logStreamType === "sentry")
                    return Redacted.make({
                      ...Struct.omit(live, ["tags"]),
                      ...((input.tags === undefined ? live.tags : input.tags) ==
                      null
                        ? {}
                        : {
                            tags:
                              input.tags === undefined ? live.tags : input.tags,
                          }),
                    });
                  break;
                case "webhook":
                  if (live.logStreamType === "webhook")
                    return Redacted.make({
                      ...live,
                      url: new URL(
                        Redacted.isRedacted(input.url)
                          ? Redacted.value(input.url)
                          : (input.url ?? live.url),
                      ).href,
                      format: input.format ?? live.format,
                      ...(input.topics === undefined
                        ? {}
                        : { topics: normalizeTopics(input.topics) }),
                    });
                  break;
              }
              return stream;
            }),
          );
          return Effect.void;
        }),
    ),
    deleteLogStream: vi.fn(
      (url: string, _key: Redacted.Redacted<string>, id: string) =>
        Effect.suspend(() => {
          const streams = state.logStreams.get(url) ?? [];
          if (
            !Array.some(streams, (stream) => Redacted.value(stream).id === id)
          )
            return Effect.fail(missing());
          state.logStreams.set(
            url,
            Array.map(streams, (stream) => {
              const live = Redacted.value(stream);
              return live.id === id
                ? Redacted.make({
                    ...live,
                    status: { type: "deleting" } as const,
                  })
                : stream;
            }),
          );
          return Effect.void;
        }),
    ),
    listEnvironmentVariables: vi.fn(() => Effect.sync(() => state.variables)),
    updateEnvironmentVariables: vi.fn(
      (
        _url: string,
        _key: Redacted.Redacted<string>,
        changes: readonly {
          name: string;
          value?: string | Redacted.Redacted<string> | null;
        }[],
      ) =>
        Effect.sync(() => {
          for (const change of changes) {
            if (change.value == null) delete state.variables[change.name];
            else
              state.variables[change.name] =
                typeof change.value === "string"
                  ? Redacted.make(change.value)
                  : change.value;
          }
        }),
    ),
  } satisfies Context.Service.Shape<typeof ConvexClient>;
  return { client, state, layer: Layer.succeed(ConvexClient, client) };
};
