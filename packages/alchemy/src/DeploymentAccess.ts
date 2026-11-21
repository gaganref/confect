import * as Array from "effect/Array";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ConvexClient, type ConvexClientError } from "./ConvexClient.js";
import * as DeploymentName from "./internal/DeploymentName.js";
import {
  adminKey,
  adminKeyAt,
  dataDirectories,
} from "./internal/LocalBackend.js";

/**
 * How a run reaches its deployments. `grant` uses the management login,
 * `deployKey` a key supplied for one deployment, and `local` the local
 * backend's admin key under `alchemy dev`.
 *
 * @stability unstable
 */
export type Kind = "grant" | "deployKey" | "local";

/**
 * The access a live stack chooses in `Convex.providers({ access })`. The local
 * providers always use the `local` kind.
 *
 * @stability unstable
 */
export type Access =
  | { readonly kind: "grant" }
  | {
      readonly kind: "deployKey";
      readonly key:
        | Redacted.Redacted<string>
        | Config.Config<Redacted.Redacted<string>>;
    };

/**
 * Reach every deployment with the management login. Calls to a deployment's API
 * send the login as `Convex <token>`. The push, mount init and health check get
 * the key `create_deploy_key` returns, which under an OAuth login is that login
 * and mints nothing. A login that mints a key is refused.
 *
 * @stability unstable
 */
export const grant: Access = { kind: "grant" };

/**
 * Reach the one deployment a deploy key names, such as
 * `prod:happy-otter-123|...`. Any other deployment is refused before a call.
 *
 * @stability unstable
 */
export const deployKey = (
  key: Redacted.Redacted<string> | Config.Config<Redacted.Redacted<string>>,
): Access => ({ kind: "deployKey", key });

/**
 * A deployment could not be reached with this run's access. No request was
 * sent.
 *
 * @stability unstable
 */
export class DeploymentAccessRefused extends Schema.TaggedError<
  DeploymentAccessRefused,
  { readonly brand: unique symbol }
>()("DeploymentAccessRefused", {
  kind: Schema.Literals(["grant", "deployKey", "local"]),
  reason: Schema.Literals([
    "OtherDeployment",
    "InvalidKey",
    "KeyUnavailable",
    "NotCloudUrl",
    "UnknownDeployment",
  ]),
  deploymentName: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
}) {
  override get message() {
    const target = this.deploymentName ?? this.url ?? "the deployment";
    switch (this.reason) {
      case "OtherDeployment":
        return `The deploy key names another deployment than ${target}. Supply the key for ${target} with DeploymentAccess.deployKey.`;
      case "InvalidKey":
        return "The supplied deploy key is not a Convex cloud deploy key such as prod:<deployment>|<secret>.";
      case "KeyUnavailable":
        return "The deploy key could not be read from its configuration.";
      case "NotCloudUrl":
        return `${target} is not a Convex cloud deployment URL, so a deploy key cannot serve it.`;
      case "UnknownDeployment":
        return `No local backend of this stack serves ${target}. Run alchemy dev so the deployment boots first.`;
    }
  }
}

/**
 * The management login could not be shown to be an OAuth grant, so no key it
 * produced is used. A key it minted was deleted by its listed name.
 *
 * @stability unstable
 */
export class DeploymentGrantUnproven extends Schema.TaggedError<
  DeploymentGrantUnproven,
  { readonly brand: unique symbol }
>()("DeploymentGrantUnproven", {
  deploymentName: Schema.String,
  reason: Schema.Literals(["Minted", "ListingChanged"]),
  keyIds: Schema.Array(Schema.Finite),
}) {
  override get message() {
    return this.reason === "Minted"
      ? `The management login minted a deploy key for ${this.deploymentName}, so it is not an OAuth grant. The minted key was deleted. Supply a deploy key with DeploymentAccess.deployKey.`
      : `The deploy keys of ${this.deploymentName} changed while access was checked, so the grant is unproven. Deploy again.`;
  }
}

/**
 * A deployment by its name and URL.
 *
 * @stability unstable
 */
export interface Deployment {
  readonly name: string;
  readonly url: string;
}

/**
 * The credential for calls to a deployment, supplied at run time so no resource
 * keeps one in its props or attributes.
 *
 * @stability unstable
 */
export class DeploymentAccess extends Context.Service<
  DeploymentAccess,
  {
    readonly kind: Kind;
    /**
     * The key for calls to the deployment API at `url`. `undefined` means the
     * management login. Sends nothing.
     */
    readonly api: (
      url: string,
    ) => Effect.Effect<
      Redacted.Redacted<string> | undefined,
      DeploymentAccessRefused
    >;
    /**
     * A deploy key for the push, mount init and health check. Under `grant` the
     * first request for a deployment calls `create_deploy_key`, so only apply
     * asks for it. The key lives in memory for this run.
     */
    readonly deployKey: (
      deployment: Deployment,
    ) => Effect.Effect<
      Redacted.Redacted<string>,
      DeploymentAccessRefused | DeploymentGrantUnproven | ConvexClientError
    >;
  }
>()("@confect/alchemy/DeploymentAccess") {}

// The key name the grant check requests, so a key it mints can be found.
const grantKeyName = "confect-alchemy-access";

const grantService = Effect.gen(function* () {
  const client = yield* ConvexClient;
  const issued = new Map<string, Redacted.Redacted<string>>();
  const serial = Semaphore.makeUnsafe(1);
  const issue = Effect.fn("DeploymentAccess.grantKey")(function* ({
    name,
  }: Deployment) {
    const cached = issued.get(name);
    if (cached !== undefined) return cached;
    const before = yield* client.listDeployKeys(name);
    const known = new Set(Array.map(before, (key) => key.id));
    const created = yield* client.createDeployKey(name, {
      name: grantKeyName,
    });
    const after = yield* client.listDeployKeys(name);
    const minted = Array.filter(after, (key) => !known.has(key.id));
    if (minted.length > 0) {
      for (const key of minted)
        if (DeploymentName.isKeyNamed(key.name, grantKeyName))
          yield* client
            .deleteDeployKey(name, key.name)
            .pipe(Effect.catchTag("ConvexNotFound", () => Effect.void));
      return yield* DeploymentGrantUnproven.make({
        deploymentName: name,
        reason: "Minted",
        keyIds: Array.map(minted, (key) => key.id),
      });
    }
    if (after.length !== before.length)
      return yield* DeploymentGrantUnproven.make({
        deploymentName: name,
        reason: "ListingChanged",
        keyIds: [],
      });
    issued.set(name, created.deployKey);
    return created.deployKey;
  });
  return DeploymentAccess.of({
    kind: "grant",
    api: () => Effect.undefined,
    deployKey: (deployment) => serial.withPermits(1)(issue(deployment)),
  });
});

const keyService = (supplied: Extract<Access, { kind: "deployKey" }>["key"]) =>
  Effect.gen(function* () {
    const refused = (
      reason: DeploymentAccessRefused["reason"],
      target: { readonly deploymentName?: string; readonly url?: string } = {},
    ) => DeploymentAccessRefused.make({ kind: "deployKey", reason, ...target });
    const resolved = yield* Effect.cached(
      Effect.gen(function* () {
        const key = Config.isConfig(supplied)
          ? yield* supplied.pipe(
              Effect.mapError(() => refused("KeyUnavailable")),
            )
          : supplied;
        const name = key.pipe(Redacted.value, DeploymentName.ofDeployKey);
        if (Option.isNone(name)) return yield* refused("InvalidKey");
        return { key, name: name.value };
      }),
    );
    const serve = Effect.fn("DeploymentAccess.serve")(function* (
      deploymentName: string,
    ) {
      const { key, name } = yield* resolved;
      if (name !== deploymentName)
        return yield* refused("OtherDeployment", { deploymentName });
      return key;
    });
    return DeploymentAccess.of({
      kind: "deployKey",
      api: (url) =>
        Option.match(DeploymentName.ofCloudUrl(url), {
          onNone: () => Effect.fail(refused("NotCloudUrl", { url })),
          onSome: serve,
        }),
      deployKey: (deployment) => serve(deployment.name),
    });
  });

const localService = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* dataDirectories;
  const refused = (target: {
    readonly deploymentName?: string;
    readonly url?: string;
  }) =>
    DeploymentAccessRefused.make({
      kind: "local",
      reason: "UnknownDeployment",
      ...target,
    });
  const provide = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  return DeploymentAccess.of({
    kind: "local",
    api: (url) =>
      provide(adminKeyAt(directory.root, url)).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(refused({ url })),
            onSome: (key) =>
              Effect.succeed<Redacted.Redacted<string> | undefined>(key),
          }),
        ),
      ),
    deployKey: ({ name }) =>
      provide(adminKey(name, directory(name))).pipe(
        Effect.mapError(() => refused({ deploymentName: name })),
      ),
  });
});

/**
 * The access a live stack runs with. Defaults to `grant`.
 *
 * @stability unstable
 */
export const layer = (
  access: Access = grant,
): Layer.Layer<DeploymentAccess, never, ConvexClient> =>
  Layer.effect(
    DeploymentAccess,
    access.kind === "grant" ? grantService : keyService(access.key),
  );

/**
 * Under `alchemy dev`, each request reads the local backend's admin key from
 * its data directory, so a recreated backend's new key is used.
 *
 * @stability unstable
 */
export const localLayer = Layer.effect(DeploymentAccess, localService);
