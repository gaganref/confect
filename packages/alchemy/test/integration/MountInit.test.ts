import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { Convex } from "@confect/alchemy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { apply } from "alchemy/Apply";
import { provideFreshArtifactStore } from "alchemy/Artifacts";
import { AuthProviders } from "alchemy/Auth/AuthProvider";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import { layerNonInteractive } from "alchemy/Interaction";
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
import * as Result from "effect/Result";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { tmpdir } from "node:os";
import * as ConvexClient from "../../src/ConvexClient";
import { deploy } from "../../src/internal/CodeDeployment";
import {
  CommandRunner,
  layer as runnerLayer,
} from "../../src/internal/CommandRunner";
import { PushLock, layer as lockLayer } from "../../src/internal/PushLock";

// Runs the real pinned backend, as RealLocalBackend.test.ts does, on ports
// 3400-3499. Every push runs the real codegen and `convex deploy`.
const fixture = new URL("../fixtures/init-app", import.meta.url).pathname;
const modules = new URL("../../node_modules", import.meta.url).pathname;
const packages = new URL("../../..", import.meta.url).pathname;
const prepare = { command: "confect", args: ["codegen"] };

interface Sender {
  readonly fromName: string;
  readonly maxAttempts?: number;
}
interface Args {
  readonly bulkEmail: Sender;
  readonly transactionalEmail: Sender;
  readonly bulkTarget: "record" | "gone";
  readonly withGone: boolean;
}
const initial: Args = {
  bulkEmail: { fromName: "School office", maxAttempts: 3 },
  transactionalEmail: { fromName: "Receipts", maxAttempts: 2 },
  bulkTarget: "record",
  withGone: true,
};
type Row = Record<string, unknown> & { readonly _id: string };

const codegen = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const code = yield* spawner.exitCode(
      ChildProcess.make(
        process.execPath,
        [`${packages}/cli/bin/confect.mjs`, "codegen", ...args],
        { cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
      ),
    );
    if (code !== 0)
      return yield* Effect.die(`codegen ${args.join(" ")} exited ${code}`);
  }).pipe(Effect.orDie);

/**
 * A copy of the fixture with its components generated. A host's first codegen
 * bundles `confect/app.ts` before it writes `_generated/refs`, which the mount
 * files import, so it first runs on a declaration without mounts.
 */
const app = (root: string, name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = `${root}/${name}`;
    yield* fs.copy(fixture, directory);
    yield* fs.makeDirectory(`${directory}/node_modules/@confect`, {
      recursive: true,
    });
    for (const dependency of ["convex", "effect"])
      yield* fs.symlink(
        `${modules}/${dependency}`,
        `${directory}/node_modules/${dependency}`,
      );
    for (const dependency of ["cli", "core", "server"])
      yield* fs.symlink(
        `${packages}/${dependency}`,
        `${directory}/node_modules/@confect/${dependency}`,
      );
    yield* fs.writeFileString(
      `${directory}/package.json`,
      `{ "name": "${name}", "private": true, "type": "module", "dependencies": { "convex": "*" } }\n`,
    );
    for (const component of ["email"]) {
      yield* fs.makeDirectory(`${directory}/components/${component}/convex`);
      yield* codegen(
        directory,
        "--component-dir",
        `components/${component}/convex`,
      );
    }
    yield* fs.makeDirectory(`${directory}/convex`);
    const declaration = `${directory}/confect/app.ts`;
    const declared = yield* fs.readFileString(declaration);
    yield* fs.writeFileString(
      declaration,
      'import { App } from "@confect/core";\nimport env from "./env";\nexport default App.make({ env });\n',
    );
    yield* codegen(directory);
    yield* fs.writeFileString(declaration, declared);
    return directory;
  });

const localClient = ConvexClient.layer({ mode: "local" }).pipe(
  Layer.provide(FetchHttpClient.layer),
);

/**
 * The real lock, runner and client, each noting what it does, so a test reads
 * the order of lock acquire, code push, each `init` and release.
 */
const recording = (tag: string, events: Array<string>) => {
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
            lock.withLock(
              name,
              note("acquire").pipe(
                Effect.andThen(effect),
                Effect.ensuring(note("release")),
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
            runner.deploy(target, cwd).pipe(Effect.andThen(note("code"))),
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

interface Deployment {
  readonly push: (
    cwd: string,
    args: Args,
    tag?: string,
    events?: Array<string>,
  ) => Effect.Effect<Result.Result<unknown, unknown>>;
  readonly call: (
    functionPath: string,
    componentPath?: string,
    args?: unknown,
  ) => Effect.Effect<unknown>;
  readonly settings: (componentPath: string) => Effect.Effect<Row>;
  readonly apps: readonly [string, string];
}

/**
 * Create a local deployment whose first push is the stack's own `Convex.Code`,
 * then hand the scenario a push and a reader of each mount's stored config. The
 * backend stops when the scenario ends.
 */
const withDeployment = <A, E>(
  scenario: (deployment: Deployment) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "confect-mount-init-",
    });
    const cache = `${tmpdir()}/confect-alchemy-backend-cache`;
    yield* fs.makeDirectory(`${root}/tmp`);
    const apps = [
      yield* app(root, "app-a"),
      yield* app(root, "app-b"),
    ] as const;
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
          CONFECT_LOCAL_BACKEND_PORTS: "3400-3499",
        }),
      ),
    );
    const state = inMemoryState();
    const stack = Effect.gen(function* () {
      const deployment = yield* Convex.Deployment("Deployment", {
        projectId: 0,
        type: "dev",
      });
      const key = yield* Convex.DeployKey("Key", {
        deploymentName: deployment.name,
      });
      const code = yield* Convex.Code("Code", {
        deployment: { name: deployment.name, url: deployment.url },
        deployKey: key.deployKey,
        cwd: apps[0],
        prepare,
      });
      return { name: code.name, url: code.url, adminKey: key.deployKey };
    });
    const during = ({
      name,
      url,
      adminKey,
    }: {
      readonly name: string;
      readonly url: string;
      readonly adminKey: Redacted.Redacted<string>;
    }) =>
      Effect.gen(function* () {
        const client = yield* Effect.provide(
          ConvexClient.ConvexClient,
          localClient,
        );
        const call = (
          functionPath: string,
          componentPath?: string,
          args: unknown = {},
        ) =>
          client
            .runFunction(url, adminKey, functionPath, args, componentPath)
            .pipe(Effect.orDie);
        const push: Deployment["push"] = (
          cwd,
          args,
          tag = "push",
          events = [],
        ) =>
          fs
            .writeFileString(
              `${cwd}/confect/args.ts`,
              `export default ${JSON.stringify(args)};\n`,
            )
            .pipe(
              Effect.andThen(
                deploy(
                  {
                    deployment: { name, url },
                    deployKey: adminKey,
                    cwd,
                    prepare,
                  },
                  "local",
                ),
              ),
              Effect.provide(
                recording(tag, events).pipe(
                  Layer.provideMerge(NodeServices.layer),
                ),
              ),
              Effect.result,
            );
        return yield* scenario({
          push,
          call,
          settings: (componentPath) =>
            call("install:settings", componentPath) as Effect.Effect<Row>,
          apps,
        });
      });
    return yield* stack.pipe(
      Stack.make({ name: "init", providers: Convex.providers(), state }),
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
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe.skipIf(process.platform === "win32")("mount init on a push", () => {
  it.live(
    "stores each mount's config, keeps it on a repeated push, and keeps the previous config when init fails",
    () =>
      withDeployment(({ push, call, settings, apps: [appA] }) =>
        Effect.gen(function* () {
          const both = Effect.all({
            bulkEmail: settings("bulkEmail"),
            transactionalEmail: settings("transactionalEmail"),
          });
          const first = yield* both;
          expect(first.bulkEmail).toMatchObject(initial.bulkEmail);
          expect(first.bulkEmail.onEvent).toEqual(expect.any(String));
          expect(first.transactionalEmail).toMatchObject(
            initial.transactionalEmail,
          );

          expect(Result.isSuccess(yield* push(appA, initial))).toBe(true);
          expect(yield* both).toEqual(first);

          const trimmed = {
            ...initial,
            bulkEmail: { fromName: "School office" },
          };
          expect(Result.isSuccess(yield* push(appA, trimmed))).toBe(true);
          const removed = yield* settings("bulkEmail");
          expect(removed._id).toBe(first.bulkEmail._id);
          expect(Object.hasOwn(removed, "maxAttempts")).toBe(false);
          expect((yield* both).transactionalEmail).toEqual(
            first.transactionalEmail,
          );

          const failed = yield* push(appA, {
            ...trimmed,
            bulkEmail: { fromName: "FAIL_AFTER_WRITE" },
          });
          assert(Result.isFailure(failed));
          expect(failed.failure).toMatchObject({
            _tag: "MountInitFailed",
            mount: "bulkEmail",
            detail: expect.stringContaining("SyntheticInitAfterWrite"),
          });
          expect(yield* settings("bulkEmail")).toEqual(removed);

          yield* call("install:send", "bulkEmail", {
            message: "Synthetic callback",
          });
          const sent = (yield* call("events:list")) as ReadonlyArray<Row>;
          expect(
            sent.map(({ fromName, message }) => ({ fromName, message })),
          ).toEqual([
            { fromName: "School office", message: "Synthetic callback" },
          ]);
        }),
      ),
    600_000,
  );
});
