import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as Provider from "alchemy/Provider";
import type * as Redacted from "effect/Redacted";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Code from "./Code";
import * as ConvexClient from "./ConvexClient";
import * as Deployment from "./Deployment";
import * as DeployKey from "./DeployKey";
import * as EnvironmentVariables from "./EnvironmentVariables";
import * as Project from "./Project";
import * as CommandRunner from "./internal/CommandRunner";
import * as PushLock from "./internal/PushLock";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "@confect/alchemy/Providers",
) {}

/**
 * Register Convex resources without eagerly resolving management credentials.
 * `alchemy deploy` resolves each resource to its cloud provider; `alchemy dev`
 * resolves the same resources to local providers backed by a local Convex
 * backend, so one stack definition serves both.
 */
export const providers = (options?: {
  readonly token?: Redacted.Redacted<string>;
}) =>
  Layer.effect(
    Providers,
    Provider.collection([
      Project.Project,
      Deployment.Deployment,
      DeployKey.DeployKey,
      EnvironmentVariables.EnvironmentVariables,
      Code.Code,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ProviderLayer.dual(Project.Project, {
          live: () => Project.layer,
          local: () => Project.localLayer,
        }),
        ProviderLayer.dual(Deployment.Deployment, {
          live: () => Deployment.layer,
          local: () => Deployment.localLayer,
        }),
        ProviderLayer.dual(DeployKey.DeployKey, {
          live: () => DeployKey.layer,
          local: () => DeployKey.localLayer,
        }),
        ProviderLayer.dual(EnvironmentVariables.EnvironmentVariables, {
          live: () => EnvironmentVariables.layer,
          local: () => EnvironmentVariables.localLayer,
        }),
        ProviderLayer.dual(Code.Code, {
          live: () => Code.layer,
          local: () => Code.localLayer,
        }),
      ),
    ),
    Layer.provide(
      ConvexClient.layer(options).pipe(Layer.provide(FetchHttpClient.layer)),
    ),
    Layer.provide(CommandRunner.layer),
    Layer.provide(PushLock.layer()),
  );
