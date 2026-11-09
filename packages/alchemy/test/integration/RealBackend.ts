import * as NodeServices from "@effect/platform-node/NodeServices";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { apply } from "alchemy/Apply";
import { provideFreshArtifactStore } from "alchemy/Artifacts";
import { AuthProviders } from "alchemy/Auth/AuthProvider";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import { layerNonInteractive } from "alchemy/Interaction";
import * as Output from "alchemy/Output";
import * as Plan from "alchemy/Plan";
import * as Stack from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import { inMemoryState } from "alchemy/State/InMemoryState";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { tmpdir } from "node:os";
// The built package, not its source, so these tests run what ships.
import { Convex } from "../../dist/index.js";
import * as ConvexClient from "../../dist/ConvexClient.js";
import { deploy } from "../../dist/internal/CodeDeployment.js";
import {
  CommandRunner,
  layer as runnerLayer,
} from "../../dist/internal/CommandRunner.js";
import { PushLock, layer as lockLayer } from "../../dist/internal/PushLock.js";

export interface Outputs {
  readonly name: string;
  readonly url: string;
  readonly adminKey: Redacted.Redacted<string>;
}

export const localClient = ConvexClient.layer({ mode: "local" }).pipe(
  Layer.provide(FetchHttpClient.layer),
);

export interface Code {
  readonly cwd: string;
  readonly prepare?: { readonly command: string; readonly args: Array<string> };
  /**
   * Environment variables set before the first push.
   */
  readonly variables?: Record<string, string>;
}

const stack = ({ variables, ...code }: Code) =>
  Effect.gen(function* () {
    const deployment = yield* Convex.Deployment("Deployment", {
      projectId: 0,
      type: "dev",
    });
    const key = yield* Convex.DeployKey("Key", {
      deploymentName: deployment.name,
    });
    const environment =
      variables === undefined
        ? undefined
        : yield* Convex.EnvironmentVariables("Environment", {
            url: deployment.url,
            deployKey: key.deployKey,
            variables,
          });
    const deployed = yield* Convex.Code("Code", {
      deployment: {
        name: deployment.name,
        url:
          environment === undefined
            ? deployment.url
            : Output.map(
                Output.all(environment.variables, environment.url),
                ([, url]) => url,
              ),
      },
      deployKey: key.deployKey,
      ...code,
    });
    return { name: deployed.name, url: deployed.url, adminKey: key.deployKey };
  });

interface VitestGlobal {
  readonly __vitest_worker__?: {
    readonly config?: { readonly pool?: string };
    readonly evaluatedModules?: {
      readonly fileToModulesMap: ReadonlyMap<string, unknown>;
    };
  };
}

/**
 * Fail unless this test process runs the built packages. An `@confect/*` import
 * is aliased to source, so only vitest's module registry shows where each
 * import landed. `make` runs it and registers it to run again when the scope
 * closes, which catches a source import made after `make`.
 *
 * The registry is the test process's own. A worker the code under test starts
 * has another, which this cannot see, and the acceptance starts none.
 */
const runsBuiltPackages = Effect.suspend(() => {
  const worker = (globalThis as VitestGlobal).__vitest_worker__;
  const loaded = worker?.evaluatedModules?.fileToModulesMap;
  const self = new URL(import.meta.url).pathname;
  if (loaded === undefined || !loaded.has(self))
    return Effect.die(
      new Error(
        "vitest's module registry no longer lists this harness, so it cannot check that it runs the built packages",
      ),
    );
  if (worker?.config?.pool !== "forks" && worker?.config?.pool !== "threads")
    return Effect.die(
      new Error(
        `The harness checks the module registry of a forks or threads pool, not "${worker?.config?.pool}"`,
      ),
    );
  const source = [...loaded.keys()].filter((file) =>
    /\/packages\/[^/]+\/src\//.test(file),
  );
  return source.length === 0
    ? Effect.void
    : Effect.die(
        new Error(
          `The real-backend harness runs the built packages, but this test loaded their source: ${source.join(", ")}`,
        ),
      );
});

/**
 * A temp root and one Alchemy state for a test. Each `session` applies a stack
 * of a deployment, its key and `Code`, which starts the real pinned backend, or
 * restarts it on the state's data, then runs `during` and stops the backend.
 * The backend binds a port in `ports`, unless CONFECT_LOCAL_BACKEND_PORTS
 * overrides the range.
 */
export const make = Effect.fn("RealBackend.make")(function* (options: {
  readonly name: string;
  readonly ports: string;
}) {
  yield* runsBuiltPackages;
  yield* Effect.addFinalizer(() => runsBuiltPackages);
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({
    prefix: `confect-${options.name}-`,
  });
  const cache = `${tmpdir()}/confect-alchemy-backend-cache`;
  yield* fs.makeDirectory(`${root}/tmp`);
  const ports = yield* Config.String("CONFECT_LOCAL_BACKEND_PORTS").pipe(
    Config.withDefault(options.ports),
  );
  const context = Layer.mergeAll(
    Layer.mergeAll(
      CredentialsStoreLive,
      ProfileStoreLive,
      layerNonInteractive(),
      FetchHttpClient.layer,
    ).pipe(Layer.provideMerge(NodeServices.layer)),
    Layer.succeed(Stage, "dev"),
    Layer.succeed(AuthProviders, {}),
    Layer.succeed(AlchemyContext, {
      dotAlchemy: `${root}/.alchemy`,
      dev: true,
      adopt: false,
    }),
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        PATH: yield* Config.String("PATH"),
        HOME: cache,
        LOCALAPPDATA: cache,
        TMPDIR: `${root}/tmp`,
        CONFECT_LOCAL_BACKEND_PORTS: ports,
      }),
    ),
  );
  const state = inMemoryState();
  const session = <B, E>(
    code: Code,
    during: (outputs: Outputs) => Effect.Effect<B, E>,
  ) =>
    stack(code).pipe(
      Stack.make({ name: options.name, providers: Convex.providers(), state }),
      Effect.flatMap((compiled) =>
        Plan.make(compiled).pipe(
          Effect.flatMap(apply),
          Effect.flatMap(during),
          Effect.provideContext(compiled.services),
        ),
      ),
      Effect.provide(state),
      provideFreshArtifactStore,
      Effect.provide(context),
      Effect.scoped,
    );
  const [low = 0, high = 0] = ports.split("-").map(Number);
  return { root, ports: { low, high }, session };
});

/**
 * Copy `fixture` to `directory` as a private ESM package named for the
 * directory, each `links` entry a symlink at that relative path to an absolute
 * source.
 */
export const copyApp = Effect.fn("RealBackend.copyApp")(function* (
  fixture: string,
  directory: string,
  links: Record<string, string>,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.copy(fixture, directory);
  for (const [at, source] of Object.entries(links)) {
    const link = `${directory}/${at}`;
    yield* fs.makeDirectory(link.slice(0, link.lastIndexOf("/")), {
      recursive: true,
    });
    yield* fs.symlink(source, link);
  }
  yield* fs.writeFileString(
    `${directory}/package.json`,
    `{ "name": "${directory.slice(directory.lastIndexOf("/") + 1)}", "private": true, "type": "module", "dependencies": { "convex": "*" } }\n`,
  );
});

/**
 * Run a deployment function with admin authority, at `componentPath` if given.
 */
export const call = (
  outputs: Outputs,
  functionPath: string,
  componentPath?: string,
  args: unknown = {},
) =>
  Effect.gen(function* () {
    const client = yield* ConvexClient.ConvexClient;
    return yield* client.runFunction(
      outputs.url,
      outputs.adminKey,
      functionPath,
      args,
      componentPath,
    );
  }).pipe(Effect.provide(localClient), Effect.orDie);

/**
 * Hooks a test uses to line two pushes up: `attempting` runs as the push asks
 * for the lock, `coded` after its code push and before any `init`.
 */
export interface Probe {
  readonly attempting?: Effect.Effect<void>;
  readonly coded?: Effect.Effect<void>;
}

/**
 * The real lock, runner and client, each noting into `events`, tagged, the lock
 * attempt, acquire and release, the code push and each mount's `init`.
 */
const recording = (tag: string, events: Array<string>, probe: Probe) => {
  const note = (event: string) =>
    Effect.sync(() => {
      events.push(`${tag} ${event}`);
    });
  return Layer.mergeAll(
    Layer.effect(
      PushLock,
      Effect.map(PushLock, (lock) =>
        PushLock.of({
          withLock: (name, effect) =>
            note("attempt").pipe(
              Effect.andThen(probe.attempting ?? Effect.void),
              Effect.andThen(
                lock.withLock(
                  name,
                  note("acquire").pipe(
                    Effect.andThen(effect),
                    Effect.ensuring(note("release")),
                  ),
                ),
              ),
            ),
        }),
      ),
    ).pipe(Layer.provide(lockLayer())),
    Layer.effect(
      CommandRunner,
      Effect.map(CommandRunner, (runner) =>
        CommandRunner.of({
          prepare: runner.prepare,
          deploy: (target, cwd) =>
            runner
              .deploy(target, cwd)
              .pipe(
                Effect.andThen(note("code")),
                Effect.andThen(probe.coded ?? Effect.void),
              ),
        }),
      ),
    ).pipe(Layer.provide(runnerLayer)),
    Layer.effect(
      ConvexClient.ConvexClient,
      Effect.map(ConvexClient.ConvexClient, (client) =>
        ConvexClient.ConvexClient.of({
          ...client,
          runFunction: (url, key, functionPath, args, componentPath) =>
            (functionPath === "confectDeploy:steps"
              ? Effect.void
              : note(`init ${componentPath}`)
            ).pipe(
              Effect.andThen(
                client.runFunction(url, key, functionPath, args, componentPath),
              ),
            ),
        }),
      ),
    ).pipe(Layer.provide(localClient)),
  );
};

/**
 * Push `cwd` to the session's deployment through the built `Code.deploy`, as a
 * repeated Alchemy push does, and return its result.
 */
export const push = (
  outputs: Outputs,
  props: Omit<Code, "variables">,
  tag = "push",
  events: Array<string> = [],
  probe: Probe = {},
) =>
  deploy(
    {
      deployment: { name: outputs.name, url: outputs.url },
      deployKey: outputs.adminKey,
      ...props,
    },
    "local",
  ).pipe(
    Effect.provide(
      recording(tag, events, probe).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.result,
  );
