import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Convex } from "@confect/alchemy";
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
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import { tmpdir } from "node:os";
import { deploy } from "../../src/internal/CodeDeployment";
import {
  CommandRunner,
  layer as runnerLayer,
} from "../../src/internal/CommandRunner";
import { layer as lockLayer } from "../../src/internal/PushLock";

// Runs the real pinned backend: it downloads the release once into a cache
// under the OS temp directory, binds ports 3300-3399, and is skipped on
// Windows, where it has not been verified.
const fixture = new URL("../fixtures/local-app", import.meta.url).pathname;
const modules = new URL("../../node_modules", import.meta.url).pathname;

const app = (root: string, name: string, schemaFields: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(root, name);
    yield* fs.copy(fixture, directory);
    yield* fs.symlink(modules, path.join(directory, "node_modules"));
    yield* fs.writeFileString(
      path.join(directory, "package.json"),
      '{ "private": true, "type": "module", "dependencies": { "convex": "*" } }\n',
    );
    yield* fs.writeFileString(
      path.join(directory, "convex", "schema.ts"),
      `import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({ notes: defineTable({ ${schemaFields} }) });
`,
    );
    return directory;
  });

const query = <A>(url: string, name: string) =>
  Effect.promise(() =>
    new ConvexHttpClient(url).query(
      makeFunctionReference<"query", Record<string, never>, A>(name),
      {},
    ),
  );

const stack = (cwd: string) =>
  Effect.gen(function* () {
    const deployment = yield* Convex.Deployment("Deployment", {
      projectId: 0,
      type: "dev",
    });
    const key = yield* Convex.DeployKey("Key", {
      deploymentName: deployment.name,
    });
    const environment = yield* Convex.EnvironmentVariables("Environment", {
      url: deployment.url,
      deployKey: key.deployKey,
      variables: { GREETING: "set before the first push" },
    });
    const code = yield* Convex.Code("Code", {
      deployment: {
        name: deployment.name,
        url: Output.map(
          Output.all(environment.variables, environment.url),
          ([, url]) => url,
        ),
      },
      deployKey: key.deployKey,
      cwd,
    });
    return { name: code.name, url: code.url, adminKey: key.deployKey };
  });

describe.skipIf(process.platform === "win32")("real local backend", () => {
  it.live(
    "runs a pushed app against env set before the push, restarts on its data, and serialises concurrent pushes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "confect-real-backend-",
        });
        const cache = path.join(tmpdir(), "confect-alchemy-backend-cache");
        const temp = path.join(root, "tmp");
        yield* fs.makeDirectory(temp, { recursive: true });
        const dotAlchemy = path.join(root, ".alchemy");
        const appA = yield* app(root, "app-a", "text: v.string()");
        const appB = yield* app(
          root,
          "app-b",
          "text: v.string(), tag: v.optional(v.string())",
        );
        const config = ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            PATH: yield* Config.String("PATH"),
            HOME: cache,
            LOCALAPPDATA: cache,
            TMPDIR: temp,
            CONFECT_LOCAL_BACKEND_PORTS: "3300-3399",
          }),
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
            dotAlchemy,
            dev: true,
            adopt: false,
          }),
          config,
        );
        const state = inMemoryState();
        const session = <B, E2, R2>(
          during: (outputs: {
            readonly name: string;
            readonly url: string;
            readonly adminKey: Redacted.Redacted<string>;
          }) => Effect.Effect<B, E2, R2>,
        ) =>
          stack(appA).pipe(
            Stack.make({ name: "real", providers: Convex.providers(), state }),
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

        const intervals: Array<readonly [number, number]> = [];
        const recordingRunner = Layer.effect(
          CommandRunner,
          Effect.gen(function* () {
            const runner = yield* CommandRunner;
            return CommandRunner.of({
              prepare: runner.prepare,
              deploy: (target, cwd) =>
                Effect.gen(function* () {
                  const start = yield* Clock.currentTimeMillis;
                  yield* runner.deploy(target, cwd);
                  intervals.push([start, yield* Clock.currentTimeMillis]);
                }),
            });
          }),
        ).pipe(Layer.provide(runnerLayer));

        const first = yield* session((outputs) =>
          Effect.gen(function* () {
            expect(outputs.url).toMatch(/^http:\/\/127\.0\.0\.1:33\d\d$/);
            yield* Effect.log(
              `backend ${outputs.name} ready at ${outputs.url}`,
            );
            expect(yield* query<string>(outputs.url, "greeting:get")).toBe(
              "set before the first push",
            );
            yield* Effect.promise(() =>
              new ConvexHttpClient(outputs.url).mutation(
                makeFunctionReference<"mutation", { text: string }, null>(
                  "notes:add",
                ),
                { text: "kept across restarts" },
              ),
            );
            yield* Effect.forEach(
              [appA, appB],
              (cwd) =>
                deploy(
                  {
                    deployment: { name: outputs.name, url: outputs.url },
                    deployKey: outputs.adminKey,
                    cwd,
                  },
                  "local",
                ),
              { concurrency: "unbounded" },
            ).pipe(
              Effect.provide(Layer.mergeAll(recordingRunner, lockLayer())),
            );
            return outputs;
          }),
        );
        const [a, b] = intervals.toSorted(([x], [y]) => x - y);
        yield* Effect.log(
          `concurrent pushes ran ${a?.[0]}-${a?.[1]} and ${b?.[0]}-${b?.[1]}`,
        );
        expect(a && b && a[1] <= b[0]).toBe(true);
        expect(
          yield* HttpClient.get(`${first.url}/instance_name`).pipe(
            Effect.as("answered"),
            Effect.orElseSucceed(() => "stopped"),
            Effect.provide(FetchHttpClient.layer),
          ),
        ).toBe("stopped");

        const restarted = yield* session((outputs) =>
          Effect.gen(function* () {
            expect(yield* query<string[]>(outputs.url, "notes:list")).toEqual([
              "kept across restarts",
            ]);
            expect(yield* query<string>(outputs.url, "greeting:get")).toBe(
              "set before the first push",
            );
            return outputs;
          }),
        );
        yield* Effect.log(
          `restarted ${restarted.name} on its saved data at ${restarted.url}`,
        );
        expect(restarted.url).toBe(first.url);
        expect(restarted.name).toBe(first.name);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    300_000,
  );
});
