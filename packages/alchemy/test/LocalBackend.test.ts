import * as NodeServices from "./fixtures/NodeTestServices";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { createServer, type Server } from "node:net";
import {
  backendVersion,
  boot,
  LocalBackendError,
} from "../src/internal/LocalBackend";
import { fakeBackend } from "./fixtures/LocalBackend";
import * as Str from "effect/String";
import { pipe } from "effect/Function";

const serialize = (value: unknown) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(
    Effect.orDie,
  );
const name = "confect-deployment-0123456789abcdef01234567";

const occupy = (port: number) =>
  Effect.acquireRelease(
    Effect.callback<Server>((resume) => {
      const server = createServer();
      server.listen(port, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );

const harness = (
  fake: ReturnType<typeof fakeBackend>,
  options?: { readonly ports?: string | undefined },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "confect-local-backend-",
    });
    const home = path.join(root, "home");
    const directory = path.join(root, "data", name);
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provide([
          fake.layer,
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              HOME: home,
              LOCALAPPDATA: home,
              ...(options !== undefined && "ports" in options
                ? options.ports === undefined
                  ? {}
                  : { CONFECT_LOCAL_BACKEND_PORTS: options.ports }
                : { CONFECT_LOCAL_BACKEND_PORTS: "3350-3359" }),
            }),
          ),
        ]),
      );
    return { directory, run };
  });

const port = (url: string) => Number(new URL(url).port);

describe("LocalBackend", () => {
  it.live(
    "installs the pinned release, creates an identity, and reports URLs once the backend answers its name",
    () =>
      Effect.gen(function* () {
        const services = yield* Layer.build(NodeServices.layer);
        return yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const fake = fakeBackend();
          const { directory, run } = yield* harness(fake);
          const backend = yield* run(boot(name, directory));
          expect(backend.url).toMatch(/^http:\/\/127\.0\.0\.1:335\d$/);
          expect(backend.siteUrl).toMatch(/^http:\/\/127\.0\.0\.1:335\d$/);
          expect(backend.siteUrl).not.toBe(backend.url);
          expect(Redacted.value(backend.adminKey)).toBe(`${name}|0a1b2c1`);
          expect(fake.downloads).toHaveLength(1);
          expect(fake.downloads[0]).toMatch(
            /^https:\/\/github\.com\/get-convex\/convex-backend\/releases\/download\/precompiled-2026-10-28-cccbade\/convex-local-backend-[a-z0-9_-]+\.zip$/,
          );
          const [served] = fake.served;
          expect(served?.args).toEqual([
            "--interface",
            "127.0.0.1",
            "--port",
            String(port(backend.url)),
            "--site-proxy-port",
            String(port(backend.siteUrl)),
            "--instance-name",
            name,
            "--instance-secret",
            expect.stringMatching(/^[0-9a-f]{64}$/),
            "--convex-origin",
            backend.url,
            "--convex-site",
            backend.siteUrl,
            "--local-storage",
            path.join(directory, "convex_local_storage"),
            "--disable-beacon",
            path.join(directory, "convex_local_backend.sqlite3"),
          ]);
          const serializeResult = yield* serialize(backend);
          expect(serializeResult).not.toContain("0a1b2c1");
          if (process.platform !== "win32")
            expect(
              (yield* fs.stat(path.join(directory, "identity.json"))).mode &
                0o777,
            ).toBe(0o600);
        }).pipe(Effect.scoped, Effect.provideContext(services));
      }),
  );

  it.live(
    "restarts on its saved identity and ports without new credentials or downloads",
    () =>
      Effect.gen(function* () {
        const services2 = yield* Layer.build(NodeServices.layer);
        return yield* Effect.gen(function* () {
          const fake = fakeBackend();
          const { directory, run } = yield* harness(fake);
          const first = yield* run(boot(name, directory)).pipe(Effect.scoped);
          expect(fake.served[0]?.running()).toBe(false);
          const second = yield* run(boot(name, directory));
          expect(second.url).toBe(first.url);
          expect(second.siteUrl).toBe(first.siteUrl);
          expect(Redacted.value(second.adminKey)).toBe(
            Redacted.value(first.adminKey),
          );
          expect(fake.served[1]?.args[9]).toBe(fake.served[0]?.args[9]);
          expect(fake.downloads).toHaveLength(1);
        }).pipe(Effect.scoped, Effect.provideContext(services2));
      }),
  );

  it.live("saves both ports together once the backend has started", () =>
    Effect.gen(function* () {
      const services3 = yield* Layer.build(NodeServices.layer);
      return yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fake = fakeBackend();
        const { directory, run } = yield* harness(fake);
        const identity = path.join(directory, "identity.json");
        yield* fs.makeDirectory(directory, { recursive: true });
        const serializeResult = yield* serialize({
          name,
          version: backendVersion,
          instanceSecret: "00ff",
          adminKey: `${name}|0a1b2c`,
          port: 3355,
        });
        yield* fs.writeFileString(identity, serializeResult);
        const backend = yield* run(boot(name, directory));
        const identityContents = yield* fs.readFileString(identity);
        const saved = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({ ports: Schema.optionalKey(Schema.Unknown) }),
          ),
        )(identityContents);
        expect(saved.ports).toEqual({
          port: port(backend.url),
          sitePort: port(backend.siteUrl),
        });
      }).pipe(Effect.scoped, Effect.provideContext(services3));
    }),
  );

  it.live("keeps running the release that created its data directory", () =>
    Effect.gen(function* () {
      const services4 = yield* Layer.build(NodeServices.layer);
      return yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fake = fakeBackend();
        const { directory, run } = yield* harness(fake);
        const first = yield* run(boot(name, directory)).pipe(Effect.scoped);
        const identity = path.join(directory, "identity.json");
        const identityContents = yield* fs.readFileString(identity);
        yield* fs.writeFileString(
          identity,
          pipe(
            identityContents,
            Str.replace(backendVersion, "precompiled-2020-01-01-0000000"),
          ),
        );
        const restarted = yield* run(boot(name, directory));
        expect(restarted.url).toBe(first.url);
        expect(fake.downloads.at(-1)).toMatch(
          /\/download\/precompiled-2020-01-01-0000000\/convex-local-backend-/,
        );
      }).pipe(Effect.scoped, Effect.provideContext(services4));
    }),
  );

  it.live("fails typed when the backend exits before it answers", () =>
    Effect.gen(function* () {
      const services5 = yield* Layer.build(NodeServices.layer);
      return yield* Effect.gen(function* () {
        const { directory, run } = yield* harness(fakeBackend({ exitCode: 3 }));
        const runResult = yield* run(boot(name, directory)).pipe(
          Effect.scoped,
          Effect.result,
        );
        expect(runResult).toEqual(
          Result.fail(
            LocalBackendError.make({
              deploymentName: name,
              reason: "exit",
              exitCode: 3,
            }),
          ),
        );
      }).pipe(Effect.scoped, Effect.provideContext(services5));
    }),
  );

  it.live(
    "keeps its saved ports, failing typed when another program or an orphaned backend holds one",
    () =>
      Effect.gen(function* () {
        const services6 = yield* Layer.build(NodeServices.layer);
        return yield* Effect.gen(function* () {
          const fake = fakeBackend();
          const { directory, run } = yield* harness(fake);
          const first = yield* run(boot(name, directory)).pipe(Effect.scoped);
          const scope = yield* Scope.make();
          yield* occupy(port(first.url)).pipe(Scope.provide(scope));
          fake.answers.set(first.url, "someone-else");
          const runResult = yield* run(boot(name, directory)).pipe(
            Effect.scoped,
            Effect.result,
          );
          expect(runResult).toEqual(
            Result.fail(
              LocalBackendError.make({ deploymentName: name, reason: "ports" }),
            ),
          );
          fake.answers.set(first.url, name);
          const runResult2 = yield* run(boot(name, directory)).pipe(
            Effect.scoped,
            Effect.result,
          );
          expect(runResult2).toEqual(
            Result.fail(
              LocalBackendError.make({
                deploymentName: name,
                reason: "running",
              }),
            ),
          );
          yield* Scope.close(scope, Exit.void);
          fake.answers.delete(first.url);
          const restarted = yield* run(boot(name, directory)).pipe(
            Effect.scoped,
          );
          expect(restarted.url).toBe(first.url);
        }).pipe(Effect.scoped, Effect.provideContext(services6));
      }),
  );

  it.live("refuses a second backend over data another one is serving", () =>
    Effect.gen(function* () {
      const services7 = yield* Layer.build(NodeServices.layer);
      return yield* Effect.gen(function* () {
        const fake = fakeBackend();
        const { directory, run } = yield* harness(fake);
        yield* run(boot(name, directory));
        const runResult = yield* run(boot(name, directory)).pipe(
          Effect.scoped,
          Effect.result,
        );
        expect(runResult).toEqual(
          Result.fail(
            LocalBackendError.make({ deploymentName: name, reason: "running" }),
          ),
        );
        expect(fake.served).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provideContext(services7));
    }),
  );

  it.live("picks two free loopback ports when no range is configured", () =>
    Effect.gen(function* () {
      const services8 = yield* Layer.build(NodeServices.layer);
      return yield* Effect.gen(function* () {
        const fake = fakeBackend();
        const { directory, run } = yield* harness(fake, { ports: undefined });
        const backend = yield* run(boot(name, directory));
        expect(backend.url).toMatch(/^http:\/\/127\.0\.0\.1:[0-9]+$/);
        expect(backend.siteUrl).toMatch(/^http:\/\/127\.0\.0\.1:[0-9]+$/);
        expect(backend.siteUrl).not.toBe(backend.url);
      }).pipe(Effect.scoped, Effect.provideContext(services8));
    }),
  );

  it.live(
    "starts again in the same session after a failed start, on fresh ports",
    () =>
      Effect.gen(function* () {
        const services9 = yield* Layer.build(NodeServices.layer);
        return yield* Effect.gen(function* () {
          const fake = fakeBackend({ exitCode: 3 });
          const { directory, run } = yield* harness(fake);
          // Alchemy keeps the instance scope of a failed start open.
          const session = yield* Scope.make();
          const runResult = yield* run(boot(name, directory)).pipe(
            Scope.provide(session),
            Effect.result,
          );
          expect(runResult).toEqual(
            Result.fail(
              LocalBackendError.make({
                deploymentName: name,
                reason: "exit",
                exitCode: 3,
              }),
            ),
          );
          const tried = fake.attempts[0];
          const triedPort = Number(tried[tried.indexOf("--port") + 1]);
          yield* occupy(triedPort);
          fake.behaviour.exitCode = undefined;
          const backend = yield* run(boot(name, directory)).pipe(
            Scope.provide(session),
          );
          expect(port(backend.url)).not.toBe(triedPort);
          yield* Scope.close(session, Exit.void);
        }).pipe(Effect.scoped, Effect.provideContext(services9));
      }),
  );

  it.live("starts again in the same session after its backend exits", () =>
    Effect.gen(function* () {
      const services10 = yield* Layer.build(NodeServices.layer);
      return yield* Effect.gen(function* () {
        const fake = fakeBackend();
        const { directory, run } = yield* harness(fake);
        const session = yield* Scope.make();
        const first = yield* run(boot(name, directory)).pipe(
          Scope.provide(session),
        );
        yield* fake.served[0].exit(1);
        yield* first.exited.pipe(Effect.timeout("1 second"));
        const restarted = yield* run(boot(name, directory)).pipe(
          Scope.provide(session),
        );
        expect(restarted.url).toBe(first.url);
        expect(fake.served).toHaveLength(2);
        yield* Scope.close(session, Exit.void);
      }).pipe(Effect.scoped, Effect.provideContext(services10));
    }),
  );

  it.live("reports exited once a closed session has stopped its backend", () =>
    Effect.gen(function* () {
      const services11 = yield* Layer.build(NodeServices.layer);
      return yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fake = fakeBackend();
        const { directory, run } = yield* harness(fake);
        const session = yield* Scope.make();
        const backend = yield* run(boot(name, directory)).pipe(
          Scope.provide(session),
        );
        yield* Scope.close(session, Exit.void);
        yield* backend.exited.pipe(Effect.timeout("1 second"));
        expect(fake.served[0].running()).toBe(false);
        const found = yield* fs.exists(path.join(directory, "owner.lock"));
        expect(found).toBe(false);
      }).pipe(Effect.scoped, Effect.provideContext(services11));
    }),
  );

  it.live(
    "stops the backend and releases its data when interrupted before it is ready",
    () =>
      Effect.gen(function* () {
        const services12 = yield* Layer.build(NodeServices.layer);
        return yield* Effect.gen(function* () {
          const fake = fakeBackend({ silent: true });
          const { directory, run } = yield* harness(fake);
          const session = yield* Scope.make();
          const starting = yield* run(boot(name, directory)).pipe(
            Scope.provide(session),
            Effect.forkChild,
          );
          yield* Deferred.await(fake.spawned);
          yield* Fiber.interrupt(starting);
          expect(fake.served[0].running()).toBe(false);
          fake.behaviour.silent = false;
          yield* run(boot(name, directory)).pipe(Scope.provide(session));
          expect(fake.served).toHaveLength(2);
          yield* Scope.close(session, Exit.void);
        }).pipe(Effect.scoped, Effect.provideContext(services12));
      }),
  );

  it.live(
    "finishes saving its identity before an interruption releases the data directory",
    () =>
      Effect.gen(function* () {
        const services13 = yield* Layer.build(NodeServices.layer);
        return yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const fake = fakeBackend();
          const { directory, run } = yield* harness(fake);
          const identity = path.join(directory, "identity.json");
          const entered = yield* Deferred.make<void>();
          const gate = Promise.withResolvers<void>();
          const context2 = yield* Effect.context<never>();
          const runDetached = Effect.runPromiseWith(context2);
          // Node cannot cancel a rename it has started: interrupting the effect
          // abandons the callback while the rename still happens.
          const slowRename = Layer.effect(
            FileSystem.FileSystem,
            Effect.map(FileSystem.FileSystem, (base) => ({
              ...base,
              rename: (from: string, to: string) =>
                to === identity
                  ? Deferred.succeed(entered, undefined).pipe(
                      Effect.andThen(
                        Effect.callback<void>((resume) => {
                          void gate.promise
                            .then(() => runDetached(base.rename(from, to)))
                            .then(() => resume(Effect.void));
                        }),
                      ),
                    )
                  : base.rename(from, to),
            })),
          ).pipe(Layer.provide(NodeServices.layer));
          const session = yield* Scope.make();
          const starting = yield* Effect.gen(function* () {
            const services14 = yield* Layer.build(slowRename);
            return yield* run(boot(name, directory)).pipe(
              Scope.provide(session),
              Effect.provideContext(services14),
            );
          }).pipe(Effect.scoped, Effect.forkChild);
          yield* Deferred.await(entered);
          const interrupting = yield* Fiber.interrupt(starting).pipe(
            Effect.forkChild,
          );
          yield* Effect.sleep("50 millis");
          const found = yield* fs.exists(path.join(directory, "owner.lock"));
          expect(found).toBe(true);
          gate.resolve();
          yield* Fiber.join(interrupting);
          const found2 = yield* fs.exists(path.join(directory, "owner.lock"));
          expect(found2).toBe(false);
          const identityExists = yield* fs.exists(identity);
          expect(identityExists).toBe(true);
          yield* Scope.close(session, Exit.void);
        }).pipe(Effect.scoped, Effect.provideContext(services13));
      }),
  );

  it("says why a backend could not start", () => {
    expect(
      LocalBackendError.make({ deploymentName: name, reason: "running" })
        .message,
    ).toBe(
      `Local backend for ${name} is already running: stop the other alchemy dev session, or the backend process left over from one, that serves its data directory`,
    );
    expect(
      LocalBackendError.make({
        deploymentName: name,
        reason: "exit",
        exitCode: 3,
      }).message,
    ).toBe(`Local backend for ${name} exited with code 3 before it was ready`);
  });

  it.live("stops a backend that never answers with its own name", () =>
    Effect.gen(function* () {
      const services15 = yield* Layer.build(NodeServices.layer);
      return yield* Effect.gen(function* () {
        const fake = fakeBackend({ answerAs: "someone-else" });
        const { directory, run } = yield* harness(fake);
        const runResult = yield* run(boot(name, directory)).pipe(Effect.result);
        expect(runResult).toEqual(
          Result.fail(
            LocalBackendError.make({ deploymentName: name, reason: "ports" }),
          ),
        );
        expect(fake.served[0]?.running()).toBe(false);
      }).pipe(Effect.scoped, Effect.provideContext(services15));
    }),
  );

  it.live.each(["65536-65537", "3399-3300", "0-10", "3300"])(
    "rejects the port range %s with a configuration error",
    (range) =>
      Effect.gen(function* () {
        const services16 = yield* Layer.build(NodeServices.layer);
        return yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({
            prefix: "confect-local-backend-",
          });
          const bootResult = yield* boot(name, path.join(home, name)).pipe(
            Effect.provide([
              fakeBackend().layer,
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  HOME: home,
                  LOCALAPPDATA: home,
                  CONFECT_LOCAL_BACKEND_PORTS: range,
                }),
              ),
            ]),
            Effect.scoped,
            Effect.result,
          );
          expect(bootResult).toEqual(
            Result.fail(
              LocalBackendError.make({
                deploymentName: name,
                reason: "configuration",
              }),
            ),
          );
        }).pipe(Effect.scoped, Effect.provideContext(services16));
      }),
  );

  it.live("fails typed instead of installing without a home directory", () =>
    Effect.gen(function* () {
      const services17 = yield* Layer.build(NodeServices.layer);
      return yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "confect-local-backend-",
        });
        const bootResult = yield* boot(name, path.join(root, name)).pipe(
          Effect.provide([
            fakeBackend().layer,
            ConfigProvider.layer(ConfigProvider.fromUnknown({})),
          ]),
          Effect.scoped,
          Effect.result,
        );
        expect(bootResult).toEqual(
          Result.fail(
            LocalBackendError.make({
              deploymentName: name,
              reason: "configuration",
            }),
          ),
        );
      }).pipe(Effect.scoped, Effect.provideContext(services17));
    }),
  );
});
