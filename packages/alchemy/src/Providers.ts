import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as Provider from "alchemy/Provider";
import type * as Redacted from "effect/Redacted";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Code from "./Code.js";
import * as CustomDomain from "./CustomDomain.js";
import * as ConvexClient from "./ConvexClient.js";
import * as Deployment from "./Deployment.js";
import * as DeploymentAccess from "./DeploymentAccess.js";
import * as DeployKey from "./DeployKey.js";
import * as EnvironmentVariables from "./EnvironmentVariables.js";
import * as Project from "./Project.js";
import * as LogStream from "./LogStream.js";
import * as UsageLimit from "./UsageLimit.js";
import * as CommandRunner from "./internal/CommandRunner.js";
import * as PushLock from "./internal/PushLock.js";
import { managementTokenLayer } from "./internal/AuthProvider.js";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "@confect/alchemy/Providers",
) {}

/**
 * Register Convex resources without eagerly resolving management credentials.
 * `alchemy deploy` resolves each resource to its cloud provider; `alchemy dev`
 * resolves the same resources to local providers backed by a local Convex
 * backend, so one stack definition serves both. `access` chooses how a live run
 * reaches its deployments and defaults to `DeploymentAccess.grant`; local
 * providers always use the local backend's admin key.
 *
 * @stability unstable
 */
export const providers = (options?: {
  readonly token?: Redacted.Redacted<string>;
  readonly access?: DeploymentAccess.Access;
}) =>
  Layer.effect(
    Providers,
    Provider.collection([
      Project.Project,
      Deployment.Deployment,
      DeployKey.DeployKey,
      EnvironmentVariables.EnvironmentVariables,
      Code.Code,
      CustomDomain.CustomDomain,
      LogStream.LogStream,
      UsageLimit.UsageLimit,
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
        ProviderLayer.dual(CustomDomain.CustomDomain, {
          live: () => CustomDomain.layer,
          local: () => CustomDomain.localLayer,
        }),
        ProviderLayer.dual(UsageLimit.UsageLimit, {
          live: () => UsageLimit.layer,
          local: () => UsageLimit.localLayer,
        }),
        ProviderLayer.dual(Code.Code, {
          live: () => Code.layer,
          local: () => Code.localLayer,
        }),
        ProviderLayer.dual(LogStream.LogStream, {
          live: () => LogStream.layer,
          local: () => LogStream.localLayer,
        }),
      ),
    ),
    Layer.provide(DeploymentAccess.layer(options?.access)),
    Layer.provide(
      ConvexClient.layer(
        options?.token === undefined ? undefined : { token: options.token },
      ).pipe(
        Layer.provide(managementTokenLayer),
        Layer.provide(FetchHttpClient.layer),
      ),
    ),
    Layer.provide(CommandRunner.layer),
    Layer.provide(PushLock.layer()),
  );
