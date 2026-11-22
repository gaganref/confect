import * as Provider from "alchemy/Provider";
import type { ProviderMode } from "alchemy/ProviderMode";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { ConvexClient, layer as ConvexClientLayer } from "./ConvexClient.js";
import {
  DeploymentAccess,
  localLayer as localAccess,
} from "./DeploymentAccess.js";
import type { Providers } from "./Providers.js";
import { checkDeployment, deploy } from "./internal/CodeDeployment.js";

export { HealthCheckFailed, StaleManifest } from "./internal/CodeDeployment.js";
import {
  CommandRunner,
  type PrepareCommand,
} from "./internal/CommandRunner.js";
import { PushLock } from "./internal/PushLock.js";
import * as Redaction from "./internal/Redaction.js";

/**
 * The push takes its deploy key from the run's `DeploymentAccess`, so no key is
 * a prop.
 */
export interface CodeProps {
  readonly deployment: { readonly name: string; readonly url: string };
  readonly cwd?: string;
  readonly prepare?: PrepareCommand;
  /**
   * The digest of the manifest this push deploys. After `prepare` and before
   * the push, the deploy verifies the complete generated `confectHealth.ts`
   * with LF or CRLF line endings. Edited or missing files fail with
   * `StaleManifest` reason `NotGenerated`; another digest uses
   * `DifferentDigest`. Both push nothing. Do not edit or format the generated
   * file. After every mount's `init`, still inside the push lock, it asks the
   * pushed code which digest it was generated with and fails when it answers
   * nothing or another one.
   */
  readonly manifestDigest?: string;
}

export interface CodeAttributes {
  readonly name: string;
  readonly url: string;
}

export type Code = Resource<
  "Convex.Code",
  CodeProps,
  CodeAttributes,
  never,
  Providers
>;
export const Code = Resource<Code>("Convex.Code");

const make = (mode: ProviderMode) =>
  Effect.gen(function* () {
    const runner = yield* CommandRunner;
    const lock = yield* PushLock;
    const client = yield* ConvexClient;
    const access = yield* DeploymentAccess;
    const credentials = yield* Redaction.credentials;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return {
      read: ({ output }) => Effect.succeed(output),
      diff: () => Effect.succeed({ action: "update" }),
      reconcile: Effect.fn("Code.reconcile")(function* ({ news }) {
        yield* Effect.fromResult(checkDeployment(news.deployment, mode));
        const deployKey = yield* access.deployKey(news.deployment);
        return yield* deploy({ ...news, deployKey }, mode).pipe(
          Effect.provideService(CommandRunner, runner),
          Effect.provideService(PushLock, lock),
          Effect.provideService(ConvexClient, client),
          Effect.provideService(Redaction.Credentials, credentials),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
      }),
      delete: () => Effect.void,
    } satisfies Provider.ProviderServiceInput<Code>;
  });

/**
 * @stability unstable
 */
export const provider = make("live");
/**
 * Under `alchemy dev`, pushes go to the local backend's self-hosted target.
 *
 * @stability unstable
 */
export const localProvider = make("local");

/**
 * @stability unstable
 */
export const layer = Provider.effect(Code, provider);
/**
 * @stability unstable
 */
export const localLayer = Provider.effect(Code, localProvider).pipe(
  Layer.provide(
    Layer.mergeAll(
      ConvexClientLayer({ mode: "local" }).pipe(
        Layer.provide(FetchHttpClient.layer),
      ),
      localAccess,
    ),
  ),
);
