import * as CommandArgs from "./fixtures/CommandArgs";
import * as NodeServices from "./fixtures/NodeTestServices";
import { describe, expect, it } from "@effect/vitest";
import {
  provider as codeProvider,
  type CodeProps,
} from "@confect/alchemy/Code";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import {
  deploy,
  InvalidDeploymentTarget,
} from "../src/internal/CodeDeployment";
import {
  CommandError,
  CommandRunner,
  layer as runnerLayer,
} from "../src/internal/CommandRunner";
import { PushLock, layer as lockLayer } from "../src/internal/PushLock";
import { ConvexClient, ConvexFunctionError } from "../src/ConvexClient";
import { MountInitFailed } from "../src/internal/MountInit";
import * as String from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import { assertIs } from "./internal/assertIs";

const serialize = (value: unknown) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(
    Effect.orDie,
  );
const props: CodeProps = {
  deployment: {
    name: "happy-otter-123",
    url: "https://happy-otter-123.convex.cloud",
  },
  deployKey: Redacted.make("prod:happy-otter-123|test-secret"),
  prepare: { command: "confect", args: ["codegen"] },
};
const lifecycle = {
  id: "Code",
  fqn: "Code",
  instanceId: "test",
  bindings: [],
  session: {
    emit: () => Effect.void,
    done: () => Effect.void,
    note: () => Effect.void,
  },
};
const unlocked = Layer.mergeAll(
  Layer.succeed(PushLock, {
    withLock: (_deploymentName, effect) => effect,
  }),
  Layer.mock(ConvexClient, {}),
  NodeServices.layer,
);
const recorder = (calls: string[]) =>
  Layer.mergeAll(
    Layer.succeed(CommandRunner, {
      prepare: () =>
        Effect.sync(() => {
          calls.push("prepare");
        }),
      deploy: () =>
        Effect.sync(() => {
          calls.push("deploy");
        }),
    }),
    unlocked,
  );
const localProps: CodeProps = {
  deployment: { name: "confect-deployment-abc", url: "http://127.0.0.1:3300" },
  deployKey: Redacted.make("confect-deployment-abc|0123456789abcdef"),
};

describe("Code", () => {
  it.effect(
    "prepares before every deployment, including unchanged resource props",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        yield* Effect.gen(function* () {
          const services = yield* Layer.build(recorder(calls));
          return yield* Effect.gen(function* () {
            const provider = yield* codeProvider;
            const output = yield* provider
              .reconcile({
                ...lifecycle,
                news: props,
                olds: undefined,
                output: undefined,
              })
              .pipe(Effect.orDie);
            expect(output).toEqual(props.deployment);
            for (let run = 0; run < 2; run++) {
              const diff2 = yield* provider.diff();
              expect(diff2).toEqual({ action: "update" });
              yield* provider
                .reconcile({
                  ...lifecycle,
                  news: props,
                  olds: props,
                  output,
                })
                .pipe(Effect.orDie);
            }
            expect(provider).not.toHaveProperty("stables");
            yield* provider.delete();
            expect(calls).toEqual([
              "prepare",
              "deploy",
              "prepare",
              "deploy",
              "prepare",
              "deploy",
            ]);
          }).pipe(Effect.provideContext(services));
        }).pipe(Effect.scoped);
      }),
  );

  it.effect("does not deploy after preparation fails", () =>
    Effect.gen(function* () {
      let pushed = false;
      const result = yield* Effect.gen(function* () {
        const services2 = yield* Layer.build(unlocked);
        return yield* deploy(props).pipe(Effect.provideContext(services2));
      }).pipe(
        Effect.scoped,
        Effect.provideService(CommandRunner, {
          prepare: () =>
            Effect.fail(
              CommandError.make({
                operation: "prepare",
                reason: "exit",
                exitCode: 2,
              }),
            ),
          deploy: () =>
            Effect.sync(() => {
              pushed = true;
            }),
        }),
        Effect.result,
      );
      expect(Result.isFailure(result)).toBe(true);
      expect(pushed).toBe(false);
      const serializeResult = yield* serialize(result);
      expect(serializeResult).not.toContain("test-secret");
    }),
  );

  it.effect(
    "rejects mismatched and provisioning credentials before any commands",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        for (const key of [
          "prod:other-deployment|secret",
          "preview:team:project|secret",
          "project:example|secret",
          "secret",
          "prod:happy-otter-123|secret\nCONVEX_DEPLOYMENT=prod:other",
        ]) {
          const result = yield* Effect.gen(function* () {
            const services3 = yield* Layer.build(recorder(calls));
            return yield* deploy({
              ...props,
              deployKey: Redacted.make(key),
            }).pipe(Effect.provideContext(services3));
          }).pipe(Effect.scoped, Effect.result);
          expect(Result.isFailure(result)).toBe(true);
          const serializeResult = yield* serialize(result);
          expect(serializeResult).not.toContain(key);
        }
        expect(calls).toEqual([]);
      }),
  );

  it.effect(
    "rejects non-cloud or mismatched URLs and supports regional custom deployments",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        for (const url of [
          "http://localhost:3210",
          "https://other.convex.cloud",
          "https://happy-otter-123.convex.cloud.evil.test",
          "https://happy-otter-123.convex.cloud/path",
        ]) {
          const result = yield* Effect.gen(function* () {
            const services4 = yield* Layer.build(recorder(calls));
            return yield* deploy({
              ...props,
              deployment: { ...props.deployment, url },
            }).pipe(Effect.provideContext(services4));
          }).pipe(Effect.scoped, Effect.result);
          expect(Result.isFailure(result)).toBe(true);
        }
        expect(calls).toEqual([]);
        const regional = {
          name: props.deployment.name,
          url: "https://happy-otter-123.eu-west-1.convex.cloud",
        };
        const deployResult = yield* Effect.gen(function* () {
          const services5 = yield* Layer.build(recorder(calls));
          return yield* deploy({
            ...props,
            deployment: regional,
            deployKey: Redacted.make("custom:happy-otter-123|secret"),
          }).pipe(Effect.provideContext(services5));
        }).pipe(Effect.scoped);
        expect(deployResult).toEqual(regional);
      }),
  );

  it.effect("supports plain Convex projects without preparation", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      yield* Effect.gen(function* () {
        const services6 = yield* Layer.build(recorder(calls));
        return yield* deploy({
          deployment: props.deployment,
          deployKey: props.deployKey,
        }).pipe(Effect.provideContext(services6));
      }).pipe(Effect.scoped);
      expect(calls).toEqual(["deploy"]);
    }),
  );
});

const project = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectoryScoped({
    prefix: "confect-code-test-",
  });
  for (const [name, bin] of [
    ["convex", "convex"],
    ["@confect/cli", "confect"],
  ]) {
    const directory = path.join(cwd, "node_modules", name);
    yield* fs.makeDirectory(directory, { recursive: true });
    const manifest = yield* serialize({ name, bin: { [bin]: "cli.js" } });
    yield* fs.writeFileString(path.join(directory, "package.json"), manifest);
  }
  return cwd;
});

describe("Code command boundary", () => {
  it.effect(
    "preserves Windows process prerequisites across environment casing",
    () =>
      Effect.gen(function* () {
        const services7 = yield* Layer.build(NodeServices.layer);
        return yield* Effect.gen(function* () {
          const cwd = yield* project;
          for (const environment of [
            { PATH: "C:\\node", SYSTEMROOT: "C:\\Windows" },
            { Path: "C:\\node", SystemRoot: "C:\\Windows" },
          ]) {
            const calls: string[] = [];
            const spawner = Layer.mock(
              ChildProcessSpawner.ChildProcessSpawner,
              {
                exitCode: (command) =>
                  Effect.sync(() => {
                    expect(command._tag).toBe("StandardCommand");
                    if (command._tag !== "StandardCommand")
                      return ChildProcessSpawner.ExitCode(1);
                    calls.push(CommandArgs.plain(command.args)[1]);
                    expect(command.options.env?.PATH).toBe("C:\\node");
                    expect(command.options.env?.SystemRoot).toBe("C:\\Windows");
                    expect(command.options.extendEnv).toBe(false);
                    return ChildProcessSpawner.ExitCode(0);
                  }),
              },
            );
            yield* deploy({ ...props, cwd }).pipe(
              Effect.provide([
                runnerLayer.pipe(Layer.provide(spawner)),
                unlocked,
                ConfigProvider.layer(ConfigProvider.fromUnknown(environment)),
              ]),
            );
            expect(calls).toEqual(["codegen", "deploy"]);
          }
        }).pipe(Effect.provideContext(services7));
      }),
  );

  it.effect("discards real process output and sanitizes spawn failures", () =>
    Effect.gen(function* () {
      const services8 = yield* Layer.build(
        runnerLayer.pipe(Layer.provideMerge(NodeServices.layer)),
      );
      return yield* Effect.gen(function* () {
        const runner = yield* CommandRunner;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({
          prefix: "confect-spawn-test-",
        });
        const exited = yield* runner
          .prepare({
            command: process.execPath,
            args: [
              "-e",
              "process.stdout.write('test-secret'); process.stderr.write('test-secret'); process.exit(6)",
            ],
          })
          .pipe(Effect.result);
        expect(Result.isFailure(exited)).toBe(true);
        if (Result.isFailure(exited))
          expect(exited.failure).toEqual(
            CommandError.make({
              operation: "prepare",
              reason: "exit",
              exitCode: 6,
            }),
          );
        const serializeResult = yield* serialize(exited);
        expect(serializeResult).not.toContain("test-secret");
        const failed = yield* runner
          .prepare({ command: path.join(cwd, "confect-test-secret"), args: [] })
          .pipe(Effect.result);
        expect(Result.isFailure(failed)).toBe(true);
        if (Result.isFailure(failed))
          expect(failed.failure).toEqual(
            CommandError.make({ operation: "prepare", reason: "spawn" }),
          );
        const serializeResult2 = yield* serialize(failed);
        expect(serializeResult2).not.toContain("test-secret");
      }).pipe(Effect.provideContext(services8));
    }),
  );

  it.effect(
    "uses installed binaries, isolates configuration, and removes private credentials",
    () =>
      Effect.gen(function* () {
        const services9 = yield* Layer.build(NodeServices.layer);
        return yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* project;
          let envFile = "";
          const calls: string[] = [];
          const spawner = Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {
            exitCode: (command) =>
              Effect.gen(function* () {
                expect(command._tag).toBe("StandardCommand");
                if (command._tag !== "StandardCommand")
                  return ChildProcessSpawner.ExitCode(1);
                calls.push(CommandArgs.plain(command.args)[1]);
                expect(command.command).toBe(process.execPath);
                expect(command.options.cwd).toBe(cwd);
                expect(command.options.extendEnv).toBe(false);
                expect(command.options.stdin).toBe("ignore");
                expect(command.options.stdout).toBe("ignore");
                expect(command.options.stderr).toBe("ignore");
                const serializeResult = yield* serialize(command);
                expect(serializeResult).not.toContain("test-secret");
                expect(command.options.env).not.toHaveProperty(
                  "CONVEX_ACCESS_TOKEN",
                );
                expect(command.options.env).not.toHaveProperty(
                  "CONVEX_DEPLOYMENT",
                );
                expect(command.options.env).not.toHaveProperty("NODE_OPTIONS");
                if (CommandArgs.plain(command.args)[1] === "deploy") {
                  expect(CommandArgs.plain(command.args)[0]).toBe(
                    path.join(cwd, "node_modules", "convex", "cli.js"),
                  );
                  const index = CommandArgs.plain(command.args).indexOf(
                    "--env-file",
                  );
                  expect(index).toBeGreaterThan(0);
                  envFile = CommandArgs.plain(command.args)[index + 1];
                  expect(command.options.env?.HOME).toBe(path.dirname(envFile));
                  expect(command.options.env?.USERPROFILE).toBe(
                    command.options.env?.HOME,
                  );
                  const envFileContents = yield* fs.readFileString(envFile);
                  expect(envFileContents).toBe(
                    "CONVEX_DEPLOY_KEY=prod:happy-otter-123|test-secret\n",
                  );
                  if (process.platform !== "win32") {
                    expect((yield* fs.stat(envFile)).mode & 0o777).toBe(0o600);
                  }
                } else {
                  expect(CommandArgs.plain(command.args)[0]).toBe(
                    path.join(cwd, "node_modules", "@confect", "cli", "cli.js"),
                  );
                }
                return ChildProcessSpawner.ExitCode(0);
              }),
          });
          yield* deploy({ ...props, cwd }).pipe(
            Effect.provide([
              runnerLayer.pipe(Layer.provide(spawner)),
              unlocked,
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  CONVEX_ACCESS_TOKEN: "ambient-management-secret",
                  CONVEX_DEPLOYMENT: "prod:wrong",
                  NODE_OPTIONS: "--inspect",
                  PATH: path.dirname(process.execPath),
                }),
              ),
            ]),
          );
          expect(calls).toEqual(["codegen", "deploy"]);
          const envFileExists = yield* fs.exists(envFile);
          expect(envFileExists).toBe(false);
        }).pipe(Effect.provideContext(services9));
      }),
  );

  it.effect(
    "cleans credentials on command failure without exposing output",
    () =>
      Effect.gen(function* () {
        const services10 = yield* Layer.build(NodeServices.layer);
        return yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* project;
          let envFile = "";
          const spawner = Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {
            exitCode: (command) =>
              Effect.sync(() => {
                if (command._tag === "StandardCommand")
                  envFile = CommandArgs.plain(command.args)[
                    CommandArgs.plain(command.args).indexOf("--env-file") + 1
                  ];
                return ChildProcessSpawner.ExitCode(7);
              }),
          });
          const result = yield* deploy({
            deployment: props.deployment,
            deployKey: props.deployKey,
            cwd,
          }).pipe(
            Effect.provide([
              runnerLayer.pipe(Layer.provide(spawner)),
              unlocked,
            ]),
            Effect.result,
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result))
            expect(result.failure).toEqual(
              CommandError.make({
                operation: "deploy",
                reason: "exit",
                exitCode: 7,
              }),
            );
          const envFileExists = yield* fs.exists(envFile);
          expect(envFileExists).toBe(false);
          const serializeResult = yield* serialize(result);
          expect(serializeResult).not.toContain("test-secret");
        }).pipe(Effect.provideContext(services10));
      }),
  );

  it.effect("cleans credentials when deployment is interrupted", () =>
    Effect.gen(function* () {
      const services11 = yield* Layer.build(NodeServices.layer);
      return yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* project;
        const started = yield* Deferred.make<string>();
        const spawner = Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {
          exitCode: (command) =>
            Effect.gen(function* () {
              if (command._tag === "StandardCommand")
                yield* Deferred.succeed(
                  started,
                  CommandArgs.plain(command.args)[
                    CommandArgs.plain(command.args).indexOf("--env-file") + 1
                  ],
                );
              return yield* Effect.never;
            }),
        });
        const fiber = yield* deploy({
          deployment: props.deployment,
          deployKey: props.deployKey,
          cwd,
        }).pipe(
          Effect.provide([runnerLayer.pipe(Layer.provide(spawner)), unlocked]),
          Effect.forkScoped,
        );
        const envFile = yield* Deferred.await(started);
        const envFileExists = yield* fs.exists(envFile);
        expect(envFileExists).toBe(true);
        yield* Fiber.interrupt(fiber);
        const envFileExists2 = yield* fs.exists(envFile);
        expect(envFileExists2).toBe(false);
      }).pipe(Effect.provideContext(services11));
    }),
  );

  it.effect("fails locally when the project has no installed Convex CLI", () =>
    Effect.gen(function* () {
      const services12 = yield* Layer.build(NodeServices.layer);
      return yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({
          prefix: "confect-empty-test-",
        });
        const result = yield* deploy({
          deployment: props.deployment,
          deployKey: props.deployKey,
          cwd,
        }).pipe(
          Effect.provide([
            runnerLayer.pipe(
              Layer.provide(
                Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {
                  exitCode: (command) =>
                    Effect.sync(() => {
                      expect(command).toBeUndefined();
                      return ChildProcessSpawner.ExitCode(1);
                    }),
                }),
              ),
            ),
            unlocked,
          ]),
          Effect.result,
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(result.failure).toEqual(
            CommandError.make({ operation: "deploy", reason: "configuration" }),
          );
      }).pipe(Effect.provideContext(services12));
    }),
  );

  it.effect.each([
    { operation: "prepare", input: props },
    {
      operation: "deploy",
      input: { deployment: props.deployment, deployKey: props.deployKey },
    },
  ] as const)(
    "fails locally when the installed CLI's manifest names no $operation binary",
    ({ operation, input }) =>
      Effect.gen(function* () {
        const services13 = yield* Layer.build(NodeServices.layer);
        return yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* fs.makeTempDirectoryScoped({
            prefix: "confect-no-bin-test-",
          });
          for (const name of ["convex", "@confect/cli"]) {
            const directory = path.join(cwd, "node_modules", name);
            yield* fs.makeDirectory(directory, { recursive: true });
            const manifest = yield* serialize({ name, bin: {} });
            yield* fs.writeFileString(
              path.join(directory, "package.json"),
              manifest,
            );
          }
          const result = yield* deploy({ ...input, cwd }).pipe(
            Effect.provide([
              runnerLayer.pipe(
                Layer.provide(
                  Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {
                    exitCode: (command) =>
                      Effect.sync(() => {
                        expect(command).toBeUndefined();
                        return ChildProcessSpawner.ExitCode(1);
                      }),
                  }),
                ),
              ),
              unlocked,
            ]),
            Effect.result,
          );
          expect(result).toEqual(
            Result.fail(
              CommandError.make({ operation, reason: "configuration" }),
            ),
          );
        }).pipe(Effect.provideContext(services13));
      }),
  );
});

describe("Code push lock", () => {
  it.live(
    "serialises pushes to one deployment and lets two deployments push together",
    () =>
      Effect.gen(function* () {
        const services14 = yield* Layer.build(
          lockLayer().pipe(Layer.provideMerge(NodeServices.layer)),
        );
        return yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          // Push locks live in the user's cache; keep them out of the real one.
          const home = yield* fs.makeTempDirectoryScoped({
            prefix: "confect-push-order-",
          });
          const events: string[] = [];
          const runner = Layer.succeed(CommandRunner, {
            prepare: () => Effect.void,
            deploy: (target) =>
              Effect.gen(function* () {
                events.push(`start ${target.deploymentName}`);
                yield* Effect.sleep("150 millis");
                events.push(`end ${target.deploymentName}`);
              }),
          });
          const push = (codeProps: CodeProps) =>
            deploy(codeProps).pipe(
              Effect.provide([
                runner,
                Layer.mock(ConvexClient, {}),
                ConfigProvider.layer(
                  ConfigProvider.fromUnknown({
                    HOME: home,
                    LOCALAPPDATA: home,
                  }),
                ),
              ]),
            );
          yield* Effect.all([push(props), push(props)], {
            concurrency: "unbounded",
          });
          expect(events).toEqual([
            "start happy-otter-123",
            "end happy-otter-123",
            "start happy-otter-123",
            "end happy-otter-123",
          ]);
          events.length = 0;
          yield* Effect.all(
            [
              push(props),
              push({
                deployment: {
                  name: "brave-fox-456",
                  url: "https://brave-fox-456.convex.cloud",
                },
                deployKey: Redacted.make("prod:brave-fox-456|test-secret"),
              }),
            ],
            { concurrency: "unbounded" },
          );
          expect(Arr.sort(events.slice(0, 2), String.Order)).toEqual([
            "start brave-fox-456",
            "start happy-otter-123",
          ]);
        }).pipe(Effect.provideContext(services14));
      }),
  );
});

describe("Code local target", () => {
  it.effect(
    "pushes a local deployment through the self-hosted target without a deploy key",
    () =>
      Effect.gen(function* () {
        const services15 = yield* Layer.build(NodeServices.layer);
        return yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* project;
          let selection = "";
          const spawner = Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {
            exitCode: (command) =>
              Effect.gen(function* () {
                if (command._tag !== "StandardCommand")
                  return ChildProcessSpawner.ExitCode(1);
                selection = yield* fs.readFileString(
                  CommandArgs.plain(command.args)[
                    CommandArgs.plain(command.args).indexOf("--env-file") + 1
                  ],
                );
                return ChildProcessSpawner.ExitCode(0);
              }),
          });
          const deployResult = yield* deploy(
            { ...localProps, cwd },
            "local",
          ).pipe(
            Effect.provide([
              runnerLayer.pipe(Layer.provide(spawner)),
              unlocked,
            ]),
          );
          expect(deployResult).toEqual(localProps.deployment);
          expect(selection).toBe(
            "CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3300\nCONVEX_SELF_HOSTED_ADMIN_KEY=confect-deployment-abc|0123456789abcdef\n",
          );
        }).pipe(Effect.provideContext(services15));
      }),
  );

  it.effect(
    "rejects cloud, non-loopback, and foreign targets for a local deployment",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        for (const [codeProps, reason] of [
          [
            {
              ...localProps,
              deployment: {
                ...localProps.deployment,
                url: "https://confect-deployment-abc.convex.cloud",
              },
            },
            "deployment",
          ],
          [
            {
              ...localProps,
              deployment: {
                ...localProps.deployment,
                url: "http://localhost:3300",
              },
            },
            "deployment",
          ],
          [
            {
              ...localProps,
              deployment: {
                ...localProps.deployment,
                url: "http://127.0.0.1:3300/api",
              },
            },
            "deployment",
          ],
          [
            { ...localProps, deployKey: Redacted.make("other-backend|0123") },
            "deployKey",
          ],
          [
            {
              ...localProps,
              deployKey: Redacted.make(
                "confect-deployment-abc|0123\nCONVEX_DEPLOY_KEY=prod:x|y",
              ),
            },
            "deployKey",
          ],
        ] as const) {
          const result = yield* Effect.gen(function* () {
            const services16 = yield* Layer.build(recorder(calls));
            return yield* deploy(codeProps, "local").pipe(
              Effect.provideContext(services16),
            );
          }).pipe(Effect.scoped, Effect.result);
          expect(result).toEqual(
            Result.fail(InvalidDeploymentTarget.make({ reason })),
          );
        }
        expect(calls).toEqual([]);
      }),
  );
});

describe("Code mount init", () => {
  const init = (functionName: string) => ({ functionName, args: {} });
  const steps: Record<string, ReadonlyArray<unknown>> = {
    "": [
      { componentPath: "bulkEmail", nested: false, init: init("install:init") },
      { componentPath: "relay", nested: true, init: init("install:init") },
      { componentPath: "pool", nested: false, init: null },
      { componentPath: "last", nested: false, init: init("install:init") },
    ],
    relay: [
      { componentPath: "inbox", nested: false, init: init("setup:init") },
    ],
  };
  const push = (options: {
    readonly failAt?: string;
    readonly steps?: Record<string, ReadonlyArray<unknown>>;
  }) =>
    Effect.gen(function* () {
      const services17 = yield* Layer.build(NodeServices.layer);
      return yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({
          prefix: "confect-init-",
        });
        yield* fs.makeDirectory(path.join(cwd, "convex"));
        yield* fs.writeFileString(
          path.join(cwd, "convex", "confectDeploy.ts"),
          "// Generated by `confect codegen` from confect/app.ts. Do not edit.\n",
        );
        const events: string[] = [];
        const record = (event: string) =>
          Effect.sync(() => {
            events.push(event);
          });
        const lock = Layer.succeed(PushLock, {
          withLock: (_name, effect) =>
            record("acquire").pipe(
              Effect.andThen(effect),
              Effect.ensuring(record("release")),
            ),
        });
        const runner = Layer.succeed(CommandRunner, {
          prepare: () => record("prepare"),
          deploy: () => record("deploy"),
        });
        const client = Layer.mock(ConvexClient, {
          runFunction: (_url, _key, functionPath, _args, componentPath) =>
            Effect.gen(function* () {
              if (functionPath === "confectDeploy:steps") {
                yield* record(
                  pipe(`steps ${componentPath ?? ""}`, String.trim),
                );
                return (options.steps ?? steps)[componentPath ?? ""];
              }
              yield* record(`init ${componentPath}`);
              if (componentPath === options.failAt)
                return yield* ConvexFunctionError.make({
                  functionPath,
                  errorMessage: "Uncaught Error: SyntheticInitFailure",
                });
              return null;
            }),
        });
        const result = yield* deploy({ ...props, cwd }).pipe(
          Effect.provide([lock, runner, client]),
          Effect.result,
        );
        return { events, result };
      }).pipe(Effect.scoped, Effect.provideContext(services17));
    }).pipe(Effect.scoped);

  it.effect(
    "runs each mount's init after the push, in order, inside one lock hold",
    () =>
      Effect.gen(function* () {
        const { events, result } = yield* push({});
        expect(Result.isSuccess(result)).toBe(true);
        expect(events).toEqual([
          "acquire",
          "prepare",
          "deploy",
          "steps",
          "init bulkEmail",
          "init relay",
          "steps relay",
          "init relay/inbox",
          "init last",
          "release",
        ]);
      }),
  );

  it.effect("stops the push at a failing mount, after earlier mounts", () =>
    Effect.gen(function* () {
      const { events, result } = yield* push({ failAt: "relay" });
      expect(events).toEqual([
        "acquire",
        "prepare",
        "deploy",
        "steps",
        "init bulkEmail",
        "init relay",
        "release",
      ]);
      assertIs(result, Result.isFailure);
      expect(result.failure).toBeInstanceOf(MountInitFailed);
      expect(result.failure.message).toBe(
        "relay: init failed; earlier mounts are applied, and the next push retries",
      );
    }),
  );

  it.effect("refuses a mount whose callback handles cannot be made", () =>
    Effect.gen(function* () {
      const { events, result } = yield* push({
        steps: {
          "": [
            {
              componentPath: "bulkEmail",
              failure: "Function handle not found",
            },
          ],
        },
      });
      expect(events).toEqual([
        "acquire",
        "prepare",
        "deploy",
        "steps",
        "release",
      ]);
      assertIs(result, Result.isFailure);
      expect(result.failure).toMatchObject({
        _tag: "MountInitFailed",
        mount: "bulkEmail",
        detail: "Function handle not found",
      });
    }),
  );
});
