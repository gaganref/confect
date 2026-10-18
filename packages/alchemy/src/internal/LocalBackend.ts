import { createServer, type Server } from "node:net";
import { dotAlchemyDirectory } from "alchemy/AlchemyContext";
import { Stack } from "alchemy/Stack";
import * as Config from "effect/Config";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { processEnvironment } from "./CommandRunner";
import * as FileLock from "./FileLock";
import * as Loopback from "./Loopback";
import { userCache } from "./UserCache";
import { extract } from "./Zip";

/**
 * The backend release a new local deployment runs. An existing data directory
 * keeps running the release that created it, so upgrading this package never
 * opens a database with a different release.
 */
export const backendVersion = "precompiled-2026-10-06-a3538c6";

export class LocalBackendError extends Schema.TaggedError<LocalBackendError>()(
  "LocalBackendError",
  {
    deploymentName: Schema.String,
    reason: Schema.Literals([
      "configuration",
      "filesystem",
      "install",
      "identity",
      "ports",
      "running",
      "spawn",
      "exit",
      "timeout",
    ]),
    exitCode: Schema.optionalKey(Schema.Finite),
  },
) {
  override get message() {
    const subject = `Local backend for ${this.deploymentName}`;
    switch (this.reason) {
      case "configuration":
        return `${subject} needs a home directory and, when set, CONFECT_LOCAL_BACKEND_PORTS as a range such as 3300-3399`;
      case "filesystem":
        return `${subject} could not read or write its data directory`;
      case "install":
        return `${subject} could not download or install the backend binary`;
      case "identity":
        return `${subject} could not read, create, or save its identity`;
      case "ports":
        return `${subject} could not get its ports; another process is using them`;
      case "running":
        return `${subject} is already running: stop the other alchemy dev session, or the backend process left over from one, that serves its data directory`;
      case "spawn":
        return `${subject} could not be started`;
      case "exit":
        return `${subject} exited${this.exitCode === undefined ? "" : ` with code ${this.exitCode}`} before it was ready`;
      case "timeout":
        return `${subject} did not become ready in time`;
    }
  }
}

export interface LocalBackend {
  readonly url: string;
  readonly siteUrl: string;
  readonly adminKey: Redacted.Redacted<string>;
  /**
   * Completes when the backend process has exited and released its data
   * directory, so the deployment can be booted again.
   */
  readonly exited: Effect.Effect<void>;
}

// Ports are saved once a backend has answered on them, so a first start that
// fails picks fresh ports next time instead of keeping ones that never worked.
const Identity = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    version: Schema.String,
    instanceSecret: Schema.String,
    adminKey: Schema.String,
    ports: Schema.optionalKey(
      Schema.Struct({ port: Schema.Int, sitePort: Schema.Int }),
    ),
  }),
);
type Identity = typeof Identity.Type;

// The release archive per platform, as the Convex CLI maps it
// (convex-js src/cli/lib/localDeployment/download.ts getDownloadPath).
const artifacts: Readonly<Record<string, string>> = {
  "darwin-arm64": "convex-local-backend-aarch64-apple-darwin.zip",
  "darwin-x64": "convex-local-backend-x86_64-apple-darwin.zip",
  "linux-arm64": "convex-local-backend-aarch64-unknown-linux-gnu.zip",
  "linux-x64": "convex-local-backend-x86_64-unknown-linux-gnu.zip",
  "win32-arm64": "convex-local-backend-x86_64-pc-windows-msvc.zip",
  "win32-x64": "convex-local-backend-x86_64-pc-windows-msvc.zip",
};
const executable =
  process.platform === "win32"
    ? "convex-local-backend.exe"
    : "convex-local-backend";

const close = (server: Server) =>
  Effect.callback<void>((resume) => {
    server.close(() => resume(Effect.void));
  });

// A server listening on `port`, or undefined when the port is taken, closed
// with the scope. Listening is uninterruptible, so an interrupted probe never
// leaves a server bound to the port.
const listen = (port: number) =>
  Effect.acquireRelease(
    Effect.callback<Server | undefined>((resume) => {
      const server = createServer();
      server.once("error", () => resume(Effect.undefined));
      server.listen(port, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) => (server ? close(server) : Effect.void),
  );

const isFree = (port: number) =>
  listen(port).pipe(
    Effect.map((server) => server !== undefined),
    Effect.scoped,
  );

const portOf = (server: Server | undefined) => {
  const address = server?.address();
  return typeof address === "object" && address !== null
    ? address.port
    : undefined;
};

// Backends in one process start one at a time, so two deployments starting
// together never probe and claim the same ports.
const startup = Semaphore.makeUnsafe(1);

/**
 * Resolves the directory that holds one local deployment's identity, database,
 * and file storage: `.alchemy/convex/<stack>/<stage>/<deployment>`. Keyed by
 * the deployment name because a deploy key resource only knows that name.
 */
export const dataDirectories = Effect.gen(function* () {
  const path = yield* Path.Path;
  const stack = yield* Stack;
  const root = path.resolve(
    yield* dotAlchemyDirectory,
    "convex",
    stack.name,
    stack.stage,
  );
  return (deploymentName: string) => path.join(root, deploymentName);
});

const readIdentity = Effect.fn("LocalBackend.readIdentity")(function* (
  deploymentName: string,
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(directory, "identity.json");
  const invalid = () =>
    new LocalBackendError({ deploymentName, reason: "identity" });
  if (!(yield* fs.exists(file).pipe(Effect.mapError(invalid))))
    return Option.none<Identity>();
  const identity = yield* fs
    .readFileString(file)
    .pipe(
      Effect.flatMap(Schema.decodeEffect(Identity)),
      Effect.mapError(invalid),
    );
  if (identity.name !== deploymentName) return yield* invalid();
  return Option.some(identity);
});

/**
 * The admin key of a local deployment, for its deploy key resource.
 */
export const adminKey = Effect.fn("LocalBackend.adminKey")(function* (
  deploymentName: string,
  directory: string,
) {
  const identity = yield* readIdentity(deploymentName, directory);
  if (Option.isNone(identity))
    return yield* new LocalBackendError({ deploymentName, reason: "identity" });
  return Redacted.make(identity.value.adminKey);
});

export const remove = Effect.fn("LocalBackend.remove")(function* (
  deploymentName: string,
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs
    .remove(directory, { recursive: true, force: true })
    .pipe(
      Effect.mapError(
        () => new LocalBackendError({ deploymentName, reason: "filesystem" }),
      ),
    );
});

/**
 * Install a backend release into the Convex CLI's binary cache,
 * `<cache>/convex/binaries/<version>/`, unless it is already there.
 */
const install = Effect.fn("LocalBackend.install")(function* (
  deploymentName: string,
  version: string,
  cache: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const failed = () =>
    new LocalBackendError({ deploymentName, reason: "install" });
  const binaries = path.join(cache, "convex", "binaries");
  const binary = path.join(binaries, version, executable);
  const artifact = artifacts[`${process.platform}-${process.arch}`];
  return yield* Effect.gen(function* () {
    if (yield* fs.exists(binary)) return binary;
    if (artifact === undefined) return yield* failed();
    yield* fs.makeDirectory(binaries, { recursive: true });
    const temp = yield* fs.makeTempDirectoryScoped({
      directory: binaries,
      prefix: ".download-",
    });
    const archive = path.join(temp, artifact);
    const response = yield* http.get(
      `https://github.com/get-convex/convex-backend/releases/download/${version}/${artifact}`,
    );
    if (response.status !== 200) return yield* failed();
    yield* response.stream.pipe(Stream.run(fs.sink(archive)));
    const extracted = path.join(temp, executable);
    yield* extract(archive, executable, extracted);
    yield* fs.chmod(extracted, 0o755);
    yield* fs.makeDirectory(path.dirname(binary), { recursive: true });
    yield* fs.rename(extracted, binary);
    return binary;
  }).pipe(Effect.scoped, Effect.mapError(failed));
});

/**
 * Boot the local backend for one deployment and keep it running for the ambient
 * scope. The process and the data directory's `owner.lock` share a child scope
 * that closes when the boot fails or is interrupted and when the process exits,
 * so a deployment can be booted again in the same session. The first boot
 * installs the pinned release, generates an instance secret and admin key, and
 * picks two free loopback ports; later boots reuse all of them, so stored
 * credentials and URLs stay valid. A saved port that something else now holds
 * is an error rather than a move, because resources keep the URL.
 */
export const boot = Effect.fn("LocalBackend.boot")(function* (
  deploymentName: string,
  directory: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const http = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const fail = (reason: LocalBackendError["reason"], exitCode?: number) =>
    new LocalBackendError({
      deploymentName,
      reason,
      ...(exitCode === undefined ? {} : { exitCode }),
    });
  const settings = yield* Config.all({
    environment: processEnvironment,
    ports: Config.String("CONFECT_LOCAL_BACKEND_PORTS").pipe(Config.option),
  }).pipe(Effect.mapError(() => fail("configuration")));
  const cache = yield* userCache.pipe(
    Effect.mapError(() => fail("configuration")),
  );
  if (Option.isNone(cache)) return yield* fail("configuration");
  const range = Option.map(settings.ports, Loopback.parsePortRange);
  if (Option.isSome(range) && Option.isNone(range.value))
    return yield* fail("configuration");
  const env = {
    ...settings.environment,
    DISABLE_BEACON: "1",
    DO_NOT_TRACK: "1",
  };

  const answer = (url: string) =>
    http.get(`${url}/instance_name`).pipe(
      Effect.flatMap((response) =>
        response.status === 200 ? response.text : Effect.undefined,
      ),
      Effect.orElseSucceed(() => undefined),
    );

  const allocate = Effect.gen(function* () {
    if (Option.isNone(range) || Option.isNone(range.value)) {
      // A closed server no longer has an address.
      const [port, sitePort] = yield* Effect.all([listen(0), listen(0)]).pipe(
        Effect.map((servers) => servers.map(portOf)),
        Effect.scoped,
      );
      if (port === undefined || sitePort === undefined)
        return yield* fail("ports");
      return { port, sitePort };
    }
    const free: number[] = [];
    const { from, to } = range.value.value;
    for (let port = from; port <= to && free.length < 2; port++) {
      if (yield* isFree(port)) free.push(port);
    }
    const [port, sitePort] = free;
    if (port === undefined || sitePort === undefined)
      return yield* fail("ports");
    return { port, sitePort };
  });

  const generate = (binary: string) =>
    Effect.gen(function* () {
      const instanceSecret = Buffer.from(
        yield* crypto.randomBytes(32),
      ).toString("hex");
      const output = yield* spawner.string(
        ChildProcess.make(
          binary,
          [
            "keygen",
            "admin-key",
            "--instance-name",
            deploymentName,
            "--instance-secret",
            instanceSecret,
          ],
          { env, extendEnv: false, stdin: "ignore", stderr: "ignore" },
        ),
      );
      const key = output.trim();
      if (!key.startsWith(`${deploymentName}|`)) return yield* fail("identity");
      return { instanceSecret, adminKey: key };
    }).pipe(
      Effect.catchTag("PlatformError", () => Effect.fail(fail("identity"))),
    );

  const save = (identity: Identity) =>
    Effect.gen(function* () {
      const file = path.join(directory, "identity.json");
      const temp = `${file}.${process.pid}.tmp`;
      yield* fs.writeFileString(
        temp,
        yield* Schema.encodeEffect(Identity)(identity),
        { mode: 0o600 },
      );
      yield* fs.rename(temp, file);
    }).pipe(
      // Node cannot cancel a write or rename it has started; finishing it
      // keeps a pending rename from landing after owner.lock is released.
      Effect.uninterruptible,
      Effect.mapError(() => fail("identity")),
    );

  const session = yield* Scope.Scope;
  const owned = yield* Scope.fork(session);
  const stopped = yield* Deferred.make<void>();
  // Registered first, so it runs after the process and owner.lock finalizers
  // however the scope closes.
  yield* Scope.addFinalizer(owned, Deferred.succeed(stopped, undefined));
  const start = Effect.gen(function* () {
    yield* FileLock.acquire(path.join(directory, "owner.lock")).pipe(
      Effect.mapError((error) =>
        fail(error.reason === "held" ? "running" : "filesystem"),
      ),
    );
    const saved = yield* readIdentity(deploymentName, directory);
    const version = Option.isSome(saved) ? saved.value.version : backendVersion;
    const binary = yield* install(deploymentName, version, cache.value);
    let identity: Identity;
    if (Option.isSome(saved)) {
      identity = saved.value;
    } else {
      identity = {
        name: deploymentName,
        version,
        ...(yield* generate(binary)),
      };
      yield* save(identity);
    }
    const ports = identity.ports ?? (yield* allocate);
    if (identity.ports !== undefined) {
      if (!(yield* isFree(ports.port)) || !(yield* isFree(ports.sitePort)))
        return yield* fail(
          (yield* answer(Loopback.origin(ports.port))) === deploymentName
            ? "running"
            : "ports",
        );
    }

    const url = Loopback.origin(ports.port);
    const siteUrl = Loopback.origin(ports.sitePort);
    const handle = yield* spawner
      .spawn(
        ChildProcess.make(
          binary,
          [
            "--interface",
            "127.0.0.1",
            "--port",
            String(ports.port),
            "--site-proxy-port",
            String(ports.sitePort),
            "--instance-name",
            deploymentName,
            "--instance-secret",
            identity.instanceSecret,
            "--convex-origin",
            url,
            "--convex-site",
            siteUrl,
            "--local-storage",
            path.join(directory, "convex_local_storage"),
            "--disable-beacon",
            path.join(directory, "convex_local_backend.sqlite3"),
          ],
          {
            cwd: directory,
            env,
            extendEnv: false,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            forceKillAfter: "3 seconds",
          },
        ),
      )
      .pipe(Effect.mapError(() => fail("spawn")));

    const ready = answer(url).pipe(
      Effect.flatMap((name) =>
        name === undefined || name === deploymentName
          ? Effect.succeed(name === deploymentName)
          : Effect.fail(fail("ports")),
      ),
      Effect.repeat({
        until: (isReady) => isReady,
        schedule: Schedule.spaced("100 millis"),
      }),
    );
    const exit = handle.exitCode.pipe(
      Effect.mapError(() => fail("exit")),
      Effect.flatMap((code) => Effect.fail(fail("exit", Number(code)))),
    );
    yield* Effect.raceFirst(ready, exit).pipe(
      Effect.timeoutOrElse({
        duration: "60 seconds",
        orElse: () => Effect.fail(fail("timeout")),
      }),
    );
    if (identity.ports === undefined) yield* save({ ...identity, ports });
    // An exited backend releases the data directory before `exited`
    // completes, so the deployment can be booted again in this session.
    yield* handle.exitCode.pipe(
      Effect.ignore,
      Effect.andThen(Scope.close(owned, Exit.void)),
      Effect.forkIn(session),
    );
    return {
      url,
      siteUrl,
      adminKey: Redacted.make(identity.adminKey),
      exited: Deferred.await(stopped),
    } satisfies LocalBackend;
  });

  return yield* startup
    .withPermits(1)(start)
    .pipe(
      Scope.provide(owned),
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) ? Effect.void : Scope.close(owned, exit),
      ),
    );
});
