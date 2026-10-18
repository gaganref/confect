import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Convex } from "@confect/alchemy";
import { Providers } from "@confect/alchemy/Providers";
import { ConvexApiError } from "@confect/alchemy/ConvexClient";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { ArtifactStore } from "alchemy/Artifacts";
import { Stack } from "alchemy/Stack";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Result from "effect/Result";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect } from "@effect/vitest";

const stackEnvironment = Layer.mergeAll(
  NodeServices.layer,
  ConfigProvider.layer(ConfigProvider.fromUnknown({})),
  Layer.succeed(ArtifactStore, new Map()),
  Layer.succeed(Stack, {
    name: "test",
    stage: "test",
    resources: {},
    bindings: {},
    actions: {},
  }),
  FetchHttpClient.layer,
);

describe("providers", () => {
  it.effect("registers every resource without management credentials", () =>
    Effect.gen(function* () {
      const collection = yield* Providers;
      for (const resource of [
        Convex.Project,
        Convex.Deployment,
        Convex.DeployKey,
        Convex.EnvironmentVariables,
        Convex.Code,
      ]) {
        const provider = collection.get(resource.Type);
        expect(provider).toBeDefined();
        expect(typeof provider?.reconcile).toBe("function");
        expect(typeof provider?.delete).toBe("function");
      }
    }).pipe(
      Effect.provide(
        Convex.providers().pipe(
          Layer.provide(stackEnvironment),
          Layer.provide(
            Layer.succeed(AlchemyContext, {
              dotAlchemy: ".alchemy",
              dev: false,
              adopt: false,
            }),
          ),
        ),
      ),
    ),
  );

  it.effect.each([
    { dev: false, mode: "live" },
    { dev: true, mode: "local" },
  ] as const)(
    "resolves the same resources to $mode providers when dev is $dev",
    ({ dev, mode }) =>
      Effect.gen(function* () {
        const collection = yield* Providers;
        for (const resource of [
          Convex.Project,
          Convex.Deployment,
          Convex.DeployKey,
          Convex.EnvironmentVariables,
          Convex.Code,
        ])
          expect(collection.get(resource.Type)?.mode).toBe(mode);
        const project = collection.get(Convex.Project.Type);
        const result = yield* Effect.flatMap(
          Effect.fromNullishOr(project),
          (provider) =>
            // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- the registry erases provider error types
            provider.reconcile({
              id: "Project",
              fqn: "Project",
              instanceId: "0123456789abcdef",
              news: { teamId: 10, name: "notes" },
              olds: undefined,
              output: undefined,
              bindings: [],
              session: {
                emit: () => Effect.void,
                done: () => Effect.void,
                note: () => Effect.void,
              },
            }),
        ).pipe(Effect.result);
        expect(result).toEqual(
          dev
            ? Result.succeed({
                projectId: 0,
                teamId: 10,
                name: "notes",
                slug: "notes",
              })
            : Result.fail(
                new ConvexApiError({
                  operation: "configure",
                  code: "InvalidConfiguration",
                }),
              ),
        );
      }).pipe(
        Effect.provide(
          Convex.providers().pipe(
            Layer.provide(stackEnvironment),
            Layer.provide(
              Layer.succeed(AlchemyContext, {
                dotAlchemy: ".alchemy",
                dev,
                adopt: false,
              }),
            ),
          ),
        ),
      ),
  );
});
