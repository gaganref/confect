import type {
  CreateDeploymentType,
  PlatformDeploymentResponse,
  RegionName,
} from "@convex-dev/platform/managementApi";
import { OwnedBySomeoneElse, Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as LocalProvider from "alchemy/Local/LocalProvider";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { moduleExtension } from "alchemy/Util/Node";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { ConvexClient } from "./ConvexClient.js";
import type { Providers } from "./Providers.js";
import { resourceName } from "./internal/ResourceIdentity.js";
import { checkpointCreate, shouldAdopt } from "./internal/Lifecycle.js";
import { boot, dataDirectories, remove } from "./internal/LocalBackend.js";
import * as Array from "effect/Array";

export interface DeploymentProps {
  readonly projectId: number;
  readonly type: CreateDeploymentType;
  readonly reference?: string;
  readonly region?: RegionName;
}

export interface DeploymentAttributes {
  readonly projectId: number;
  readonly name: string;
  readonly reference: string;
  readonly type: CreateDeploymentType;
  readonly url: string;
  /**
   * Always set in the cloud; a local deployment echoes the requested region.
   */
  readonly region?: RegionName;
}

export type Deployment = Resource<
  "Convex.Deployment",
  DeploymentProps,
  DeploymentAttributes,
  never,
  Providers
>;
export const Deployment = Resource<Deployment>("Convex.Deployment", {
  defaultRemovalPolicy: "retain",
});

export class DeploymentIdentityChange extends Schema.TaggedError<DeploymentIdentityChange>()(
  "DeploymentIdentityChange",
  {
    deploymentName: Schema.String,
    field: Schema.String,
    current: Schema.String,
    requested: Schema.String,
  },
) {}

export class UnsupportedLocalDeployment extends Schema.TaggedError<UnsupportedLocalDeployment>()(
  "UnsupportedLocalDeployment",
  { deploymentName: Schema.String },
) {}

export class AmbiguousDeployment extends Schema.TaggedError<AmbiguousDeployment>()(
  "AmbiguousDeployment",
  { projectId: Schema.Finite, reference: Schema.String },
) {}

export const provider = Effect.gen(function* () {
  const client = yield* ConvexClient;
  const attributes = Effect.fn("Deployment.attributes")(function* (
    deployment: PlatformDeploymentResponse,
  ) {
    if (deployment.kind !== "cloud")
      return yield* UnsupportedLocalDeployment.make({
        deploymentName: deployment.name,
      });
    return {
      projectId: deployment.projectId,
      name: deployment.name,
      reference: deployment.reference,
      type: deployment.deploymentType,
      url: deployment.deploymentUrl,
      region: deployment.region,
    } satisfies DeploymentAttributes;
  });
  const find = Effect.fn("Deployment.find")(function* (
    projectId: number,
    reference: string,
  ) {
    const deployments = yield* client.listDeployments(projectId);
    const matches = Array.filter(
      deployments,
      (deployment) =>
        deployment.kind === "cloud" && deployment.reference === reference,
    );
    if (matches.length > 1)
      return yield* AmbiguousDeployment.make({ projectId, reference });
    return matches[0];
  });
  const validate = Effect.fn("Deployment.validate")(function* (
    current: DeploymentAttributes,
    news: DeploymentProps,
  ) {
    for (const field of ["projectId", "type", "region"] as const) {
      if (news[field] !== undefined && current[field] !== news[field])
        return yield* DeploymentIdentityChange.make({
          deploymentName: current.name,
          field,
          current: String(current[field]),
          requested: String(news[field]),
        });
    }
  });
  return {
    diff: Effect.fn("Deployment.diff")(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return;
      yield* validate(output, news);
      const deployment = yield* client
        .getDeployment(output.name)
        .pipe(Effect.catchTag("ConvexNotFound", () => Effect.void));
      if (deployment === undefined) return { action: "update" };
      const current = yield* attributes(deployment);
      yield* validate(current, news);
      if ((news.reference ?? output.reference) !== current.reference)
        return { action: "update" };
    }),
    read: Effect.fn("Deployment.read")(function* ({
      fqn,
      instanceId,
      olds,
      output,
    }) {
      if (output !== undefined) {
        const deployment = yield* client
          .getDeployment(output.name)
          .pipe(Effect.catchTag("ConvexNotFound", () => Effect.void));
        return deployment !== undefined
          ? yield* attributes(deployment)
          : undefined;
      }
      if (olds.projectId === undefined) return;
      const deployment = yield* find(
        olds.projectId,
        olds.reference ?? (yield* resourceName("deployment", fqn, instanceId)),
      );
      return deployment !== undefined
        ? yield* Effect.map(attributes(deployment), Unowned)
        : undefined;
    }),
    reconcile: Effect.fn("Deployment.reconcile")(function* ({
      fqn,
      instanceId,
      news,
      output,
    }) {
      if (output === undefined) yield* checkpointCreate(fqn, instanceId, news);
      if (output !== undefined) yield* validate(output, news);
      let deployment =
        output !== undefined
          ? yield* client
              .getDeployment(output.name)
              .pipe(Effect.catchTag("ConvexNotFound", () => Effect.void))
          : undefined;
      const reference =
        news.reference ??
        output?.reference ??
        (yield* resourceName("deployment", fqn, instanceId));
      if (deployment === undefined) {
        const existing = yield* find(news.projectId, reference);
        if (existing !== undefined && !(yield* shouldAdopt(fqn)))
          return yield* new OwnedBySomeoneElse({
            message: "An existing deployment requires explicit adoption.",
            resourceType: Deployment.Type,
            physicalName: reference,
          });
        if (existing !== undefined) {
          const adopted = yield* attributes(existing);
          yield* validate(adopted, news);
          yield* checkpointCreate(fqn, instanceId, news, adopted);
          deployment = existing;
        } else {
          deployment = yield* client.createDeployment(news.projectId, {
            type: news.type,
            reference,
            ...(news.region === undefined ? {} : { region: news.region }),
          });
        }
      }
      const current = yield* attributes(deployment);
      yield* validate(current, news);
      if (current.reference !== reference) {
        const existing = yield* find(news.projectId, reference);
        if (existing !== undefined && existing.name !== current.name)
          return yield* new OwnedBySomeoneElse({
            message: "The requested deployment reference is already in use.",
            resourceType: Deployment.Type,
            physicalName: reference,
          });
        yield* client.updateDeployment(current.name, {
          reference,
        });
        deployment = yield* client.getDeployment(current.name);
      }
      return yield* attributes(deployment);
    }),
    delete: Effect.fn("Deployment.delete")(function* ({ output }) {
      yield* client
        .deleteDeployment(output.name)
        .pipe(Effect.catchTag("ConvexNotFound", () => Effect.void));
    }),
  } satisfies Provider.ProviderServiceInput<Deployment>;
});

interface LocalConfig {
  readonly name: string;
  readonly props: DeploymentProps;
}

/**
 * Under `alchemy dev` a deployment is a local Convex backend this provider
 * owns. Alchemy's dev sidecar hosts it, so the backend keeps running across
 * reloads of the stack and stops when the dev session ends. Its data lives in
 * `.alchemy/convex/<stack>/<stage>/<name>` and is removed only when the
 * deployment is destroyed.
 */
export const localLayer = LocalProvider.make(
  Deployment,
  new URL(
    `./internal/LocalSidecar${moduleExtension(import.meta.url)}`,
    import.meta.url,
  ).href,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* dataDirectories;
    return {
      resolveConfig: Effect.fn("Deployment.localConfig")(function* ({
        fqn,
        instanceId,
        news,
      }) {
        return {
          name: yield* resourceName("deployment", fqn, instanceId),
          props: news,
        } satisfies LocalConfig;
      }),
      start: Effect.fn("Deployment.localStart")(function* ({
        config,
        invalidate,
      }) {
        const backend = yield* boot(config.name, directory(config.name));
        yield* backend.exited.pipe(
          Effect.andThen(invalidate),
          Effect.forkScoped,
        );
        return {
          projectId: config.props.projectId,
          name: config.name,
          reference: config.props.reference ?? config.name,
          type: config.props.type,
          url: backend.url,
          ...(config.props.region === undefined
            ? {}
            : { region: config.props.region }),
        } satisfies DeploymentAttributes;
      }),
      stop: Effect.fn("Deployment.localStop")(function* ({ fqn, instanceId }) {
        const name = yield* resourceName("deployment", fqn, instanceId);
        yield* remove(name, directory(name)).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
        );
      }),
    } satisfies LocalProvider.LocalProviderSpec<
      Deployment,
      LocalConfig,
      Effect.Services<ReturnType<typeof boot>>
    >;
  }),
);

export const layer = Provider.effect(Deployment, provider);
