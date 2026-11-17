import * as Exit from "effect/Exit";
import * as NodeServices from "../fixtures/NodeTestServices";
import { it } from "@effect/vitest";
import { Confect, Convex } from "@confect/alchemy";
import * as Code from "@confect/alchemy/Code";
import * as Deployment from "@confect/alchemy/Deployment";
import * as DeployKey from "@confect/alchemy/DeployKey";
import * as EnvironmentVariables from "@confect/alchemy/EnvironmentVariables";
import * as Project from "@confect/alchemy/Project";
import * as LogStream from "@confect/alchemy/LogStream";
import type { Input, PropsInput } from "alchemy/Input";
import type { ResourceState } from "alchemy/State/ResourceState";
import { inspect } from "node:util";
import * as Logger from "effect/Logger";
import {
  ConvexClient,
  ConvexApiError,
  ConvexNotFound,
  ConvexConflict,
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
import * as Output from "alchemy/Output";
import {
  formatYamlLines,
  formatDeclaredPropertyYaml,
} from "alchemy/Cli/PropertyDiff";
import * as Provider from "alchemy/Provider";
import * as Stack from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import { inMemoryState } from "alchemy/State/InMemoryState";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { assert, describe, expect } from "@effect/vitest";
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
  lockTaken = (_deploymentName: string) => {},
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
        withLock: (_deploymentName, effect) =>
          Effect.suspend(() => {
            lockTaken(_deploymentName);
            return effect;
          }),
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
  ) =>
    run(program, (planned) =>
      apply(planned).pipe(
        // Alchemy's Input.Resolve<void> is never, although apply completes with undefined.
        Effect.map(
          (value): Input.Resolve<A> | (A extends void ? void : never) => value,
        ),
      ),
    );
  const plan = <A, E, R extends Providers | Stack.StackServices>(
    program: Effect.Effect<A, E, R>,
  ) => run(program, Effect.succeed);
  return Object.assign(deploy, { plans, plan, run });
};

describe("cloud deployment lifecycle", () => {
  it.effect.each(["yielded", "effect"] as const)(
    "preserves the %s environment constructor with safety checks",
    (form) =>
      Effect.gen(function* () {
        const fixture = mockClient();
        const deploy = makeHarness(
          fixture.layer,
          Layer.succeed(CommandRunner, {
            prepare: () => Effect.void,
            deploy: () => Effect.void,
          }),
        );
        const props: EnvironmentVariables.EnvironmentVariablesProps = {
          url: "https://happy-otter-123.convex.cloud",
          deployKey: Redacted.make("constructor-test-key"),
          variables: { MANAGED: Redacted.make("constructor-test-secret") },
          retry: { maxAttempts: 3, delay: 100 },
        };
        const resources = Effect.gen(function* () {
          if (form === "yielded") {
            const resource = yield* Convex.EnvironmentVariables;
            yield* resource("Environment", props);
          } else {
            yield* Convex.EnvironmentVariables(
              "Environment",
              Effect.succeed(props),
            );
          }
        });
        yield* deploy(resources);
        yield* deploy(resources);
        expect(Redacted.value(fixture.state.variables.MANAGED)).toBe(
          "constructor-test-secret",
        );
        expect(fixture.client.updateEnvironmentVariables).toHaveBeenCalledTimes(
          1,
        );
        expect(props.retry).toEqual({ maxAttempts: 3, delay: 100 });
      }),
  );

  it.effect(
    "refuses mismatched matching-only adoption in a plan without applying",
    () =>
      Effect.gen(function* () {
        const fixture = mockClient();
        fixture.state.variables.MANAGED = Redacted.make(
          "foreign-adoption-secret",
        );
        const deploy = makeHarness(
          fixture.layer,
          Layer.succeed(CommandRunner, {
            prepare: () => Effect.void,
            deploy: () => Effect.void,
          }),
        );
        const planned = yield* deploy
          .plan(
            Convex.EnvironmentVariables("Environment", {
              url: "https://happy-otter-123.convex.cloud",
              deployKey: Redacted.make("plan-adoption-key"),
              variables: { MANAGED: Redacted.make("desired-adoption-secret") },
              adoptMatching: true,
            }).pipe(Effect.asVoid),
          )
          .pipe(Effect.exit);
        expect(Exit.isFailure(planned)).toBe(true);
        const detail = inspect(planned, { depth: null });
        expect(detail).toContain("OwnedBySomeoneElse");
        for (const secret of [
          "foreign-adoption-secret",
          "desired-adoption-secret",
          "plan-adoption-key",
        ])
          expect(detail).not.toContain(secret);
        expect(
          fixture.client.updateEnvironmentVariables,
        ).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    "counts a deleted owned environment variable as drift during planning",
    () =>
      Effect.gen(function* () {
        const fixture = mockClient();
        const deploy = makeHarness(
          fixture.layer,
          Layer.succeed(CommandRunner, {
            prepare: () => Effect.void,
            deploy: () => Effect.void,
          }),
        );
        const resources = Convex.EnvironmentVariables("Environment", {
          url: "https://happy-otter-123.convex.cloud",
          deployKey: Redacted.make("deleted-variable-key"),
          variables: { MANAGED: Redacted.make("deleted-variable-secret") },
          driftPolicy: "error",
        }).pipe(Effect.asVoid);
        yield* deploy(resources);
        delete fixture.state.variables.MANAGED;
        const planned = yield* deploy.plan(resources).pipe(Effect.exit);
        expect(Exit.isFailure(planned)).toBe(true);
        const detail = inspect(planned, { depth: null });
        expect(detail).toContain("EnvironmentVariableDrift");
        expect(detail).toContain("MANAGED");
        expect(detail).not.toContain("deleted-variable-secret");
        expect(detail).not.toContain("deleted-variable-key");
        expect(fixture.client.updateEnvironmentVariables).toHaveBeenCalledTimes(
          1,
        );
      }),
  );

  it.effect.each([
    { option: "maxAttempts", updating: false },
    { option: "deploymentName", updating: false },
    { option: "maxAttempts", updating: true },
    { option: "deploymentName", updating: true },
    { option: "delay", updating: false },
    { option: "unresolvedAttempts", updating: false },
    { option: "configRetry", updating: false },
    { option: "configLock", updating: false },
    { option: "nestedRetry", updating: false },
    { option: "nestedLock", updating: false },
  ] as const)(
    "refuses resolved invalid $option during an unresolved plan with updating=$updating",
    ({ option, updating }) =>
      Effect.gen(function* () {
        const fixture = mockClient();
        let pushes = 0;
        const deploy = makeHarness(
          fixture.layer,
          Layer.succeed(CommandRunner, {
            prepare: () => Effect.void,
            deploy: () =>
              Effect.sync(() => {
                pushes++;
              }),
          }),
        );
        const resources = (invalid: boolean) =>
          Effect.gen(function* () {
            const source = yield* Convex.Code("Source", {
              deployment: {
                name: "happy-otter-123",
                url: "https://happy-otter-123.convex.cloud",
              },
              deployKey: Redacted.make("prod:happy-otter-123|plan-test-key"),
            });
            yield* Convex.EnvironmentVariables("Environment", {
              url: source.url,
              deployKey: Redacted.make("prod:happy-otter-123|plan-test-key"),
              variables: {
                MANAGED: Redacted.make("invalid-option-plan-secret"),
              },
              ...(invalid && option === "maxAttempts"
                ? { retry: { maxAttempts: 0, delay: "100 millis" as const } }
                : {}),
              ...(invalid && option === "delay"
                ? { retry: { maxAttempts: 3, delay: 0 } }
                : {}),
              ...(invalid && option === "unresolvedAttempts"
                ? {
                    retry: {
                      maxAttempts: Output.map(source.url, () => 3),
                      delay: 0,
                    },
                  }
                : {}),
              ...(invalid && option === "configRetry"
                ? { retry: Config.succeed({ maxAttempts: 0, delay: 100 }) }
                : {}),
              ...(invalid && option === "configLock"
                ? { lock: Config.succeed({ deploymentName: "../../escape" }) }
                : {}),
              ...(invalid && option === "nestedRetry"
                ? { retry: { maxAttempts: Config.succeed(0), delay: 100 } }
                : {}),
              ...(invalid && option === "nestedLock"
                ? { lock: { deploymentName: Config.succeed("../../escape") } }
                : {}),
              ...(invalid && option === "deploymentName"
                ? { lock: { deploymentName: "../../escape" } }
                : {}),
            });
          });
        if (updating) yield* deploy(resources(false));
        const before = pushes;
        const writes =
          fixture.client.updateEnvironmentVariables.mock.calls.length;
        const planned = yield* deploy.plan(resources(true)).pipe(Effect.exit);
        expect(Exit.isFailure(planned)).toBe(true);
        const detail = inspect(planned, { depth: null });
        expect(detail).toContain("EnvironmentVariablesInvalidOption");
        expect(detail).toContain(
          option === "configRetry" || option === "nestedRetry"
            ? "maxAttempts"
            : option === "configLock" || option === "nestedLock"
              ? "deploymentName"
              : option === "unresolvedAttempts"
                ? "delay"
                : option,
        );
        expect(detail).not.toContain("invalid-option-plan-secret");
        expect(pushes).toBe(before);
        expect(fixture.client.updateEnvironmentVariables).toHaveBeenCalledTimes(
          writes,
        );
      }),
  );

  it.effect(
    "refuses an invalid Output lock at apply before taking the lock or writing variables",
    () =>
      Effect.gen(function* () {
        const fixture = mockClient();
        const locks: string[] = [];
        let pushes = 0;
        const deploy = makeHarness(
          fixture.layer,
          Layer.succeed(CommandRunner, {
            prepare: () => Effect.void,
            deploy: () =>
              Effect.sync(() => {
                pushes++;
              }),
          }),
          false,
          {},
          (name) => {
            locks.push(name);
          },
        );
        const resources = Effect.gen(function* () {
          const source = yield* Convex.Code("Source", {
            deployment: {
              name: "happy-otter-123",
              url: "https://happy-otter-123.convex.cloud",
            },
            deployKey: Redacted.make(
              "prod:happy-otter-123|output-lock-key-secret",
            ),
          });
          yield* Convex.EnvironmentVariables("Environment", {
            url: "https://happy-otter-123.convex.cloud",
            deployKey: Redacted.make("output-lock-key-secret"),
            variables: { MANAGED: Redacted.make("output-lock-value-secret") },
            lock: {
              deploymentName: Output.map(source.url, () => "../../escape"),
            },
          });
        });
        const plan = yield* deploy.plan(resources).pipe(Effect.exit);
        expect(Exit.isSuccess(plan)).toBe(true);
        expect(pushes).toBe(0);
        const applied = yield* deploy(resources).pipe(Effect.exit);
        expect(Exit.isFailure(applied)).toBe(true);
        const detail = inspect(applied, { depth: null });
        expect(detail).toContain("EnvironmentVariablesInvalidOption");
        expect(detail).toContain("deploymentName");
        expect(pushes).toBe(1);
        expect(locks).toEqual(["happy-otter-123"]);
        expect(
          fixture.client.updateEnvironmentVariables,
        ).not.toHaveBeenCalled();
        for (const secret of [
          "output-lock-key-secret",
          "output-lock-value-secret",
        ]) {
          expect(detail).not.toContain(secret);
          expect(inspect(plan, { depth: null })).not.toContain(secret);
        }
      }),
  );

  it.effect.each([false, true])(
    "checks newly desired names during planning with an unresolved value=%s",
    (unresolved) =>
      Effect.gen(function* () {
        const fixture = mockClient();
        const deploy = makeHarness(
          fixture.layer,
          Layer.succeed(CommandRunner, {
            prepare: () => Effect.void,
            deploy: () => Effect.void,
          }),
        );
        const resources = (add: boolean) =>
          Effect.gen(function* () {
            const source = yield* Convex.Code("Source", {
              deployment: {
                name: "happy-otter-123",
                url: "https://happy-otter-123.convex.cloud",
              },
              deployKey: Redacted.make("prod:happy-otter-123|plan-test-key"),
            });
            yield* Convex.EnvironmentVariables("Environment", {
              url: "https://happy-otter-123.convex.cloud",
              deployKey: Redacted.make("prod:happy-otter-123|plan-test-key"),
              adoptMatching: true,
              variables: {
                MANAGED: Redacted.make("owned-plan-secret"),
                ...(add
                  ? {
                      NEW: unresolved
                        ? source.url
                        : Redacted.make("desired-plan-secret"),
                    }
                  : {}),
              },
            });
          });
        yield* deploy(resources(false));
        fixture.state.variables.NEW = Redacted.make("live-plan-secret");
        const writes =
          fixture.client.updateEnvironmentVariables.mock.calls.length;
        const planned = yield* deploy.plan(resources(true)).pipe(Effect.exit);
        if (unresolved) {
          expect(Exit.isSuccess(planned)).toBe(true);
          const applied = yield* deploy(resources(true)).pipe(Effect.exit);
          expect(Exit.isFailure(applied)).toBe(true);
          expect(inspect(applied, { depth: null })).toContain(
            "OwnedBySomeoneElse",
          );
          expect(inspect(applied, { depth: null })).not.toContain(
            "live-plan-secret",
          );
        } else {
          expect(Exit.isFailure(planned)).toBe(true);
          expect(inspect(planned, { depth: null })).toContain(
            "OwnedBySomeoneElse",
          );
        }
        for (const secret of [
          "owned-plan-secret",
          "desired-plan-secret",
          "live-plan-secret",
        ])
          expect(inspect(planned, { depth: null })).not.toContain(secret);
        expect(fixture.client.updateEnvironmentVariables).toHaveBeenCalledTimes(
          writes,
        );
        expect(Redacted.value(fixture.state.variables.NEW)).toBe(
          "live-plan-secret",
        );
      }),
  );

  it.effect.each(["create", "update", "external"] as const)(
    "recovers a lost environment write response with strict drift checks (%s)",
    (scenario) =>
      Effect.gen(function* () {
        const fixture = mockClient();
        let loseResponse = false;
        const deploy = makeHarness(
          Layer.succeed(ConvexClient, {
            ...fixture.client,
            updateEnvironmentVariables: (...args) =>
              fixture.client.updateEnvironmentVariables(...args).pipe(
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
        );
        const resources = (value: string) =>
          Convex.EnvironmentVariables("Environment", {
            url: "https://happy-otter-123.convex.cloud",
            deployKey: Redacted.make("test-key"),
            variables: { MANAGED: Redacted.make(value) },
            driftPolicy: "error",
            adoptMatching: true,
          }).pipe(Effect.asVoid);
        if (scenario !== "create")
          yield* deploy(resources("before-write-secret"));
        loseResponse = true;
        const failed = yield* deploy(resources("landed-write-secret")).pipe(
          Effect.exit,
        );
        expect(Exit.isFailure(failed)).toBe(true);
        expect(inspect(failed, { depth: null })).toContain("TransportError");
        expect(inspect(failed, { depth: null })).not.toContain(
          "landed-write-secret",
        );
        expect(Redacted.value(fixture.state.variables.MANAGED)).toBe(
          "landed-write-secret",
        );
        const writes =
          fixture.client.updateEnvironmentVariables.mock.calls.length;
        if (scenario === "external")
          fixture.state.variables.MANAGED = Redacted.make(
            "external-write-secret",
          );
        const rerun = yield* deploy(resources("landed-write-secret")).pipe(
          Effect.exit,
        );
        expect(inspect(rerun, { depth: null })).not.toContain(
          "external-write-secret",
        );
        expect(inspect(rerun, { depth: null })).not.toContain(
          "landed-write-secret",
        );
        if (scenario === "external") {
          expect(Exit.isFailure(rerun)).toBe(true);
          expect(inspect(rerun, { depth: null })).toContain(
            "EnvironmentVariableDrift",
          );
        } else {
          expect(Exit.isSuccess(rerun)).toBe(true);
          yield* deploy(resources("landed-write-secret"));
          expect(Redacted.value(fixture.state.variables.MANAGED)).toBe(
            "landed-write-secret",
          );
        }
        expect(fixture.client.updateEnvironmentVariables).toHaveBeenCalledTimes(
          writes,
        );
      }),
  );

  it.effect.each([
    { operation: "update", shape: "value" },
    { operation: "create", shape: "value" },
    { operation: "update", shape: "map" },
    { operation: "create", shape: "map" },
  ] as const)(
    "recovers a lost $operation response with unresolved desired $shape inputs",
    ({ operation, shape }) => {
      const logs: unknown[] = [];
      return Effect.gen(function* () {
        const logging = yield* Layer.build(
          Logger.layer([
            Logger.make((event) => {
              logs.push(event.message);
            }),
          ]),
        );
        return yield* Effect.gen(function* () {
          const fixture = mockClient();
          const saved: NonNullable<Parameters<typeof inMemoryState>[0]> = {};
          let loseResponse = false;
          const deploy = makeHarness(
            Layer.succeed(ConvexClient, {
              ...fixture.client,
              updateEnvironmentVariables: (...args) =>
                fixture.client.updateEnvironmentVariables(...args).pipe(
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
            false,
            saved,
          );
          const resources = (revision: string) =>
            Effect.gen(function* () {
              const source = yield* Convex.Code("Source", {
                deployment: {
                  name: "happy-otter-123",
                  url: "https://happy-otter-123.convex.cloud",
                },
                deployKey: Redacted.make(
                  "prod:happy-otter-123|recovery-key-secret",
                ),
              });
              const value = Output.map(source.url, (url) =>
                Redacted.make(`${url}/${revision}`),
              );
              const variables =
                shape === "value"
                  ? { MANAGED: value }
                  : Output.map(value, (resolved) => ({ MANAGED: resolved }));
              const props = {
                url: "https://happy-otter-123.convex.cloud",
                deployKey: Redacted.make(
                  "prod:happy-otter-123|recovery-key-secret",
                ),
                variables,
                driftPolicy: "error" as const,
                adoptMatching: true,
              };
              yield* Convex.EnvironmentVariables("Environment", props);
            });
          if (operation === "update")
            yield* deploy(resources("before-write-secret"));
          loseResponse = true;
          const failed = yield* deploy(resources("landed-write-secret")).pipe(
            Effect.exit,
          );
          expect(Exit.isFailure(failed)).toBe(true);
          expect(inspect(failed, { depth: null })).toContain("TransportError");
          const expected =
            "https://happy-otter-123.convex.cloud/landed-write-secret";
          expect(Redacted.value(fixture.state.variables.MANAGED)).toBe(
            expected,
          );
          const writes =
            fixture.client.updateEnvironmentVariables.mock.calls.length;
          const rerun = yield* deploy(resources("landed-write-secret")).pipe(
            Effect.exit,
          );
          expect(Exit.isSuccess(rerun)).toBe(true);
          const plan = yield* deploy
            .plan(resources("landed-write-secret"))
            .pipe(Effect.exit);
          expect(Exit.isSuccess(plan)).toBe(true);
          const second = yield* deploy(resources("landed-write-secret")).pipe(
            Effect.exit,
          );
          expect(Exit.isSuccess(second)).toBe(true);
          expect(
            fixture.client.updateEnvironmentVariables,
          ).toHaveBeenCalledTimes(writes);
          const stored = saved.integration.test.Environment;
          expect(stored.status).toBe("updated");
          const snapshotValue: unknown = stored.attr?.variables?.MANAGED;
          assert(Redacted.isRedacted(snapshotValue));
          expect(Redacted.value(snapshotValue)).toBe(expected);
          for (const secret of [
            "before-write-secret",
            "landed-write-secret",
            "recovery-key-secret",
          ]) {
            for (const result of [failed, rerun, plan, second, logs])
              expect(inspect(result, { depth: null })).not.toContain(secret);
          }
        }).pipe(Effect.provideContext(logging));
      });
    },
  );

  it.effect.each([
    { shape: "value", previouslyEnabled: false },
    { shape: "value", previouslyEnabled: true },
    { shape: "map", previouslyEnabled: false },
    { shape: "map", previouslyEnabled: true },
  ] as const)(
    "refuses drift at apply with unresolved desired $shape and previously enabled safety=$previouslyEnabled",
    ({ shape, previouslyEnabled }) =>
      Effect.gen(function* () {
        const fixture = mockClient();
        let pushes = 0;
        const deploy = makeHarness(
          fixture.layer,
          Layer.succeed(CommandRunner, {
            prepare: () => Effect.void,
            deploy: () =>
              Effect.sync(() => {
                pushes++;
              }),
          }),
        );
        const wantedSecret = Redacted.make("wanted-drift-secret");
        const resources = (safe: boolean) =>
          Effect.gen(function* () {
            const source = yield* Convex.Code("Source", {
              deployment: {
                name: "happy-otter-123",
                url: "https://happy-otter-123.convex.cloud",
              },
              deployKey: Redacted.make("prod:happy-otter-123|drift-key-secret"),
            });
            const wanted = Output.map(source.url, () => wantedSecret);
            yield* Convex.EnvironmentVariables("Environment", {
              url: "https://happy-otter-123.convex.cloud",
              deployKey: Redacted.make("prod:happy-otter-123|drift-key-secret"),
              variables:
                shape === "value"
                  ? { MANAGED: wanted }
                  : Output.map(wanted, (value) => ({ MANAGED: value })),
              ...(safe ? { driftPolicy: "error" as const } : {}),
            });
          });
        yield* deploy(resources(previouslyEnabled));
        fixture.state.variables.MANAGED = Redacted.make("outside-drift-secret");
        const writes =
          fixture.client.updateEnvironmentVariables.mock.calls.length;
        const before = pushes;
        const plan = yield* deploy.plan(resources(true)).pipe(Effect.exit);
        expect(Exit.isSuccess(plan)).toBe(true);
        expect(pushes).toBe(before);
        const applied = yield* deploy(resources(true)).pipe(Effect.exit);
        expect(Exit.isFailure(applied)).toBe(true);
        const detail = inspect(applied, { depth: null });
        expect(detail).toContain("EnvironmentVariableDrift");
        expect(detail).toContain("MANAGED");
        expect(pushes).toBe(before + 1);
        expect(fixture.client.updateEnvironmentVariables).toHaveBeenCalledTimes(
          writes,
        );
        expect(Redacted.value(fixture.state.variables.MANAGED)).toBe(
          "outside-drift-secret",
        );
        for (const secret of [
          "wanted-drift-secret",
          "outside-drift-secret",
          "drift-key-secret",
        ]) {
          expect(detail).not.toContain(secret);
          expect(inspect(plan, { depth: null })).not.toContain(secret);
        }
      }),
  );

  it.effect.each(["value", "map"] as const)(
    "refuses a deleted owned name during planning with unresolved desired %s",
    (shape) =>
      Effect.gen(function* () {
        const fixture = mockClient();
        const deploy = makeHarness(
          fixture.layer,
          Layer.succeed(CommandRunner, {
            prepare: () => Effect.void,
            deploy: () => Effect.void,
          }),
        );
        const resources = Effect.gen(function* () {
          const source = yield* Convex.Code("Source", {
            deployment: {
              name: "happy-otter-123",
              url: "https://happy-otter-123.convex.cloud",
            },
            deployKey: Redacted.make("prod:happy-otter-123|deleted-key-secret"),
          });
          const wanted = Output.map(source.url, () =>
            Redacted.make("deleted-wanted-secret"),
          );
          yield* Convex.EnvironmentVariables("Environment", {
            url: "https://happy-otter-123.convex.cloud",
            deployKey: Redacted.make("prod:happy-otter-123|deleted-key-secret"),
            variables:
              shape === "value"
                ? { MANAGED: wanted }
                : Output.map(wanted, (value) => ({ MANAGED: value })),
            driftPolicy: "error",
          });
        });
        yield* deploy(resources);
        delete fixture.state.variables.MANAGED;
        const plan = yield* deploy.plan(resources).pipe(Effect.exit);
        expect(Exit.isFailure(plan)).toBe(true);
        const detail = inspect(plan, { depth: null });
        expect(detail).toContain("EnvironmentVariableDrift");
        expect(detail).toContain("MANAGED");
        expect(detail).not.toContain("deleted-wanted-secret");
        expect(detail).not.toContain("deleted-key-secret");
        expect(fixture.client.updateEnvironmentVariables).toHaveBeenCalledTimes(
          1,
        );
      }),
  );

  it.effect.each([false, true])(
    "refuses resolved-name drift in a real plan with unresolved inputs and previously enabled safety=%s",
    (previouslyEnabled) =>
      Effect.gen(function* () {
        const fixture = mockClient();
        const deploy = makeHarness(
          fixture.layer,
          Layer.succeed(CommandRunner, {
            prepare: () => Effect.void,
            deploy: () => Effect.void,
          }),
        );
        const deployKey = Redacted.make("prod:happy-otter-123|test-secret");
        const resources = (enableSafety: boolean) =>
          Effect.gen(function* () {
            const source = yield* Convex.Code("Source", {
              deployment: {
                name: "happy-otter-123",
                url: "https://happy-otter-123.convex.cloud",
              },
              deployKey,
              cwd: "nonexistent-plan-test-backend",
            });
            yield* Convex.EnvironmentVariables("Environment", {
              url: "https://happy-otter-123.convex.cloud",
              deployKey,
              variables: {
                MANAGED: source.url,
                SECRET: Redacted.make("plan-secret-value"),
              },
              ...(enableSafety ? { driftPolicy: "error" as const } : {}),
            });
          });
        yield* deploy(resources(previouslyEnabled));
        const unchanged = yield* deploy.plan(resources(previouslyEnabled));
        expect(inspect(unchanged, { depth: null })).not.toContain(
          "plan-secret-value",
        );
        expect(inspect(unchanged, { depth: null })).not.toContain(
          "test-secret",
        );
        fixture.state.variables.SECRET = Redacted.make("drift-secret-value");
        const planned = yield* deploy.plan(resources(true)).pipe(Effect.exit);
        expect(Exit.isFailure(planned)).toBe(true);
        expect(inspect(planned, { depth: null })).toContain(
          "EnvironmentVariableDrift",
        );
        expect(inspect(planned, { depth: null })).toContain("SECRET");
        for (const secret of [
          "plan-secret-value",
          "drift-secret-value",
          "test-secret",
        ])
          expect(inspect(planned, { depth: null })).not.toContain(secret);
        expect(fixture.client.updateEnvironmentVariables).toHaveBeenCalledTimes(
          1,
        );
      }),
  );

  it.effect(
    "adopts a matching environment value through the engine without a general adoption grant",
    () =>
      Effect.gen(function* () {
        const fixture = mockClient();
        fixture.state.variables = { MANAGED: Redacted.make("desired-secret") };
        const deploy = makeHarness(
          fixture.layer,
          Layer.succeed(CommandRunner, {
            prepare: () => Effect.void,
            deploy: () => Effect.void,
          }),
        );
        const resources = Convex.EnvironmentVariables("Environment", {
          url: "https://happy-otter-123.convex.cloud",
          deployKey: Redacted.make("test-key"),
          variables: { MANAGED: Redacted.make("desired-secret") },
          driftPolicy: "error",
          adoptMatching: true,
          unownedPolicy: "error",
          lock: { deploymentName: "happy-otter-123" },
          retry: { maxAttempts: 3, delay: "100 millis" },
        }).pipe(Effect.asVoid);
        yield* deploy(resources);
        yield* deploy(resources);
        yield* deploy(Effect.void);
        expect(
          fixture.client.updateEnvironmentVariables,
        ).not.toHaveBeenCalled();
        expect(Redacted.value(fixture.state.variables.MANAGED)).toBe(
          "desired-secret",
        );
      }),
  );

  it.effect.each([false, true])(
    "refuses a different live value with matching-only adoption and general adoption=%s",
    (generalAdoption) =>
      Effect.gen(function* () {
        const fixture = mockClient();
        fixture.state.variables = {
          MANAGED: Redacted.make("different-secret"),
        };
        const deploy = makeHarness(
          fixture.layer,
          Layer.succeed(CommandRunner, {
            prepare: () => Effect.void,
            deploy: () => Effect.void,
          }),
          generalAdoption,
        );
        const result = yield* deploy(
          Convex.EnvironmentVariables("Environment", {
            url: "https://happy-otter-123.convex.cloud",
            deployKey: Redacted.make("test-key"),
            variables: { MANAGED: Redacted.make("desired-secret") },
            adoptMatching: true,
          }),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        expect(inspect(result, { depth: null })).toContain(
          "OwnedBySomeoneElse",
        );
        expect(inspect(result, { depth: null })).not.toContain(
          "different-secret",
        );
        expect(inspect(result, { depth: null })).not.toContain(
          "desired-secret",
        );
        expect(
          fixture.client.updateEnvironmentVariables,
        ).not.toHaveBeenCalled();
        expect(Redacted.value(fixture.state.variables.MANAGED)).toBe(
          "different-secret",
        );
      }),
  );

  it.effect(
    "keeps matching adoption separate from newly written names after a lost create response",
    () =>
      Effect.gen(function* () {
        const fixture = mockClient();
        fixture.state.variables = { MANAGED: Redacted.make("matching-secret") };
        let loseResponse = true;
        const deploy = makeHarness(
          Layer.succeed(ConvexClient, {
            ...fixture.client,
            updateEnvironmentVariables: (...args) =>
              fixture.client.updateEnvironmentVariables(...args).pipe(
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
        );
        const resources = Convex.EnvironmentVariables("Environment", {
          url: "https://happy-otter-123.convex.cloud",
          deployKey: Redacted.make("test-key"),
          variables: {
            MANAGED: Redacted.make("matching-secret"),
            NEW: Redacted.make("new-secret"),
          },
          adoptMatching: true,
        }).pipe(Effect.asVoid);
        const failed = yield* deploy(resources).pipe(Effect.result);
        expect(Result.isFailure(failed)).toBe(true);
        yield* deploy(resources);
        yield* deploy(Effect.void);
        expect(Record.keys(fixture.state.variables)).toEqual(["MANAGED"]);
        expect(Redacted.value(fixture.state.variables.MANAGED)).toBe(
          "matching-secret",
        );
      }),
  );

  it.effect(
    "sets, clears with null, sets again, and retains expiry on resource removal",
    () =>
      Effect.gen(function* () {
        const fixture = mockClient();
        const deploy = makeHarness(
          fixture.layer,
          Layer.succeed(CommandRunner, {
            prepare: () => Effect.void,
            deploy: () => Effect.void,
          }),
        );
        const resources = (
          expiry: Pick<Deployment.DeploymentProps, "expiresAt">,
        ) =>
          Effect.gen(function* () {
            const deployment = yield* Convex.Deployment("Deployment", {
              projectId: 1,
              type: "dev",
              reference: "example",
              class: "s256",
              ...expiry,
            });
            return { name: deployment.name, expiresAt: deployment.expiresAt };
          });
        const created = yield* deploy(
          resources({ expiresAt: 1_800_000_000_000 }),
        );
        expect(created).toEqual({
          name: "happy-otter-123",
          expiresAt: 1_800_000_000_000,
        });
        const extended = yield* deploy(
          resources({ expiresAt: 1_800_003_600_000 }),
        );
        expect(extended).toEqual({
          name: "happy-otter-123",
          expiresAt: 1_800_003_600_000,
        });
        const omitted = yield* deploy(resources({}));
        expect(omitted).toEqual(extended);
        expect(fixture.client.updateDeployment).toHaveBeenCalledTimes(1);
        const cleared = yield* deploy(resources({ expiresAt: null }));
        expect(cleared).toEqual({ name: "happy-otter-123", expiresAt: null });
        expect(fixture.client.updateDeployment).toHaveBeenLastCalledWith(
          "happy-otter-123",
          {
            reference: "example",
            expiresAt: null,
          },
        );
        const reset = yield* deploy(
          resources({ expiresAt: 1_800_007_200_000 }),
        );
        expect(reset).toEqual({
          name: "happy-otter-123",
          expiresAt: 1_800_007_200_000,
        });
        yield* deploy(Effect.succeed({}));
        expect(fixture.state.deployments).toEqual([
          expect.objectContaining({
            name: "happy-otter-123",
            expiresAt: 1_800_007_200_000,
          }),
        ]);
        expect(fixture.client.createDeployment).toHaveBeenCalledTimes(1);
        expect(fixture.client.deleteDeployment).not.toHaveBeenCalled();
      }),
  );

  it.effect.each(["create", "update"] as const)(
    "surfaces a production expiry API refusal on %s",
    (operation) =>
      Effect.gen(function* () {
        const fixture = mockClient();
        const refusal = ConvexApiError.make({
          operation:
            operation === "create" ? "createDeployment" : "updateDeployment",
          code: "HttpError",
          status: 400,
        });
        const client = Layer.succeed(ConvexClient, {
          ...fixture.client,
          createDeployment: (projectId, input) =>
            input.type === "prod" && input.expiresAt != null
              ? Effect.fail(refusal)
              : fixture.client.createDeployment(projectId, input),
          updateDeployment: (name, input) =>
            input.expiresAt != null
              ? Effect.fail(refusal)
              : fixture.client.updateDeployment(name, input),
        });
        const deploy = makeHarness(
          client,
          Layer.succeed(CommandRunner, {
            prepare: () => Effect.void,
            deploy: () => Effect.void,
          }),
        );
        const resources = (
          expiry: Pick<Deployment.DeploymentProps, "expiresAt">,
        ) =>
          Effect.gen(function* () {
            const deployment = yield* Convex.Deployment("Deployment", {
              projectId: 1,
              type: "prod",
              reference: "example",
              ...expiry,
            });
            return { name: deployment.name };
          });
        if (operation === "update") yield* deploy(resources({}));
        const result = yield* deploy(
          resources({ expiresAt: 1_800_000_000_000 }),
        ).pipe(Effect.result);
        expect(result).toEqual(Result.fail(refusal));
        expect(fixture.client.deleteDeployment).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    "resizes a declared deployment in place and retains it on removal",
    () =>
      Effect.gen(function* () {
        const fixture = mockClient();
        const deploy = makeHarness(
          fixture.layer,
          Layer.succeed(CommandRunner, {
            prepare: () => Effect.void,
            deploy: () => Effect.void,
          }),
        );
        const resources = (
          deploymentClass: NonNullable<Deployment.DeploymentProps["class"]>,
        ) =>
          Effect.gen(function* () {
            const deployment = yield* Convex.Deployment("Deployment", {
              projectId: 1,
              type: "dev",
              reference: "example",
              class: deploymentClass,
            });
            return { name: deployment.name, class: deployment.class };
          });
        const created = yield* deploy(resources("s16"));
        expect(created).toEqual({ name: "happy-otter-123", class: "s16" });
        const resized = yield* deploy(resources("s256"));
        expect(resized).toEqual({ name: "happy-otter-123", class: "s256" });
        yield* deploy(Effect.succeed({}));
        expect(fixture.client.createDeployment).toHaveBeenCalledTimes(1);
        expect(fixture.client.deleteDeployment).not.toHaveBeenCalled();
      }),
  );

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
  it.effect.each(["yielded", "effect", "computed redacted"] as const)(
    "preserves the %s log stream constructor with URL checks",
    (form) =>
      Effect.gen(function* () {
        const fixture = mockClient();
        const deploy = makeHarness(fixture.layer, noCommands);
        const resources = Effect.gen(function* () {
          const props = logConfigs[2];
          if (form === "yielded") {
            const resource = yield* Convex.LogStream;
            const stream = yield* resource("Logs", props);
            return { id: stream.id };
          }
          if (form === "effect") {
            const stream = yield* Convex.LogStream(
              "Logs",
              Effect.succeed(props),
            );
            return { id: stream.id };
          }
          const project = yield* Convex.Project("UrlSource", {
            teamId: 10,
            name: "url-source",
          });
          const stream = yield* Convex.LogStream("Logs", {
            ...props,
            url: project.projectId.pipe(Output.map(() => props.url)),
          });
          return { id: stream.id };
        });
        const first = yield* deploy(resources);
        expect(first.id).toBe("stream-1");
        const stable = yield* deploy.plan(resources);
        expect(stable.resources.Logs.action).toBe("noop");
        expect(fixture.client.createLogStream).toHaveBeenCalledTimes(1);
        expect(fixture.client.updateLogStream).not.toHaveBeenCalled();
      }),
  );

  it.effect.each(["create", "update"] as const)(
    "keeps a rejected computed URL out of %s state and plans",
    (operation) =>
      Effect.gen(function* () {
        const fixture = mockClient();
        const persisted: Record<
          string,
          Record<string, Record<string, ResourceState>>
        > = {};
        const deploy = makeHarness(fixture.layer, noCommands, false, persisted);
        const safe = { ...logConfigs[2], url: "http://127.0.0.1:9876/logs" };
        if (operation === "update") yield* deploy(logResources(safe));
        const unsafeUrl =
          "http://made-up-user:made-up-computed-password@127.0.0.1:9876/logs";
        const resources = Effect.gen(function* () {
          const project = yield* Convex.Project("UrlSource", {
            teamId: 10,
            name: "url-source",
          });
          const stream = yield* Convex.LogStream("Logs", {
            ...safe,
            url: project.projectId.pipe(Output.map(() => unsafeUrl)),
          });
          return { id: stream.id };
        });
        const messages: string[] = [];
        const capture = Logger.make(({ message, cause }) => {
          messages.push(inspect([message, cause], { depth: null }));
        });
        const result = yield* deploy(resources).pipe(
          Effect.exit,
          Effect.provideService(Logger.CurrentLoggers, new Set([capture])),
        );
        expect(Exit.isFailure(result)).toBe(true);
        expect(inspect(result, { depth: null })).toContain(
          "LogStreamUrlRequiresRedacted",
        );
        const shown = inspect([persisted, deploy.plans, messages, result], {
          depth: null,
        });
        expect(shown).not.toContain("made-up-computed-password");
        expect(shown).not.toContain("made-up-user");
        expect(fixture.client.createLogStream).toHaveBeenCalledTimes(
          operation === "create" ? 0 : 1,
        );
        expect(fixture.client.updateLogStream).not.toHaveBeenCalled();
        expect(fixture.client.deleteLogStream).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    "asks for another deploy after a deleting stream causes a conflict",
    () =>
      Effect.gen(function* () {
        const fixture = mockClient();
        const deploy = makeHarness(fixture.layer, noCommands);
        const props = logConfigs[0];
        yield* deploy(logResources(props));
        yield* deploy(Effect.succeed({}));
        fixture.client.createLogStream.mockReturnValueOnce(
          Effect.fail(
            ConvexConflict.make({
              operation: "createLogStream",
              status: 409,
              code: "HttpError",
            }),
          ),
        );
        const result = yield* deploy(logResources(props)).pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "LogStreamRecoveryRequired",
            message: expect.stringContaining(
              "Run the deploy again once deletion finishes",
            ),
          },
        });
        expect(inspect(result)).not.toContain("manually");
        fixture.state.logStreams.set(props.deploymentUrl, []);
        const recovered = yield* deploy(logResources(props));
        expect(recovered.id).toBe("stream-2");
      }),
  );

  it.effect.each([
    "https://made-up-user@127.0.0.1:9876/logs",
    "https://:made-up-url-password@127.0.0.1:9876/logs",
    "https://made-up-user:made-up-url-password@127.0.0.1:9876/logs",
  ])("refuses credentials in a plain webhook URL before stream APIs", (url) =>
    Effect.gen(function* () {
      const fixture = mockClient();
      const persisted: Record<
        string,
        Record<string, Record<string, ResourceState>>
      > = {};
      const deploy = makeHarness(fixture.layer, noCommands, false, persisted);
      const messages: string[] = [];
      const capture = Logger.make(({ message, cause }) => {
        messages.push(inspect([message, cause], { depth: null }));
      });
      const program = logResources({ ...logConfigs[2], url });
      for (const operation of [
        deploy.plan(program).pipe(Effect.asVoid),
        deploy(program).pipe(Effect.asVoid),
      ]) {
        const result = yield* operation.pipe(
          Effect.result,
          Effect.provideService(Logger.CurrentLoggers, new Set([capture])),
        );
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "LogStreamUrlRequiresRedacted",
            message: expect.stringContaining("Redacted"),
          },
        });
        const shown = inspect([result, messages, persisted, deploy.plans], {
          depth: null,
        });
        expect(shown).not.toContain(url);
        expect(shown).not.toContain("made-up-user");
        expect(shown).not.toContain("made-up-url-password");
      }
      expect(fixture.client.listLogStreams).not.toHaveBeenCalled();
      expect(fixture.client.getLogStream).not.toHaveBeenCalled();
      expect(fixture.client.createLogStream).not.toHaveBeenCalled();
      expect(fixture.client.updateLogStream).not.toHaveBeenCalled();
    }),
  );

  it.effect("rejects an output URL at apply and at plan once resolved", () =>
    Effect.gen(function* () {
      const fixture = mockClient();
      const deploy = makeHarness(fixture.layer, noCommands);
      const unsafeUrl = "http://user:made-up-url-password@127.0.0.1:9876/logs";
      const program = Effect.gen(function* () {
        const project = yield* Convex.Project("UrlSource", {
          teamId: 10,
          name: "url-source",
        });
        const stream = yield* Convex.LogStream("Logs", {
          ...logConfigs[2],
          url: project.projectId.pipe(Output.map(() => unsafeUrl)),
        });
        return { id: stream.id };
      });
      const unresolved = yield* deploy.plan(program);
      expect(unresolved.resources.Logs.action).toBe("create");
      const rejected = yield* deploy(program).pipe(Effect.exit);
      expect(Exit.isFailure(rejected)).toBe(true);
      expect(inspect(rejected, { depth: null })).toContain(
        "LogStreamUrlRequiresRedacted",
      );
      const resolved = yield* deploy.plan(program).pipe(Effect.exit);
      expect(Exit.isFailure(resolved)).toBe(true);
      expect(inspect(resolved, { depth: null })).toContain(
        "LogStreamUrlRequiresRedacted",
      );
      expect(fixture.client.listLogStreams).not.toHaveBeenCalled();
      expect(fixture.client.getLogStream).not.toHaveBeenCalled();
      expect(fixture.client.createLogStream).not.toHaveBeenCalled();
    }),
  );

  it.effect.each([
    { ...logConfigs[2], url: "http://127.0.0.1:9876" },
    { ...logConfigs[2], url: Redacted.make("http://127.0.0.1:9876") },
    { ...logConfigs[2], url: "http://127.0.0.1:9876/a/../b" },
    { ...logConfigs[2], url: "HTTP://LOCALHOST:80/a/../b" },
    { ...logConfigs[2], topics: ["audit_log", "console", "console"] },
    { ...logConfigs[0], topics: ["audit_log", "console", "console"] },
    { ...logConfigs[0], ingestUrl: "https://api.axiom.co" },
    { ...logConfigs[1], tags: null },
  ] as const)("converges on Convex-normalized $kind configuration", (props) =>
    Effect.gen(function* () {
      const fixture = mockClient();
      const deploy = makeHarness(fixture.layer, noCommands);
      const first = yield* deploy(logResources(props));
      const stable = yield* deploy.plan(logResources(props));
      expect(stable.resources.Logs.action).toBe("noop");
      expect(fixture.client.createLogStream).toHaveBeenCalledTimes(1);
      expect(fixture.client.updateLogStream).not.toHaveBeenCalled();
      const found = yield* fixture.client.getLogStream(
        props.deploymentUrl,
        props.deployKey,
        first.id,
      );
      const live = Redacted.value(found);
      if ("topics" in props) {
        expect(live).toMatchObject({ topics: ["console", "audit_log"] });
        expect(props.topics).toEqual(["audit_log", "console", "console"]);
      }
      if (live.logStreamType === "webhook" && props.kind === "webhook")
        expect(live.url).toBe(
          new URL(
            Redacted.isRedacted(props.url)
              ? Redacted.value(props.url)
              : props.url,
          ).href,
        );
      if (live.logStreamType === "axiom" && !("ingestUrl" in props))
        expect(live).not.toHaveProperty("ingestUrl");
      if (live.logStreamType === "sentry")
        expect(live).not.toHaveProperty("tags");
    }),
  );

  it.effect.each(["deploy", "destroy"] as const)(
    "keeps ownership after a post-create mismatch for the next %s",
    (next) =>
      Effect.gen(function* () {
        const fixture = mockClient();
        const persisted: Record<
          string,
          Record<string, Record<string, ResourceState>>
        > = {};
        const deploy = makeHarness(fixture.layer, noCommands, false, persisted);
        const props = logConfigs[0];
        const original = fixture.client.getLogStream.getMockImplementation();
        if (original === undefined)
          return yield* Effect.die("Missing fake get implementation");
        fixture.client.getLogStream.mockImplementationOnce((url, key, id) =>
          original(url, key, id).pipe(
            Effect.map((stream) => {
              const live = Redacted.value(stream);
              return Redacted.make(
                live.logStreamType === "axiom"
                  ? { ...live, datasetName: "post-create-mismatch" }
                  : live,
              );
            }),
          ),
        );
        const first = yield* deploy(logResources(props)).pipe(Effect.result);
        expect(first).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "LogStreamDrift", id: "stream-1" },
        });
        expect(persisted.integration.test.Logs.attr).toEqual({
          id: "stream-1",
          kind: "axiom",
        });
        if (next === "deploy") {
          const recovered = yield* deploy(logResources(props));
          expect(recovered.id).toBe("stream-1");
          const stable = yield* deploy.plan(logResources(props));
          expect(stable.resources.Logs.action).toBe("noop");
          expect(fixture.client.updateLogStream).not.toHaveBeenCalled();
        } else {
          yield* deploy(Effect.succeed({}));
          expect(fixture.client.deleteLogStream).toHaveBeenCalledWith(
            props.deploymentUrl,
            props.deployKey,
            "stream-1",
          );
        }
        expect(fixture.client.createLogStream).toHaveBeenCalledTimes(1);
      }),
  );

  it.effect("refuses a hand edit between plan and apply before writing", () =>
    Effect.gen(function* () {
      const fixture = mockClient();
      const deploy = makeHarness(fixture.layer, noCommands);
      const props = logConfigs[0];
      const first = yield* deploy(logResources(props));
      const next = { ...props, datasetName: "next" };
      const result = yield* deploy
        .run(logResources(next), (plan) =>
          Effect.gen(function* () {
            expect(plan.resources.Logs.action).toBe("update");
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
            return yield* apply(plan);
          }),
        )
        .pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "LogStreamDrift" },
      });
      expect(fixture.client.updateLogStream).not.toHaveBeenCalled();
      expect(fixture.client.deleteLogStream).not.toHaveBeenCalled();
      const messages: unknown[] = [];
      const capture = Logger.make(({ message, logLevel }) => {
        if (logLevel === "Warn") messages.push(message);
      });
      const retry = yield* deploy
        .plan(logResources(next))
        .pipe(Effect.provideService(Logger.CurrentLoggers, new Set([capture])));
      expect(retry.resources.Logs.action).toBe("update");
      expect(messages).toHaveLength(1);
      expect(inspect(messages)).toContain(first.id);
      expect(inspect(messages)).toContain("datasetName");
      expect(inspect(messages)).not.toContain("hand-edited");
      const refused = yield* deploy(logResources(next)).pipe(Effect.result);
      expect(refused).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "LogStreamDrift" },
      });
      expect(fixture.client.updateLogStream).not.toHaveBeenCalled();
      yield* deploy(Effect.succeed({}));
      expect(fixture.client.deleteLogStream).toHaveBeenCalledWith(
        props.deploymentUrl,
        props.deployKey,
        first.id,
      );
    }),
  );

  it.effect.each([logConfigs[0], logConfigs[1]])(
    "writes a secret-only $kind update once",
    (props) =>
      Effect.gen(function* () {
        const fixture = mockClient();
        const deploy = makeHarness(fixture.layer, noCommands);
        const first = yield* deploy(logResources(props));
        const next =
          props.kind === "axiom"
            ? { ...props, apiKey: Redacted.make("made-up-next-api-key") }
            : { ...props, dsn: Redacted.make("made-up-next-dsn") };
        const updated = yield* deploy(logResources(next));
        expect(updated.id).toBe(first.id);
        expect(fixture.client.updateLogStream).toHaveBeenCalledTimes(1);
        const stable = yield* deploy.plan(logResources(next));
        expect(stable.resources.Logs.action).toBe("noop");
      }),
  );

  it.effect.each(["rejected", "response lost"] as const)(
    "finishes an interrupted update when the request was %s",
    (failure) =>
      Effect.gen(function* () {
        const fixture = mockClient();
        let attempts = 0;
        const deploy = makeHarness(
          Layer.succeed(ConvexClient, {
            ...fixture.client,
            updateLogStream: (url, key, id, input) =>
              Effect.gen(function* () {
                attempts++;
                if (attempts !== 1 || failure === "response lost")
                  yield* fixture.client.updateLogStream(url, key, id, input);
                if (attempts === 1)
                  return yield* ConvexApiError.make({
                    operation: "updateLogStream",
                    code:
                      failure === "rejected" ? "HttpError" : "TransportError",
                    ...(failure === "rejected" ? { status: 500 } : {}),
                  });
              }),
          }),
          noCommands,
        );
        const props = logConfigs[0];
        const next = { ...props, datasetName: "next" };
        const first = yield* deploy(logResources(props));
        const interrupted = yield* deploy(logResources(next)).pipe(
          Effect.result,
        );
        expect(interrupted).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ConvexApiError" },
        });
        const retry = yield* deploy.plan(logResources(next));
        expect(retry.resources.Logs.action).toBe("update");
        const recovered = yield* deploy(logResources(next));
        expect(recovered.id).toBe(first.id);
        expect(attempts).toBe(failure === "rejected" ? 2 : 1);
        const live = yield* fixture.client.getLogStream(
          props.deploymentUrl,
          props.deployKey,
          first.id,
        );
        expect(Redacted.value(live)).toMatchObject({ datasetName: "next" });
        const stable = yield* deploy.plan(logResources(next));
        expect(stable.resources.Logs.action).toBe("noop");
        expect(fixture.client.createLogStream).toHaveBeenCalledTimes(1);
        expect(fixture.client.deleteLogStream).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    "explains recovery when a lost update is reverted before retry",
    () =>
      Effect.gen(function* () {
        const fixture = mockClient();
        let loseResponse = true;
        const deploy = makeHarness(
          Layer.succeed(ConvexClient, {
            ...fixture.client,
            updateLogStream: (url, key, id, input) =>
              fixture.client.updateLogStream(url, key, id, input).pipe(
                Effect.andThen(
                  Effect.suspend(() => {
                    if (!loseResponse) return Effect.void;
                    loseResponse = false;
                    return Effect.fail(
                      ConvexApiError.make({
                        operation: "updateLogStream",
                        code: "TransportError",
                      }),
                    );
                  }),
                ),
              ),
          }),
          noCommands,
        );
        const props = logConfigs[0];
        const next = { ...props, datasetName: "next" };
        const first = yield* deploy(logResources(props));
        yield* deploy(logResources(next)).pipe(Effect.result);
        const planned = yield* deploy.plan(logResources(props));
        expect(planned.resources.Logs.action).toBe("update");
        const reverted = yield* deploy(logResources(props)).pipe(Effect.result);
        expect(reverted).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "LogStreamDrift",
            message: expect.stringContaining("apply that same change again"),
          },
        });
        expect(fixture.client.updateLogStream).toHaveBeenCalledTimes(1);
        expect(fixture.client.deleteLogStream).not.toHaveBeenCalled();
        const recovered = yield* deploy(logResources(next));
        expect(recovered.id).toBe(first.id);
        expect(fixture.client.updateLogStream).toHaveBeenCalledTimes(1);
        yield* deploy(logResources(props));
        expect(fixture.client.updateLogStream).toHaveBeenCalledTimes(2);
      }),
  );

  it.effect(
    "accepts a readable hand edit when the stack is changed to match",
    () =>
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
        const next = { ...props, datasetName: "hand-edited" };
        const planned = yield* deploy.plan(logResources(next));
        expect(planned.resources.Logs.action).toBe("update");
        const matched = yield* deploy(logResources(next));
        expect(matched.id).toBe(first.id);
        expect(fixture.client.updateLogStream).not.toHaveBeenCalled();
        const stable = yield* deploy.plan(logResources(next));
        expect(stable.resources.Logs.action).toBe("noop");
      }),
  );

  it.effect(
    "refreshes a rotated HMAC through an update without writing to the stream",
    () =>
      Effect.gen(function* () {
        const fixture = mockClient();
        const persisted: Record<
          string,
          Record<string, Record<string, ResourceState>>
        > = {};
        const deploy = makeHarness(fixture.layer, noCommands, false, persisted);
        const messages: string[] = [];
        const capture = Logger.make(({ message, cause }) => {
          messages.push(inspect([message, cause], { depth: null }));
        });
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
        fixture.client.createLogStream.mockClear();
        const planned = yield* deploy.plan(logResources(props));
        expect(planned.resources.Logs.action).toBe("update");
        const refreshed = yield* deploy(logResources(props)).pipe(
          Effect.provideService(Logger.CurrentLoggers, new Set([capture])),
        );
        expect(deploy.plans.at(-1)?.resources.Logs.action).toBe("update");
        expect(Redacted.isRedacted(refreshed.hmacSecret)).toBe(true);
        expect(
          refreshed.hmacSecret && Redacted.value(refreshed.hmacSecret),
        ).toBe("made-up-rotated-hmac");
        expect(fixture.client.createLogStream).not.toHaveBeenCalled();
        expect(fixture.client.updateLogStream).not.toHaveBeenCalled();
        expect(fixture.client.deleteLogStream).not.toHaveBeenCalled();
        const stable = yield* deploy.plan(logResources(props));
        expect(stable.resources.Logs.action).toBe("noop");
        const shown = Array.join(
          [
            inspect([deploy.plans, first, refreshed, persisted, messages], {
              depth: null,
            }),
            // oxlint-disable-next-line effecttsgo/global-json-in-effect, effecttsgo/prefer-schema-over-json -- Exercise the public JSON.stringify rendering exactly.
            JSON.stringify([
              deploy.plans,
              first,
              refreshed,
              persisted,
              messages,
            ]),
            ...Array.flatMap(deploy.plans, (plan) => [
              ...formatYamlLines(plan),
              ...Array.flatMap(Record.values(plan.resources), (node) =>
                node.action === "create" ||
                node.action === "update" ||
                node.action === "replace"
                  ? (formatDeclaredPropertyYaml(
                      node.state?.props,
                      node.props,
                      node.action,
                    )?.lines ?? [])
                  : formatYamlLines(node.state?.attr),
              ),
            ]),
          ],
          "\n",
        );
        for (const secret of [
          "made-up-hmac-secret",
          "made-up-rotated-hmac",
          "made-up-webhook-password",
          "made-up-webhook-token",
          "made-up-engine-deploy-key",
        ])
          expect(shown).not.toContain(secret);
        yield* deploy(Effect.succeed({}));
        expect(fixture.client.deleteLogStream).toHaveBeenCalledWith(
          props.deploymentUrl,
          props.deployKey,
          first.id,
        );
      }),
  );

  it.effect("destroys immediately after a webhook HMAC rotation", () =>
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
    "refuses an untyped disabled kind before stream API calls on first apply",
    () =>
      Effect.gen(function* () {
        const fixture = mockClient();
        const deploy = makeHarness(fixture.layer, noCommands);
        const planned = yield* deploy(
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
            // Simulate an untyped caller while retaining unresolved deployment outputs.
            const props = {
              kind: "datadog",
              deploymentUrl: deployment.url,
              deployKey: key.deployKey,
              ddApiKey: Redacted.make("made-up-disabled-token"),
              siteLocation: "US1",
              ddTags: [],
            } as unknown as PropsInput<LogStream.LogStreamProps>;
            yield* Convex.LogStream("Logs", props);
          }),
        ).pipe(Effect.result);
        expect(Result.isFailure(planned)).toBe(true);
        if (Result.isFailure(planned))
          expect(planned.failure).toMatchObject({
            _tag: "LogStreamNotEnabled",
            kind: "datadog",
          });
        expect(fixture.client.createProject).toHaveBeenCalledTimes(1);
        expect(fixture.client.createDeployment).toHaveBeenCalledTimes(1);
        expect(fixture.client.createDeployKey).toHaveBeenCalledTimes(1);
        expect(fixture.client.listLogStreams).not.toHaveBeenCalled();
        expect(fixture.client.getLogStream).not.toHaveBeenCalled();
        expect(fixture.client.updateLogStream).not.toHaveBeenCalled();
        expect(fixture.client.deleteLogStream).not.toHaveBeenCalled();
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

  it.effect(
    "explains when another resource in the same stack manages the kind",
    () =>
      Effect.gen(function* () {
        const fixture = mockClient();
        const deploy = makeHarness(fixture.layer, noCommands, true);
        const planned = yield* deploy.plan(
          Effect.gen(function* () {
            yield* Convex.LogStream("First", logConfigs[0]);
            yield* Convex.LogStream("Second", logConfigs[0]);
          }),
        );
        expect(planned.resources.First.action).toBe("create");
        expect(planned.resources.Second.action).toBe("create");
        const result = yield* deploy(
          Effect.gen(function* () {
            const first = yield* Convex.LogStream("First", logConfigs[0]);
            yield* Convex.LogStream("Second", {
              ...logConfigs[0],
              deploymentUrl: first.id.pipe(
                Output.map(() => logTarget.deploymentUrl),
              ),
            });
          }),
        ).pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure).toMatchObject({
            _tag: "LogStreamRecoveryRequired",
          });
          expect(result.failure.message).toContain(
            "Another resource in this stack may already manage this kind",
          );
          expect(result.failure.message).toContain(
            "A backend holds one stream per kind",
          );
        }
        expect(fixture.client.createLogStream).toHaveBeenCalledTimes(1);
        expect(fixture.client.updateLogStream).not.toHaveBeenCalled();
        expect(fixture.client.deleteLogStream).not.toHaveBeenCalled();
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
        const absent = yield* fixture.client
          .getLogStream(props.deploymentUrl, props.deployKey, first.id)
          .pipe(Effect.result);
        expect(absent).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ConvexNotFound" },
        });
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
          (stream) =>
            Redacted.value(stream).id === first.id &&
            Redacted.value(stream).status.type !== "deleting",
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
        if (live.logStreamType === "webhook") {
          fixture.state.logStreams.set(props.deploymentUrl, [
            Redacted.make({ ...live, hmacSecret: "made-up-rotated-hmac" }),
          ]);
          yield* deploy(logResources(props)).pipe(
            Effect.provideService(Logger.CurrentLoggers, new Set([capture])),
          );
        }
        const changed =
          live.logStreamType === "axiom"
            ? { ...live, datasetName: "edited" }
            : live.logStreamType === "sentry"
              ? { ...live, tags: { app: "edited" } }
              : live.logStreamType === "webhook"
                ? {
                    ...live,
                    hmacSecret: "made-up-rotated-hmac",
                    format: "json" as const,
                  }
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
            ...Array.flatMap(deploy.plans, (plan) => [
              ...formatYamlLines(plan),
              ...Array.flatMap(Record.values(plan.resources), (node) =>
                node.action === "create" ||
                node.action === "update" ||
                node.action === "replace"
                  ? (formatDeclaredPropertyYaml(
                      node.state?.props,
                      node.props,
                      node.action,
                    )?.lines ?? [])
                  : formatYamlLines(node.state?.attr),
              ),
            ]),
          ],
          "\n",
        );
        for (const secret of [
          "made-up-engine-deploy-key",
          "made-up-engine-axiom-key",
          "made-up-engine-sentry-dsn",
          "made-up-hmac-secret",
          "made-up-rotated-hmac",
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
