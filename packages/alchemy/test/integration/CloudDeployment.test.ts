import * as NodeServices from "../fixtures/NodeTestServices";
import { it } from "@effect/vitest";
import { Confect, Convex } from "@confect/alchemy";
import * as Code from "@confect/alchemy/Code";
import * as Deployment from "@confect/alchemy/Deployment";
import * as DeployKey from "@confect/alchemy/DeployKey";
import * as EnvironmentVariables from "@confect/alchemy/EnvironmentVariables";
import * as Project from "@confect/alchemy/Project";
import * as LogStream from "@confect/alchemy/LogStream";
import type { ResourceState } from "alchemy/State/ResourceState";
import { inspect } from "node:util";
import * as Logger from "effect/Logger";
import {
  ConvexClient,
  ConvexApiError,
  ConvexNotFound,
} from "@confect/alchemy/ConvexClient";
import { adopt } from "alchemy/AdoptPolicy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Result from "effect/Result";
import { Providers } from "@confect/alchemy/Providers";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { apply } from "alchemy/Apply";
import { AuthProviders } from "alchemy/Auth/AuthProvider";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import { provideFreshArtifactStore } from "alchemy/Artifacts";
import { layerNonInteractive } from "alchemy/Interaction";
import * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import * as Stack from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import { inMemoryState } from "alchemy/State/InMemoryState";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { describe, expect } from "@effect/vitest";
import { CommandRunner } from "../../src/internal/CommandRunner";
import { PushLock } from "../../src/internal/PushLock";
import {
  mockClient,
  project as existingProject,
  deployment as existingDeployment,
} from "../fixtures/ConvexClient";
import * as Array from "effect/Array";
import * as Record from "effect/Record";

const makeHarness = (
  client: Layer.Layer<ConvexClient>,
  runner: Layer.Layer<CommandRunner>,
  allowAdoption = false,
  initialState: Record<
    string,
    Record<string, Record<string, ResourceState>>
  > = {},
) => {
  const context = Layer.mergeAll(
    Layer.mergeAll(
      CredentialsStoreLive,
      ProfileStoreLive,
      layerNonInteractive(),
      FetchHttpClient.layer,
    ).pipe(Layer.provideMerge(NodeServices.layer)),
    Layer.succeed(Stage, "test"),
    Layer.succeed(AuthProviders, {}),
    Layer.succeed(AlchemyContext, {
      dotAlchemy: ".alchemy",
      dev: false,
      adopt: allowAdoption,
    }),
  );
  const providers = Layer.effect(
    Providers,
    Provider.collection([
      Project.Project,
      Deployment.Deployment,
      DeployKey.DeployKey,
      EnvironmentVariables.EnvironmentVariables,
      Code.Code,
      LogStream.LogStream,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        Project.layer,
        Deployment.layer,
        DeployKey.layer,
        EnvironmentVariables.layer,
        Code.layer,
        LogStream.layer,
      ),
    ),
    Layer.provide(client),
    Layer.provide(runner),
    Layer.provide(
      Layer.succeed(PushLock, {
        withLock: (_deploymentName, effect) => effect,
      }),
    ),
  );
  const state = inMemoryState(initialState);
  const plans: Plan.Plan<unknown>[] = [];
  const run = <A, E, R extends Providers | Stack.StackServices, B, E2, R2>(
    program: Effect.Effect<A, E, R>,
    consume: (plan: Plan.Plan<A>) => Effect.Effect<B, E2, R2>,
  ) =>
    Effect.gen(function* () {
      const services3 = yield* Layer.build(context);
      return yield* Effect.gen(function* () {
        const services2 = yield* Layer.build(state);
        return yield* program.pipe(
          Stack.make({ name: "integration", providers, state }),
          Effect.flatMap((compiled) =>
            Plan.make(compiled).pipe(
              Effect.tap((plan) =>
                Effect.sync(() => {
                  plans.push(plan);
                }),
              ),
              Effect.flatMap(consume),
              Effect.provideContext(compiled.services),
            ),
          ),
          Effect.provideContext(services2),
        );
      }).pipe(
        Effect.scoped,
        provideFreshArtifactStore,
        Effect.provideContext(services3),
      );
    }).pipe(Effect.scoped, Effect.scoped);
  const deploy = <A, E, R extends Providers | Stack.StackServices>(
    program: Effect.Effect<A, E, R>,
  ) => run(program, apply);
  const plan = <A, E, R extends Providers | Stack.StackServices>(
    program: Effect.Effect<A, E, R>,
  ) => run(program, Effect.succeed);
  return Object.assign(deploy, { plans, plan });
};

describe("cloud deployment lifecycle", () => {
  it.effect.each([false, true])(
    "cleans an interrupted create with retry=%s",
    (retry) =>
      Effect.gen(function* () {
        const fixture = mockClient({
          deployKey: "prod:happy-otter-123|integration-test",
        });
        let reject = true;
        const names: string[] = [];
        const client = Layer.succeed(ConvexClient, {
          ...fixture.client,
          createDeployKey: (name, input) =>
            Effect.suspend(() => {
              if (reject) {
                reject = false;
                return Effect.fail(
                  ConvexApiError.make({
                    operation: "createDeployKey",
                    status: 503,
                    code: "HttpError",
                  }),
                );
              }
              return fixture.client.createDeployKey(name, input);
            }),
          listDeployKeys: (name) => {
            names.push(name);
            return name === undefined
              ? Effect.fail(
                  ConvexApiError.make({
                    operation: "listDeployKeys",
                    status: 400,
                    code: "HttpError",
                  }),
                )
              : fixture.client.listDeployKeys();
          },
        });
        let pushes = 0;
        const deploy = makeHarness(
          client,
          Layer.succeed(CommandRunner, {
            prepare: () => Effect.void,
            deploy: () =>
              Effect.sync(() => {
                pushes++;
              }),
          }),
        );
        const resources = Effect.gen(function* () {
          const project = yield* Convex.Project("Project", {
            teamId: 10,
            name: "example",
          }).pipe(RemovalPolicy.destroy());
          const deployment = yield* Convex.Deployment("Deployment", {
            projectId: project.projectId,
            type: "prod",
            reference: "example",
          }).pipe(RemovalPolicy.destroy());
          const key = yield* Convex.DeployKey("Key", {
            deploymentName: deployment.name,
            name: "example",
          });
          const backend = yield* Confect.Backend("Backend", {
            deployment,
            deployKey: key.deployKey,
            env: { ORIGIN: "https://example.com" },
          });
          return { url: backend.url };
        });
        const deployResult = yield* deploy(resources).pipe(Effect.result);
        expect(Result.isFailure(deployResult)).toBe(true);
        expect(fixture.state.projects).toHaveLength(1);
        expect(fixture.state.keys).toHaveLength(0);
        expect(pushes).toBe(0);
        if (retry) {
          const deployResult2 = yield* deploy(resources);
          expect(deployResult2).toEqual({
            url: "https://happy-otter-123.convex.cloud",
          });
          expect(pushes).toBe(1);
        }
        yield* deploy(Effect.succeed({}));
        expect(Array.every(names, (name) => name === "happy-otter-123")).toBe(
          true,
        );
        expect(fixture.state.projects).toHaveLength(0);
        expect(fixture.state.deployments).toHaveLength(0);
        expect(fixture.state.keys).toHaveLength(0);
        expect(fixture.state.variables).toEqual({});
      }),
  );

  it.effect(
    "does not reissue a key when creation succeeded but its secret was lost",
    () =>
      Effect.gen(function* () {
        const fixture = mockClient();
        const deploy = makeHarness(
          Layer.succeed(ConvexClient, {
            ...fixture.client,
            createDeployKey: (name, input) =>
              fixture.client.createDeployKey(name, input).pipe(
                Effect.andThen(
                  Effect.fail(
                    ConvexApiError.make({
                      operation: "createDeployKey",
                      code: "TransportError",
                    }),
                  ),
                ),
              ),
          }),
          Layer.succeed(CommandRunner, {
            prepare: () => Effect.void,
            deploy: () => Effect.void,
          }),
        );
        const resources = Effect.gen(function* () {
          const project = yield* Convex.Project("Project", {
            teamId: 10,
            name: "example",
          });
          const deployment = yield* Convex.Deployment("Deployment", {
            projectId: project.projectId,
            type: "prod",
            reference: "example",
          });
          const key = yield* Convex.DeployKey("Key", {
            deploymentName: deployment.name,
            name: "example",
          });
          return { keyId: key.keyId };
        });
        const deployResult = yield* deploy(resources).pipe(Effect.result);
        expect(Result.isFailure(deployResult)).toBe(true);
        const retried = yield* deploy(resources).pipe(Effect.result);
        expect(retried).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "DeployKeyRecoveryRequired" },
        });
        expect(fixture.client.createDeployKey).toHaveBeenCalledTimes(1);
        expect(fixture.state.keys).toHaveLength(1);
      }),
  );

  it.effect.each([
    { global: false, resource: undefined, succeeds: false },
    { global: true, resource: undefined, succeeds: true },
    { global: true, resource: false, succeeds: false },
    { global: false, resource: true, succeeds: true },
  ])("honors adoption with global=$global, resource=$resource", (scenario) =>
    Effect.gen(function* () {
      const fixture = mockClient();
      fixture.state.projects = [existingProject()];
      fixture.state.deployments = [existingDeployment()];
      const deploy = makeHarness(
        fixture.layer,
        Layer.succeed(CommandRunner, {
          prepare: () => Effect.void,
          deploy: () => Effect.void,
        }),
        scenario.global,
      );
      const resources = Effect.gen(function* () {
        const project = yield* Convex.Project("Project", {
          teamId: 10,
          name: "example",
        }).pipe(adopt(true));
        const declaration = Convex.Deployment("Deployment", {
          projectId: project.projectId,
          type: "prod",
          reference: "example",
        });
        const deployment = yield* scenario.resource === undefined
          ? declaration
          : declaration.pipe(adopt(scenario.resource));
        return { name: deployment.name };
      });
      const result = yield* deploy(resources).pipe(Effect.result);
      if (scenario.succeeds) {
        expect(result).toEqual(Result.succeed({ name: "happy-otter-123" }));
        const deployResult = yield* deploy(resources);
        expect(deployResult).toEqual({
          name: "happy-otter-123",
        });
      } else {
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "OwnedBySomeoneElse" },
        });
      }
      expect(fixture.client.createProject).not.toHaveBeenCalled();
      expect(fixture.client.createDeployment).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    "preserves late-adopted environment originals across a lost update response",
    () =>
      Effect.gen(function* () {
        const fixture = mockClient({
          deployKey: "prod:happy-otter-123|integration-test",
        });
        fixture.state.variables = {
          ORIGIN: Redacted.make("original"),
          UNRELATED: Redacted.make("preserve-me"),
        };
        let loseResponse = true;
        const deploy = makeHarness(
          Layer.succeed(ConvexClient, {
            ...fixture.client,
            updateEnvironmentVariables: (url, key, changes) =>
              fixture.client.updateEnvironmentVariables(url, key, changes).pipe(
                Effect.andThen(
                  Effect.suspend(() => {
                    if (!loseResponse) return Effect.void;
                    loseResponse = false;
                    return Effect.fail(
                      ConvexApiError.make({
                        operation: "updateEnvironmentVariables",
                        code: "TransportError",
                      }),
                    );
                  }),
                ),
              ),
          }),
          Layer.succeed(CommandRunner, {
            prepare: () => Effect.void,
            deploy: () => Effect.void,
          }),
          true,
        );
        const resources = Effect.gen(function* () {
          const project = yield* Convex.Project("Project", {
            teamId: 10,
            name: "example",
          });
          const deployment = yield* Convex.Deployment("Deployment", {
            projectId: project.projectId,
            type: "prod",
            reference: "example",
          });
          const key = yield* Convex.DeployKey("Key", {
            deploymentName: deployment.name,
            name: "example",
          });
          const backend = yield* Confect.Backend("Backend", {
            deployment,
            deployKey: key.deployKey,
            env: { ORIGIN: "replacement" },
          });
          return { url: backend.url };
        });
        const deployResult = yield* deploy(resources).pipe(Effect.result);
        expect(Result.isFailure(deployResult)).toBe(true);
        yield* deploy(resources);
        expect(Redacted.value(fixture.state.variables.ORIGIN)).toBe(
          "replacement",
        );
        yield* deploy(Effect.succeed({}));
        expect(Redacted.value(fixture.state.variables.ORIGIN)).toBe("original");
        expect(Redacted.value(fixture.state.variables.UNRELATED)).toBe(
          "preserve-me",
        );
        expect(fixture.state.keys).toHaveLength(0);
      }),
  );

  it.effect(
    "orders environment, codegen, and push, then retains data on removal",
    () =>
      Effect.gen(function* () {
        const fixture = mockClient({
          deployKey: "prod:happy-otter-123|integration-test",
        });
        const operations: string[] = [];
        const runner = Layer.succeed(CommandRunner, {
          prepare: () =>
            Effect.sync(() => {
              expect(Redacted.value(fixture.state.variables.ORIGIN)).toBe(
                "https://example.com",
              );
              operations.push("codegen");
            }),
          deploy: () =>
            Effect.sync(() => {
              expect(operations.at(-1)).toBe("codegen");
              operations.push("deploy");
            }),
        });
        const deploy = makeHarness(fixture.layer, runner);
        const resources = Effect.gen(function* () {
          const project = yield* Convex.Project("Project", {
            teamId: 10,
            name: "example",
          });
          const deployment = yield* Convex.Deployment("Deployment", {
            projectId: project.projectId,
            type: "prod",
            reference: "example",
          });
          const key = yield* Convex.DeployKey("Key", {
            deploymentName: deployment.name,
            name: "example",
          });
          const backend = yield* Confect.Backend("Backend", {
            deployment,
            deployKey: key.deployKey,
            env: { ORIGIN: "https://example.com" },
          });
          return { url: backend.url };
        });
        const first = yield* deploy(resources);
        expect(first).toEqual({ url: "https://happy-otter-123.convex.cloud" });
        yield* deploy(resources);
        expect(operations).toEqual(["codegen", "deploy", "codegen", "deploy"]);
        expect(fixture.client.createProject).toHaveBeenCalledTimes(1);
        expect(fixture.client.createDeployment).toHaveBeenCalledTimes(1);
        expect(fixture.client.createDeployKey).toHaveBeenCalledTimes(1);
        expect(fixture.client.updateEnvironmentVariables).toHaveBeenCalledTimes(
          1,
        );
        fixture.state.projects[0].name = "changed-outside-alchemy";
        fixture.state.variables.ORIGIN = Redacted.make("https://wrong.example");
        fixture.state.variables.UNRELATED = Redacted.make("preserve-me");
        yield* deploy(resources);
        expect(fixture.state.projects[0].name).toBe("example");
        expect(fixture.client.updateEnvironmentVariables).toHaveBeenCalledTimes(
          2,
        );
        yield* deploy(Effect.succeed({}));
        expect(fixture.state.projects).toHaveLength(1);
        expect(fixture.state.deployments).toHaveLength(1);
        expect(fixture.state.keys).toHaveLength(0);
        expect(Record.keys(fixture.state.variables)).toEqual(["UNRELATED"]);
        expect(Redacted.value(fixture.state.variables.UNRELATED)).toBe(
          "preserve-me",
        );
        expect(operations).toHaveLength(6);
      }),
  );
});

const logTarget = {
  deploymentUrl: "https://happy-otter-123.convex.cloud",
  deployKey: Redacted.make("made-up-engine-deploy-key"),
};
const logConfigs = [
  {
    ...logTarget,
    kind: "axiom",
    apiKey: Redacted.make("made-up-engine-axiom-key"),
    datasetName: "backend",
    attributes: [],
  },
  {
    ...logTarget,
    kind: "sentry",
    dsn: Redacted.make("made-up-engine-sentry-dsn"),
    tags: { app: "notes" },
  },
  {
    ...logTarget,
    kind: "webhook",
    url: Redacted.make(
      "https://user:made-up-webhook-password@logs.example.test/made-up-webhook-token",
    ),
    format: "jsonl",
  },
] as const satisfies readonly LogStream.LogStreamProps[];
const noCommands = Layer.succeed(CommandRunner, {
  prepare: () => Effect.void,
  deploy: () => Effect.void,
});
const logResources = (props: LogStream.LogStreamProps) =>
  Effect.gen(function* () {
    const stream = yield* Convex.LogStream("Logs", props);
    return { id: stream.id, hmacSecret: stream.hmacSecret };
  });

describe("log stream engine lifecycle", () => {
  it.effect(
    "refreshes a rotated HMAC through a noop plan and still destroys",
    () =>
      Effect.gen(function* () {
        const fixture = mockClient();
        const deploy = makeHarness(fixture.layer, noCommands);
        const props = logConfigs[2];
        const first = yield* deploy(logResources(props));
        const found = yield* fixture.client.getLogStream(
          props.deploymentUrl,
          props.deployKey,
          first.id,
        );
        const live = Redacted.value(found);
        if (live.logStreamType !== "webhook")
          return yield* Effect.die("Expected webhook fixture");
        fixture.state.logStreams.set(props.deploymentUrl, [
          Redacted.make({ ...live, hmacSecret: "made-up-rotated-hmac" }),
        ]);
        const refreshed = yield* deploy(logResources(props));
        expect(deploy.plans.at(-1)?.resources.Logs.action).toBe("noop");
        expect(Redacted.isRedacted(refreshed.hmacSecret)).toBe(true);
        expect(
          refreshed.hmacSecret && Redacted.value(refreshed.hmacSecret),
        ).toBe("made-up-rotated-hmac");
        expect(fixture.client.updateLogStream).not.toHaveBeenCalled();
        yield* deploy(Effect.succeed({}));
        expect(fixture.client.deleteLogStream).toHaveBeenCalledWith(
          props.deploymentUrl,
          props.deployKey,
          first.id,
        );
      }),
  );

  it.effect(
    "redeploys immediately after destroy while deletion is listed",
    () =>
      Effect.gen(function* () {
        const fixture = mockClient();
        const deploy = makeHarness(fixture.layer, noCommands);
        const props = logConfigs[0];
        const first = yield* deploy(logResources(props));
        yield* deploy(Effect.succeed({}));
        const listed = yield* fixture.client.listLogStreams(
          props.deploymentUrl,
        );
        expect(Array.map(listed, Redacted.value)).toContainEqual(
          expect.objectContaining({
            id: first.id,
            status: { type: "deleting" },
          }),
        );
        const next = yield* deploy(logResources(props));
        expect(next.id).not.toBe(first.id);
        yield* deploy(logResources(props));
        expect(deploy.plans.at(-1)?.resources.Logs.action).toBe("noop");
      }),
  );

  it.effect("converges on removal after a hand delete and can redeploy", () =>
    Effect.gen(function* () {
      const fixture = mockClient();
      const deploy = makeHarness(fixture.layer, noCommands);
      const props = logConfigs[0];
      const first = yield* deploy(logResources(props));
      yield* fixture.client.deleteLogStream(
        props.deploymentUrl,
        props.deployKey,
        first.id,
      );
      const missing = yield* fixture.client
        .getLogStream(props.deploymentUrl, props.deployKey, first.id)
        .pipe(Effect.result);
      expect(missing).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConvexNotFound" },
      });
      yield* deploy(Effect.succeed({}));
      const next = yield* deploy(logResources(props));
      expect(next.id).not.toBe(first.id);
    }),
  );

  it.effect("destroys an owned stream despite a readable hand edit", () =>
    Effect.gen(function* () {
      const fixture = mockClient();
      const deploy = makeHarness(fixture.layer, noCommands);
      const props = logConfigs[0];
      const first = yield* deploy(logResources(props));
      const found = yield* fixture.client.getLogStream(
        props.deploymentUrl,
        props.deployKey,
        first.id,
      );
      const live = Redacted.value(found);
      if (live.logStreamType !== "axiom")
        return yield* Effect.die("Expected Axiom fixture");
      fixture.state.logStreams.set(props.deploymentUrl, [
        Redacted.make({ ...live, datasetName: "hand-edited" }),
      ]);
      yield* deploy(Effect.succeed({}));
      expect(fixture.client.deleteLogStream).toHaveBeenCalledWith(
        props.deploymentUrl,
        props.deployKey,
        first.id,
      );
    }),
  );

  it.effect(
    "rejects a disabled kind during plan with unresolved deployment outputs",
    () =>
      Effect.gen(function* () {
        const fixture = mockClient();
        const deploy = makeHarness(fixture.layer, noCommands);
        const planned = yield* deploy
          .plan(
            Effect.gen(function* () {
              const project = yield* Convex.Project("Project", {
                teamId: 10,
                name: "example",
              });
              const deployment = yield* Convex.Deployment("Deployment", {
                projectId: project.projectId,
                type: "prod",
              });
              const key = yield* Convex.DeployKey("Key", {
                deploymentName: deployment.name,
              });
              yield* Convex.LogStream("Logs", {
                kind: "datadog",
                deploymentUrl: deployment.url,
                deployKey: key.deployKey,
                ddApiKey: Redacted.make("made-up-disabled-token"),
                siteLocation: "US1",
                ddTags: [],
              });
            }),
          )
          .pipe(Effect.result);
        expect(planned).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "LogStreamNotEnabled", kind: "datadog" },
        });
        expect(fixture.client.createProject).not.toHaveBeenCalled();
        expect(fixture.client.createDeployment).not.toHaveBeenCalled();
        expect(fixture.client.createDeployKey).not.toHaveBeenCalled();
        expect(fixture.client.createLogStream).not.toHaveBeenCalled();
      }),
  );

  it.effect("treats a delete race returning 404 as successful removal", () =>
    Effect.gen(function* () {
      const fixture = mockClient();
      const deploy = makeHarness(fixture.layer, noCommands);
      const props = logConfigs[0];
      const first = yield* deploy(logResources(props));
      fixture.client.deleteLogStream.mockReturnValueOnce(
        Effect.fail(
          ConvexNotFound.make({
            operation: "deleteLogStream",
            code: "HttpError",
            status: 404,
          }),
        ),
      );
      yield* deploy(Effect.succeed({}));
      expect(deploy.plans.at(-1)?.deletions.Logs).toBeDefined();
      expect(fixture.client.deleteLogStream).toHaveBeenCalledWith(
        props.deploymentUrl,
        props.deployKey,
        first.id,
      );
    }),
  );

  it.effect.each([
    { ...logConfigs[1] },
    { ...logConfigs[0], deploymentUrl: "https://other-backend.convex.cloud" },
  ])("stops a replacement plan when its destination is already owned", (next) =>
    Effect.gen(function* () {
      const fixture = mockClient();
      const deploy = makeHarness(fixture.layer, noCommands);
      const other = makeHarness(fixture.layer, noCommands);
      const first = yield* deploy(logResources(logConfigs[0]));
      const occupied = yield* other(logResources(next));
      const result = yield* deploy(logResources(next)).pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "LogStreamRecoveryRequired",
          kind: next.kind,
          ids: [occupied.id],
        },
      });
      expect(deploy.plans).toHaveLength(1);
      expect(fixture.client.deleteLogStream).not.toHaveBeenCalled();
      expect(fixture.client.updateLogStream).not.toHaveBeenCalled();
      expect(fixture.client.createLogStream).toHaveBeenCalledTimes(2);
      const original = yield* fixture.client.getLogStream(
        logTarget.deploymentUrl,
        logTarget.deployKey,
        first.id,
      );
      expect(Redacted.value(original).id).toBe(first.id);
    }),
  );

  it.effect.each(logConfigs)(
    "creates, keeps, updates and removes $kind through plan and apply",
    (props) =>
      Effect.gen(function* () {
        const fixture = mockClient();
        const deploy = makeHarness(fixture.layer, noCommands);
        const first = yield* deploy(logResources(props));
        expect(first.id).toBe("stream-1");
        yield* deploy(logResources(props));
        expect(deploy.plans.at(-1)?.resources.Logs.action).toBe("noop");
        const next =
          props.kind === "axiom"
            ? {
                ...props,
                apiKey: Redacted.make("made-up-engine-new-axiom-key"),
                datasetName: "next",
              }
            : props.kind === "sentry"
              ? {
                  ...props,
                  dsn: Redacted.make("made-up-engine-new-sentry-dsn"),
                  tags: { app: "next" },
                }
              : { ...props, format: "json" as const };
        const updated = yield* deploy(logResources(next));
        expect(updated.id).toBe(first.id);
        expect(deploy.plans.at(-1)?.resources.Logs.action).toBe("update");
        yield* deploy(logResources(next));
        expect(deploy.plans.at(-1)?.resources.Logs.action).toBe("noop");
        expect(fixture.client.createLogStream).toHaveBeenCalledTimes(1);
        expect(fixture.client.updateLogStream).toHaveBeenCalledTimes(1);
        yield* deploy(Effect.succeed({}));
        expect(fixture.state.logStreams.get(logTarget.deploymentUrl)).toEqual(
          [],
        );
      }),
  );

  it.effect.each([
    { ...logConfigs[1] },
    { ...logConfigs[0], deploymentUrl: "https://other-backend.convex.cloud" },
  ])("replaces a changed kind or deployment through the engine", (next) =>
    Effect.gen(function* () {
      const fixture = mockClient();
      const deploy = makeHarness(fixture.layer, noCommands);
      const first = yield* deploy(logResources(logConfigs[0]));
      const replaced = yield* deploy(logResources(next));
      expect(replaced.id).not.toBe(first.id);
      expect(deploy.plans.at(-1)?.resources.Logs.action).toBe("replace");
      const oldStreams =
        fixture.state.logStreams.get(logTarget.deploymentUrl) ?? [];
      expect(
        Array.some(
          oldStreams,
          (stream) => Redacted.value(stream).id === first.id,
        ),
      ).toBe(false);
      expect(fixture.client.updateLogStream).not.toHaveBeenCalled();
    }),
  );

  it.effect.each(["drift", "deleted", "record"] as const)(
    "stops the plan on $0 without recreating or overwriting",
    (fault) =>
      Effect.gen(function* () {
        const fixture = mockClient();
        const persisted: Record<
          string,
          Record<string, Record<string, ResourceState>>
        > = {};
        const deploy = makeHarness(fixture.layer, noCommands, true, persisted);
        const props = logConfigs[2];
        const first = yield* deploy(logResources(props));
        const found = yield* fixture.client.getLogStream(
          props.deploymentUrl,
          props.deployKey,
          first.id,
        );
        const live = Redacted.value(found);
        if (fault === "drift" && live.logStreamType === "webhook")
          fixture.state.logStreams.set(props.deploymentUrl, [
            Redacted.make({ ...live, url: "https://hand-edit.example.test" }),
          ]);
        if (fault === "deleted")
          fixture.state.logStreams.set(props.deploymentUrl, []);
        if (fault === "record") delete persisted.integration.test.Logs;
        const result = yield* deploy(
          logResources(props).pipe(adopt(true)),
        ).pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag:
              fault === "drift"
                ? "LogStreamDrift"
                : "LogStreamRecoveryRequired",
          },
        });
        expect(fixture.client.createLogStream).toHaveBeenCalledTimes(1);
        expect(fixture.client.updateLogStream).not.toHaveBeenCalled();
        expect(fixture.client.deleteLogStream).not.toHaveBeenCalled();
      }),
  );

  it.effect.each(
    Array.flatMap(logConfigs, (props) =>
      Array.map(["drift", "record"] as const, (fault) => ({ props, fault })),
    ),
  )(
    "keeps $props.kind secrets out of plan forms, state, logs and $fault errors",
    ({ props, fault }) =>
      Effect.gen(function* () {
        const fixture = mockClient();
        const persisted: Record<
          string,
          Record<string, Record<string, ResourceState>>
        > = {};
        const deploy = makeHarness(fixture.layer, noCommands, true, persisted);
        const messages: string[] = [];
        const capture = Logger.make(({ message, cause }) => {
          messages.push(inspect([message, cause], { depth: null }));
        });
        const first = yield* deploy(logResources(props)).pipe(
          Effect.provideService(Logger.CurrentLoggers, new Set([capture])),
        );
        const found = yield* fixture.client.getLogStream(
          props.deploymentUrl,
          props.deployKey,
          first.id,
        );
        const live = Redacted.value(found);
        const changed =
          live.logStreamType === "axiom"
            ? { ...live, datasetName: "edited" }
            : live.logStreamType === "sentry"
              ? { ...live, tags: { app: "edited" } }
              : live.logStreamType === "webhook"
                ? { ...live, format: "json" as const }
                : live;
        fixture.state.logStreams.set(props.deploymentUrl, [
          Redacted.make({
            ...changed,
            status: { type: "failed", reason: "made-up-status-credential" },
          }),
        ]);
        if (fault === "record") delete persisted.integration.test.Logs;
        const result = yield* deploy(
          logResources(props).pipe(adopt(true)),
        ).pipe(
          Effect.result,
          Effect.provideService(Logger.CurrentLoggers, new Set([capture])),
        );
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag:
              fault === "drift"
                ? "LogStreamDrift"
                : "LogStreamRecoveryRequired",
          },
        });
        const shown = Array.join(
          [
            inspect([deploy.plans, first, result, messages, persisted], {
              depth: null,
            }),
            // oxlint-disable-next-line effecttsgo/global-json-in-effect, effecttsgo/prefer-schema-over-json -- Exercise the public JSON.stringify rendering exactly.
            JSON.stringify([deploy.plans, first, result, messages, persisted]),
            ...Array.map(deploy.plans, Plan.printPlan),
          ],
          "\n",
        );
        for (const secret of [
          "made-up-engine-deploy-key",
          "made-up-engine-axiom-key",
          "made-up-engine-sentry-dsn",
          "made-up-hmac-secret",
          "made-up-status-credential",
          "made-up-webhook-password",
          "made-up-webhook-token",
        ])
          expect(shown).not.toContain(secret);
      }),
  );

  it.effect(
    "does not reissue after a create succeeds but its response is lost",
    () =>
      Effect.gen(function* () {
        const fixture = mockClient();
        const deploy = makeHarness(
          Layer.succeed(ConvexClient, {
            ...fixture.client,
            createLogStream: (url, key, input) =>
              fixture.client.createLogStream(url, key, input).pipe(
                Effect.andThen(
                  Effect.fail(
                    ConvexApiError.make({
                      operation: "createLogStream",
                      code: "TransportError",
                    }),
                  ),
                ),
              ),
          }),
          noCommands,
        );
        const first = yield* deploy(logResources(logConfigs[2])).pipe(
          Effect.result,
        );
        expect(first).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ConvexApiError" },
        });
        const retry = yield* deploy(logResources(logConfigs[2])).pipe(
          Effect.result,
        );
        expect(retry).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "LogStreamRecoveryRequired" },
        });
        expect(fixture.client.createLogStream).toHaveBeenCalledTimes(1);
      }),
  );
});
