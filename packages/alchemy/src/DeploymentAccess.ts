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
import * as Str from "effect/String";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { ConvexClient, type ConvexClientError } from "./ConvexClient.js";
import * as DeploymentName from "./internal/DeploymentName.js";
import * as Redaction from "./internal/Redaction.js";
import {
  adminKey,
  adminKeyAt,
  dataDirectories,
} from "./internal/LocalBackend.js";

/**
 * How a run reaches its deployments. `grant` uses the management login,
 * `deployKey` the keys supplied for the deployments they name, and `local` the
 * local backend's admin key under `alchemy dev`.
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
  | { readonly kind: "deployKey"; readonly keys: ReadonlyArray<SuppliedKey> };

/**
 * A deploy key such as `prod:happy-otter-123|...`, or the configuration that
 * holds one.
 *
 * @stability unstable
 */
export type SuppliedKey =
  | Redacted.Redacted<string>
  | Config.Config<Redacted.Redacted<string>>;

/**
 * Reach every deployment with a project-scoped management login. Calls to a
 * deployment's API send the login as `Convex <token>`. The push, mount init and
 * health check get the key `create_deploy_key` returns, which under an OAuth
 * grant is that login and mints nothing.
 *
 * Two checks run before that key is used. `GET /token_details` must answer
 * `projectToken`, so a team-scoped login is refused before any write; this
 * shows the login's scope, not that it is an OAuth grant. Then the deployment's
 * keys are listed around the create: a new row with the name this attempt asked
 * for means the login mints keys, and it is deleted and refused. No new row is
 * what Convex documents for an OAuth grant.
 *
 * @stability unstable
 */
export const grant: Access = { kind: "grant" };

/**
 * Reach each deployment with the supplied key whose prefix names it, as
 * `prod:happy-otter-123|...` names `happy-otter-123`. A deployment no key
 * names, and two keys that name one deployment, are refused before any
 * request.
 *
 * @stability unstable
 */
export const deployKey = (
  keys: SuppliedKey | ReadonlyArray<SuppliedKey>,
): Access => ({
  kind: "deployKey",
  keys: Redacted.isRedacted(keys) || Config.isConfig(keys) ? [keys] : keys,
});

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
    "DuplicateDeployment",
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
        return `No supplied deploy key names ${target}. Supply the key for ${target} with DeploymentAccess.deployKey.`;
      case "DuplicateDeployment":
        return `Two supplied deploy keys name ${target}. Supply one key for each deployment.`;
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
 * The grant was refused before any write. `TeamScoped`: `GET /token_details`
 * answered `teamToken`, whatever the login's origin. `LeftoverKeys`: the
 * deployment lists keys an earlier grant check created, named in `keyNames`.
 *
 * @stability unstable
 */
export class DeploymentGrantRefused extends Schema.TaggedError<
  DeploymentGrantRefused,
  { readonly brand: unique symbol }
>()("DeploymentGrantRefused", {
  deploymentName: Schema.String,
  reason: Schema.Literals(["TeamScoped", "LeftoverKeys"]),
  keyNames: Schema.Array(Schema.String),
}) {
  override get message() {
    return this.reason === "TeamScoped"
      ? `DeploymentAccess.grant needs a project-scoped management login, and this login is team scoped, so nothing was sent to ${this.deploymentName}. With a team-scoped credential, supply a deploy key for ${this.deploymentName} with DeploymentAccess.deployKey.`
      : `${this.deploymentName} lists deploy keys an earlier grant check created: ${Array.join(this.keyNames, ", ")}. A login that mints keys made them. Delete them in the Convex dashboard, then deploy with DeploymentAccess.deployKey or with a login that mints nothing. Nothing was sent.`;
  }
}

/**
 * The grant check asked Convex for a key named `keyName` and could not use it.
 * `Minted`: the deployment lists that key, so the login mints keys; `deleted`
 * says whether the key is gone. `ListingChanged`: another key appeared during
 * the check; nothing was deleted. `ListingFailed`: the listing after the create
 * failed with `cause`, so a minted key may remain.
 *
 * @stability unstable
 */
export class DeploymentGrantUnproven extends Schema.TaggedError<
  DeploymentGrantUnproven,
  { readonly brand: unique symbol }
>()("DeploymentGrantUnproven", {
  deploymentName: Schema.String,
  keyName: Schema.String,
  reason: Schema.Literals(["Minted", "ListingChanged", "ListingFailed"]),
  deleted: Schema.optionalKey(Schema.Boolean),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message() {
    switch (this.reason) {
      case "Minted":
        return `The management login minted deploy key ${this.keyName} for ${this.deploymentName}, so it is not an OAuth grant. ${this.deleted === true ? "The key was deleted." : `The key could not be deleted; delete ${this.keyName} in the Convex dashboard.`} Supply a deploy key with DeploymentAccess.deployKey.`;
      case "ListingChanged":
        return `Another deploy key appeared on ${this.deploymentName} while access was checked, so the check could not tell whether this login mints keys. Nothing was deleted. Deploy again.`;
      case "ListingFailed":
        return `The deploy keys of ${this.deploymentName} could not be listed after the grant check asked for key ${this.keyName}. If that key is listed, the login minted it: delete ${this.keyName} in the Convex dashboard. The next deploy refuses while it is listed.`;
    }
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
 * The credential for calls to a deployment, supplied at run time so the deploy
 * path keeps none in props, attributes or state.
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
      | DeploymentAccessRefused
      | DeploymentGrantRefused
      | DeploymentGrantUnproven
      | ConvexClientError
    >;
  }
>()("@confect/alchemy/DeploymentAccess") {}

// Every key the grant check asks for starts with this, so a key a minting
// login left behind is recognised by later runs. The rest of the name is
// unpredictable and belongs to one attempt.
const grantKeyPrefix = "confect-alchemy-access";

const attemptKeyName = Effect.sync(
  () =>
    `${grantKeyPrefix}-${Array.join(
      Array.map(
        Array.fromIterable(SecureRandom.randomBytesUnsafe(16)),
        (byte) => Str.padStart(2, "0")(byte.toString(16)),
      ),
      "",
    )}`,
);

const grantService = Effect.gen(function* () {
  const client = yield* ConvexClient;
  const issued = new Map<string, Redacted.Redacted<string>>();
  let projectScoped = false;
  const serial = Semaphore.makeUnsafe(1);
  const issue = Effect.fn("DeploymentAccess.grantKey")(function* ({
    name,
  }: Deployment) {
    const cached = issued.get(name);
    if (cached !== undefined) return cached;
    if (!projectScoped) {
      const details = yield* client.getTokenDetails();
      if (details.type !== "projectToken")
        return yield* DeploymentGrantRefused.make({
          deploymentName: name,
          reason: "TeamScoped",
          keyNames: [],
        });
      projectScoped = true;
    }
    const before = yield* client.listDeployKeys(name);
    const leftover = Array.filter(before, (key) =>
      Str.startsWith(grantKeyPrefix)(key.name),
    );
    if (leftover.length > 0)
      return yield* DeploymentGrantRefused.make({
        deploymentName: name,
        reason: "LeftoverKeys",
        keyNames: Array.map(leftover, (key) => key.name),
      });
    const keyName = yield* attemptKeyName;
    const created = yield* client.createDeployKey(name, { name: keyName });
    const after = yield* client.listDeployKeys(name).pipe(
      Effect.mapError((cause) =>
        DeploymentGrantUnproven.make({
          deploymentName: name,
          keyName,
          reason: "ListingFailed",
          cause,
        }),
      ),
    );
    const known = new Set(Array.map(before, (key) => key.id));
    const added = Array.filter(after, (key) => !known.has(key.id));
    const minted = Array.filter(added, (key) =>
      DeploymentName.isKeyNamed(key.name, keyName),
    );
    if (minted.length > 0) {
      const deleted = yield* Effect.forEach(
        minted,
        (key) =>
          client
            .deleteDeployKey(name, key.name)
            .pipe(Effect.catchTag("ConvexNotFound", () => Effect.void)),
        { discard: true },
      ).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      return yield* DeploymentGrantUnproven.make({
        deploymentName: name,
        keyName,
        reason: "Minted",
        deleted,
      });
    }
    if (added.length > 0)
      return yield* DeploymentGrantUnproven.make({
        deploymentName: name,
        keyName,
        reason: "ListingChanged",
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

const keyService = (supplied: ReadonlyArray<SuppliedKey>) =>
  Effect.gen(function* () {
    const refused = (
      reason: DeploymentAccessRefused["reason"],
      target: { readonly deploymentName?: string; readonly url?: string } = {},
    ) => DeploymentAccessRefused.make({ kind: "deployKey", reason, ...target });
    const credentials = yield* Redaction.credentials;
    // Every key resolves on the first request, so a bad or doubled key is
    // refused before any request and a plan that sends none never reads one.
    const byDeployment = yield* Effect.cached(
      Effect.gen(function* () {
        const keys = new Map<string, Redacted.Redacted<string>>();
        for (const each of supplied) {
          const key = Config.isConfig(each)
            ? yield* each.pipe(Effect.mapError(() => refused("KeyUnavailable")))
            : each;
          yield* credentials.add(key);
          const name = key.pipe(Redacted.value, DeploymentName.ofDeployKey);
          if (Option.isNone(name)) return yield* refused("InvalidKey");
          if (keys.has(name.value))
            return yield* refused("DuplicateDeployment", {
              deploymentName: name.value,
            });
          keys.set(name.value, key);
        }
        return keys;
      }),
    );
    const serve = Effect.fn("DeploymentAccess.serve")(function* (
      deploymentName: string,
    ) {
      const key = (yield* byDeployment).get(deploymentName);
      if (key === undefined)
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
    access.kind === "grant" ? grantService : keyService(access.keys),
  );

/**
 * Under `alchemy dev`, each request reads the local backend's admin key from
 * its data directory, so a recreated backend's new key is used.
 *
 * @stability unstable
 */
export const localLayer = Layer.effect(DeploymentAccess, localService);
