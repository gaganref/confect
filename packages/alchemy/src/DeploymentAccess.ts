import * as Array from "effect/Array";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
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
 * health check get the key `create_deploy_key` returns, which Convex documents
 * as using the same token under an OAuth grant.
 *
 * Before this access serves its first request, `GET /token_details` must answer
 * `projectToken`, so a team-scoped login is refused before any request to a
 * deployment. That shows the login's scope, not that it is an OAuth grant. The
 * key is then judged by direct evidence. A returned key whose secret is the
 * login shows the grant was reused. A key listed under the name this attempt
 * asked for, when the returned key is not the login, shows one was minted; it
 * is deleted and the run fails. When the returned key is the login, such a key
 * may be the grant itself, so nothing is deleted and the run fails. The rest of
 * the listing decides nothing.
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
 * The grant was refused before any request to a deployment. `TeamScoped`: `GET
 * /token_details` answered `teamToken`, whatever the login's origin; the
 * deployment is `deploymentName`, or `url` when that names none.
 * `LeftoverKeys`: the deployment lists keys under names this package's grant
 * check generates, named in `keyNames`, so no key was created.
 *
 * @stability unstable
 */
export class DeploymentGrantRefused extends Schema.TaggedError<
  DeploymentGrantRefused,
  { readonly brand: unique symbol }
>()("DeploymentGrantRefused", {
  reason: Schema.Literals(["TeamScoped", "LeftoverKeys"]),
  deploymentName: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  keyNames: Schema.Array(Schema.String),
}) {
  override get message() {
    const target = this.deploymentName ?? this.url ?? "the deployment";
    return this.reason === "TeamScoped"
      ? `DeploymentAccess.grant needs a project-scoped management login, and this login is team scoped, so nothing was sent to ${target}. With a team-scoped credential, supply a deploy key for ${target} with DeploymentAccess.deployKey.`
      : `${target} lists deploy keys whose names match what this package's grant check generates: ${Array.join(this.keyNames, ", ")}. A login that mints keys may have left them. Check who created each one in the Convex dashboard before you delete it. No key was created. To deploy without the check, supply a deploy key with DeploymentAccess.deployKey.`;
  }
}

/**
 * The grant check asked Convex for a key named `keyName` and could not use it.
 * `Minted`: the returned key was not the login and the deployment lists a key
 * under that name, so the login mints keys; `deleted` says whether every such
 * key is gone. `LoginKeyListed`: the returned key was the login, yet the
 * deployment lists a key under that name, which may be the grant itself, so
 * nothing was deleted. `ListingFailed`: the returned key was not the login, and
 * the listing after the create failed with `cause`, so a minted key may
 * remain.
 *
 * @stability unstable
 */
export class DeploymentGrantUnproven extends Schema.TaggedError<
  DeploymentGrantUnproven,
  { readonly brand: unique symbol }
>()("DeploymentGrantUnproven", {
  deploymentName: Schema.String,
  keyName: Schema.String,
  reason: Schema.Literals(["Minted", "LoginKeyListed", "ListingFailed"]),
  deleted: Schema.optionalKey(Schema.Boolean),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message() {
    switch (this.reason) {
      case "Minted":
        return `${this.deploymentName} lists deploy key ${this.keyName}, which the grant check asked for, so the management login mints keys instead of lending its own grant. ${this.deleted === true ? "The key was deleted." : `The key could not be deleted; delete ${this.keyName} in the Convex dashboard.`} Supply a deploy key with DeploymentAccess.deployKey.`;
      case "LoginKeyListed":
        return `The deploy key Convex returned to the grant check for ${this.deploymentName} is the management login, yet ${this.deploymentName} lists a deploy key under ${this.keyName}, the name this check asked for. That listed key may be the grant itself, so nothing was deleted. Check what ${this.keyName} is in the Convex dashboard before you delete anything. To deploy, supply a deploy key with DeploymentAccess.deployKey.`;
      case "ListingFailed":
        return `The deploy keys of ${this.deploymentName} could not be listed after the grant check asked for key ${this.keyName}, and the returned key is not the management login. If ${this.keyName} is listed, the login minted it: delete ${this.keyName} in the Convex dashboard. The next deploy refuses while it is listed.`;
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
     * management login. Under `grant` the run's first request checks the
     * login's scope with `GET /token_details`; otherwise it sends nothing.
     */
    readonly api: (
      url: string,
    ) => Effect.Effect<
      Redacted.Redacted<string> | undefined,
      DeploymentAccessRefused | DeploymentGrantRefused | ConvexClientError
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

// Every key the grant check asks for is named with this prefix, a hyphen and
// 32 random hex digits, so the name belongs to one attempt. The first version
// of the check used the prefix alone.
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

/**
 * Whether a listed key has a name this package's grant check generates. Any
 * other name, even one with the same prefix, is somebody else's.
 */
const isGrantKeyName = (listed: string) =>
  /^confect-alchemy-access-[0-9a-f]{32}(?: \([0-9a-f]{8}\))?$/.test(listed) ||
  DeploymentName.isKeyNamed(listed, grantKeyPrefix);

const grantService = Effect.gen(function* () {
  const client = yield* ConvexClient;
  const issued = new Map<string, Redacted.Redacted<string>>();
  // The answer is kept for the run. A request that failed is not, so a later
  // one asks again.
  let scope: "teamToken" | "projectToken" | undefined;
  const scopeCheck = Semaphore.makeUnsafe(1);
  const projectScoped = (target: {
    readonly deploymentName?: string;
    readonly url?: string;
  }) =>
    scopeCheck.withPermits(1)(
      Effect.gen(function* () {
        scope ??= (yield* client.getTokenDetails()).type;
        if (scope !== "projectToken")
          return yield* DeploymentGrantRefused.make({
            reason: "TeamScoped",
            keyNames: [],
            ...target,
          });
      }),
    );
  const serial = Semaphore.makeUnsafe(1);
  const issue = Effect.fn("DeploymentAccess.grantKey")(function* ({
    name,
  }: Deployment) {
    const cached = issued.get(name);
    if (cached !== undefined) return cached;
    yield* projectScoped({ deploymentName: name });
    const before = yield* client.listDeployKeys(name);
    const leftover = Array.filter(before, (key) => isGrantKeyName(key.name));
    if (leftover.length > 0)
      return yield* DeploymentGrantRefused.make({
        deploymentName: name,
        reason: "LeftoverKeys",
        keyNames: Array.map(leftover, (key) => key.name),
      });
    const keyName = yield* attemptKeyName;
    // The client adds the returned key to the run's redaction set and compares
    // it with the login before it returns, so neither value leaves it.
    const created = yield* client.createDeployKey(name, { name: keyName });
    const use = Effect.sync(() => {
      issued.set(name, created.deployKey);
      return created.deployKey;
    });
    // Only a row under this attempt's name shows a minted key. Rows under
    // other names, OAuth-managed or not, are not this attempt's and decide
    // nothing. A login that mints keys, on a listing that does not yet show the
    // new row, leaves one key under this attempt's name; the next run's
    // leftover check names it.
    const after = yield* client.listDeployKeys(name).pipe(Effect.result);
    if (Result.isFailure(after)) {
      if (created.reusesLogin) return yield* use;
      return yield* DeploymentGrantUnproven.make({
        deploymentName: name,
        keyName,
        reason: "ListingFailed",
        cause: after.failure,
      });
    }
    const minted = Array.filter(after.success, (key) =>
      DeploymentName.isKeyNamed(key.name, keyName),
    );
    // Convex documents that a key created under an OAuth grant uses the same
    // token, and it deletes keys by name, so when the returned key is the login
    // a row under this name may be the grant and deleting it could revoke it.
    if (minted.length > 0 && created.reusesLogin)
      return yield* DeploymentGrantUnproven.make({
        deploymentName: name,
        keyName,
        reason: "LoginKeyListed",
      });
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
    if (!created.reusesLogin)
      yield* Effect.logWarning(
        `DeploymentAccess.grant: on ${name}, reuse of the management login was not confirmed by comparison, and no deploy key named ${keyName} is listed; the returned key is used.`,
      );
    return yield* use;
  });
  return DeploymentAccess.of({
    kind: "grant",
    api: (url) =>
      projectScoped(
        Option.match(DeploymentName.ofCloudUrl(url), {
          onNone: () => ({ url }),
          onSome: (deploymentName) => ({ deploymentName }),
        }),
      ).pipe(Effect.as(undefined)),
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
