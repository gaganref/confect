import type { PlatformCreateDeployKeyArgs } from "@convex-dev/platform/managementApi";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { ConvexClient } from "./ConvexClient.js";
import type { Providers } from "./Providers.js";
import { isKeyNamed } from "./internal/DeploymentName.js";
import { resourceName } from "./internal/ResourceIdentity.js";
import { checkpointCreate } from "./internal/Lifecycle.js";
import * as Option from "effect/Option";
import * as Array from "effect/Array";

export interface DeployKeyProps {
  readonly deploymentName: string;
  readonly name?: string;
  readonly allowedActions?: ReadonlyArray<
    NonNullable<PlatformCreateDeployKeyArgs["allowedActions"]>[number]
  >;
}

/**
 * `deployKey` is the minted secret. Alchemy writes it to state, so a stack that
 * declares `Convex.DeployKey` stores the key there; the deploy path never reads
 * it.
 */
export interface DeployKeyAttributes {
  readonly deploymentName: string;
  readonly keyId: number;
  readonly name: string;
  readonly deployKey: Redacted.Redacted<string>;
  readonly allowedActions: ReadonlyArray<string>;
}

export type DeployKey = Resource<
  "Convex.DeployKey",
  DeployKeyProps,
  DeployKeyAttributes,
  never,
  Providers
>;
export const DeployKey = Resource<DeployKey>("Convex.DeployKey");

export class DeployKeyRecoveryRequired extends Schema.TaggedError<
  DeployKeyRecoveryRequired,
  { readonly brand: unique symbol }
>()("DeployKeyRecoveryRequired", {
  deploymentName: Schema.String,
  keyName: Schema.String,
  keyIds: Schema.Array(Schema.Finite),
}) {}

/**
 * Convex listed no new key after `create_deploy_key`. That is how it answers an
 * OAuth login: the key it returns is the login itself, so nothing was minted
 * and nothing is recorded.
 */
export class DeployKeyNotMinted extends Schema.TaggedError<
  DeployKeyNotMinted,
  { readonly brand: unique symbol }
>()("DeployKeyNotMinted", {
  deploymentName: Schema.String,
  keyName: Schema.String,
}) {
  override get message() {
    return `Convex minted no deploy key ${this.keyName} for ${this.deploymentName}, which is how it answers an OAuth login: the key it returns is the login itself. Remove Convex.DeployKey from the stack and deploy with DeploymentAccess.grant, or mint keys with a team access token.`;
  }
}

/**
 * Under `alchemy dev` the local backend's admin key comes from
 * `DeploymentAccess`, so a declared deploy key has nothing to mint.
 */
export class DeployKeyUnavailableLocally extends Schema.TaggedError<
  DeployKeyUnavailableLocally,
  { readonly brand: unique symbol }
>()("DeployKeyUnavailableLocally", {
  deploymentName: Schema.String,
}) {
  override get message() {
    return `Convex.DeployKey has no local form for ${this.deploymentName}. Under alchemy dev the local backend's admin key comes from DeploymentAccess; declare the key only for live stacks.`;
  }
}

export class DeployKeyChangeRequiresNewResource extends Schema.TaggedError<
  DeployKeyChangeRequiresNewResource,
  { readonly brand: unique symbol }
>()("DeployKeyChangeRequiresNewResource", {
  deploymentName: Schema.String,
  keyId: Schema.Finite,
  field: Schema.String,
}) {}

export const provider = Effect.gen(function* () {
  const client = yield* ConvexClient;
  const hasName = isKeyNamed;
  const recover = (
    deploymentName: string,
    name: string,
    keyIds: ReadonlyArray<number>,
  ) =>
    DeployKeyRecoveryRequired.make({ deploymentName, keyName: name, keyIds });
  return {
    diff: Effect.fn("DeployKey.diff")(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return;
      for (const field of ["deploymentName", "name"] as const) {
        if (news[field] !== undefined && news[field] !== output[field])
          return yield* DeployKeyChangeRequiresNewResource.make({
            deploymentName: output.deploymentName,
            keyId: output.keyId,
            field,
          });
      }
      const keys = yield* client.listDeployKeys(output.deploymentName);
      const key = Option.getOrUndefined(
        Array.findFirst(keys, (candidate) => candidate.id === output.keyId),
      );
      if (key === undefined || !Redacted.isRedacted(output.deployKey))
        return yield* recover(output.deploymentName, output.name, [
          output.keyId,
        ]);
      if (!hasName(key.name, news.name ?? output.name))
        return yield* DeployKeyChangeRequiresNewResource.make({
          deploymentName: output.deploymentName,
          keyId: output.keyId,
          field: "name",
        });
      const allowedActions = news.allowedActions ?? output.allowedActions;
      if (
        new Set(allowedActions).size !== new Set(key.allowedActions).size ||
        Array.some(
          allowedActions,
          (action) => !key.allowedActions.includes(action),
        )
      )
        return yield* DeployKeyChangeRequiresNewResource.make({
          deploymentName: output.deploymentName,
          keyId: output.keyId,
          field: "allowedActions",
        });
    }),
    read: Effect.fn("DeployKey.read")(function* ({
      fqn,
      instanceId,
      olds,
      output,
    }) {
      const deploymentName = output?.deploymentName ?? olds.deploymentName;
      if (deploymentName === undefined) return;
      const name =
        output?.name ??
        olds.name ??
        (yield* resourceName("key", fqn, instanceId));
      const keys = yield* client.listDeployKeys(deploymentName);
      if (output !== undefined) {
        const key = Option.getOrUndefined(
          Array.findFirst(keys, (candidate) => candidate.id === output.keyId),
        );
        if (key === undefined)
          return yield* recover(deploymentName, name, [output.keyId]);
        if (!Redacted.isRedacted(output.deployKey))
          return yield* recover(deploymentName, name, [key.id]);
        return {
          ...output,
          allowedActions: key.allowedActions,
        };
      }
      const matches = Array.filter(keys, (key) => hasName(key.name, name));
      if (matches.length > 0)
        return yield* recover(
          deploymentName,
          name,
          Array.map(matches, (candidate) => candidate.id),
        );
      return undefined;
    }),
    reconcile: Effect.fn("DeployKey.reconcile")(function* ({
      fqn,
      instanceId,
      news,
      output,
    }) {
      if (output === undefined) yield* checkpointCreate(fqn, instanceId, news);
      const name =
        news.name ??
        output?.name ??
        (yield* resourceName("key", fqn, instanceId));
      if (output !== undefined) {
        for (const field of ["deploymentName", "name"] as const) {
          if (news[field] !== undefined && news[field] !== output[field])
            return yield* DeployKeyChangeRequiresNewResource.make({
              deploymentName: output.deploymentName,
              keyId: output.keyId,
              field,
            });
        }
        const keys = yield* client.listDeployKeys(output.deploymentName);
        const key = Option.getOrUndefined(
          Array.findFirst(keys, (candidate) => candidate.id === output.keyId),
        );
        if (key === undefined || !Redacted.isRedacted(output.deployKey))
          return yield* recover(output.deploymentName, name, [output.keyId]);
        if (!hasName(key.name, name))
          return yield* DeployKeyChangeRequiresNewResource.make({
            deploymentName: output.deploymentName,
            keyId: output.keyId,
            field: "name",
          });
        const allowedActions = news.allowedActions ?? output.allowedActions;
        if (
          new Set(allowedActions).size !== new Set(key.allowedActions).size ||
          Array.some(
            allowedActions,
            (action) => !key.allowedActions.includes(action),
          )
        )
          return yield* DeployKeyChangeRequiresNewResource.make({
            deploymentName: output.deploymentName,
            keyId: output.keyId,
            field: "allowedActions",
          });
        return {
          ...output,
          allowedActions: key.allowedActions,
        };
      }
      const deployKeys = yield* client.listDeployKeys(news.deploymentName);
      const existing = Array.filter(deployKeys, (key) =>
        hasName(key.name, name),
      );
      if (existing.length > 0)
        return yield* recover(
          news.deploymentName,
          name,
          Array.map(existing, (key) => key.id),
        );
      const known = new Set(Array.map(deployKeys, (key) => key.id));
      const created = yield* client.createDeployKey(news.deploymentName, {
        name,
        ...(news.allowedActions === undefined
          ? {}
          : { allowedActions: [...news.allowedActions] }),
      });
      const deployKeys2 = yield* client.listDeployKeys(news.deploymentName);
      const minted = Array.filter(deployKeys2, (key) => !known.has(key.id));
      if (minted.length === 0)
        return yield* DeployKeyNotMinted.make({
          deploymentName: news.deploymentName,
          keyName: name,
        });
      const matches = Array.filter(deployKeys2, (key) =>
        hasName(key.name, name),
      );
      const key = matches[0];
      if (matches.length !== 1 || key === undefined)
        return yield* recover(
          news.deploymentName,
          name,
          Array.map(matches.length > 0 ? matches : minted, (row) => row.id),
        );
      return {
        deploymentName: news.deploymentName,
        keyId: key.id,
        name,
        deployKey: created.deployKey,
        allowedActions: key.allowedActions,
      };
    }),
    // Deletes by the name Convex lists for the recorded id, never by secret.
    delete: Effect.fn("DeployKey.delete")(function* ({ output }) {
      const keys = yield* client.listDeployKeys(output.deploymentName);
      const key = Option.getOrUndefined(
        Array.findFirst(keys, (candidate) => candidate.id === output.keyId),
      );
      if (key === undefined) return;
      yield* client
        .deleteDeployKey(output.deploymentName, key.name)
        .pipe(Effect.catchTag("ConvexNotFound", () => Effect.void));
    }),
  } satisfies Provider.ProviderServiceInput<DeployKey>;
});

/**
 * Under `alchemy dev` the local backend's admin key comes from
 * `DeploymentAccess`, so a declared key is refused. Removing one sends
 * nothing.
 *
 * @stability unstable
 */
export const localProvider = Effect.succeed<
  Provider.ProviderServiceInput<DeployKey>
>({
  diff: () => Effect.succeed({ action: "update" }),
  reconcile: ({ news }) =>
    DeployKeyUnavailableLocally.make({ deploymentName: news.deploymentName }),
  delete: () => Effect.void,
});

export const layer = Provider.effect(DeployKey, provider);
/**
 * @stability unstable
 */
export const localLayer = Provider.effect(DeployKey, localProvider);
