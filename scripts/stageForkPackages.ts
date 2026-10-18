import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { publishedPackages } from "./checkPackContents";

const encodeJson = Schema.encodeSync(
  Schema.fromJsonString(Schema.Unknown, { space: 2 }),
);

const dependencyMap = Schema.Record(Schema.String, Schema.String);
export const PackageManifest = Schema.StructWithRest(
  Schema.Struct({
    name: Schema.String.check(Schema.isPattern(/^@confect\/[a-z][a-z0-9-]*$/)),
    version: Schema.String,
    private: Schema.optionalKey(Schema.Boolean),
    dependencies: Schema.optionalKey(dependencyMap),
    peerDependencies: Schema.optionalKey(dependencyMap),
    optionalDependencies: Schema.optionalKey(dependencyMap),
    publishConfig: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.Unknown),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
export type PackageManifest = typeof PackageManifest.Type;

const forkPackageName = (name: string) =>
  name.replace(/^@confect\//, "@gaganref/confect-");

export const stageForkPackages = (
  manifest: PackageManifest,
  version: string,
): PackageManifest => {
  const {
    devDependencies: _devDependencies,
    scripts: _scripts,
    ...rest
  } = manifest;
  const dependencies = Object.fromEntries(
    (
      ["dependencies", "peerDependencies", "optionalDependencies"] as const
    ).flatMap((field) => {
      const values = manifest[field];
      return values === undefined
        ? []
        : [
            [
              field,
              Object.fromEntries(
                Object.entries(values).map(([name, range]) => [
                  name,
                  name.startsWith("@confect/")
                    ? `npm:${forkPackageName(name)}@${version}`
                    : range,
                ]),
              ),
            ],
          ];
    }),
  );
  return {
    ...rest,
    ...dependencies,
    name: forkPackageName(manifest.name),
    version,
    repository: {
      type: "git",
      url: "git+https://github.com/gaganref/confect.git",
    },
    bugs: { url: "https://github.com/gaganref/confect" },
    publishConfig: {
      ...manifest.publishConfig,
      registry: "https://registry.npmjs.org",
      access: "public",
      provenance: true,
    },
  };
};

export class InvalidBuildVersion extends Schema.TaggedError<InvalidBuildVersion>()(
  "InvalidBuildVersion",
  { base: Schema.String, build: Schema.String },
) {}

export class BuildNumberUnavailable extends Schema.TaggedError<BuildNumberUnavailable>()(
  "BuildNumberUnavailable",
  { version: Schema.String, highestBuild: Schema.Finite },
) {}

class MissingCorePackage extends Schema.TaggedError<MissingCorePackage>()(
  "MissingCorePackage",
  { packages: Schema.Array(Schema.String) },
) {}

class PackageVersionMismatch extends Schema.TaggedError<PackageVersionMismatch>()(
  "PackageVersionMismatch",
  {
    packageName: Schema.String,
    expected: Schema.String,
    actual: Schema.String,
  },
) {}

export const packageBaseVersion = (
  manifests: ReadonlyArray<PackageManifest>,
): Result.Result<string, MissingCorePackage | PackageVersionMismatch> => {
  const core = manifests.find((manifest) => manifest.name === "@confect/core");
  if (core === undefined)
    return Result.fail(
      new MissingCorePackage({
        packages: manifests.map((manifest) => manifest.name),
      }),
    );
  const mismatch = manifests.find(
    (manifest) => manifest.version !== core.version,
  );
  return mismatch === undefined
    ? Result.succeed(core.version)
    : Result.fail(
        new PackageVersionMismatch({
          packageName: mismatch.name,
          expected: core.version,
          actual: mismatch.version,
        }),
      );
};

export const chooseBuildVersion = (
  base: string,
  versions: ReadonlyArray<string>,
  override = "",
): Result.Result<string, InvalidBuildVersion | BuildNumberUnavailable> => {
  const prefix = `${base}-fork.`;
  const builds = versions
    .filter((version) => version.startsWith(prefix))
    .map((version) => version.slice(prefix.length))
    .filter((build) => /^(0|[1-9]\d*)$/.test(build))
    .map(Number);
  const highestBuild = Math.max(0, ...builds);
  const build = override === "" ? highestBuild + 1 : Number(override);
  if (
    !/^\d+\.\d+\.\d+$/.test(base) ||
    (override !== "" && !/^[1-9]\d*$/.test(override)) ||
    !Number.isSafeInteger(build)
  ) {
    return Result.fail(
      new InvalidBuildVersion({ base, build: override || String(build) }),
    );
  }
  const version = `${prefix}${build}`;
  return build <= highestBuild
    ? Result.fail(new BuildNumberUnavailable({ version, highestBuild }))
    : Result.succeed(version);
};

class CommandFailed extends Schema.TaggedError<CommandFailed>()(
  "CommandFailed",
  {
    command: Schema.Array(Schema.String),
    exitCode: Schema.Finite,
    stdout: Schema.String,
    stderr: Schema.String,
  },
) {}

const run = Effect.fn("ForkPackages.command")(function* (
  command: readonly [string, ...Array<string>],
  cwd: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const [executable, ...args] = command;
  const handle = yield* spawner.spawn(
    ChildProcess.make(executable, args, { cwd, stdin: "ignore" }),
  );
  const output = yield* Effect.all(
    {
      exitCode: handle.exitCode,
      stdout: handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      stderr: handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
    },
    { concurrency: "unbounded" },
  );
  if (output.exitCode !== 0)
    return yield* new CommandFailed({ command, ...output });
  return output.stdout;
}, Effect.scoped);

export const readVersions = Effect.fn("ForkPackages.versions")(function* (
  name: string,
) {
  const response = yield* HttpClient.execute(
    HttpClientRequest.get(
      `https://registry.npmjs.org/${name.replace("/", "%2F")}`,
    ).pipe(HttpClientRequest.acceptJson),
  );
  if (response.status === 404) return [];
  const metadata = yield* HttpClientResponse.filterStatusOk(response).pipe(
    Effect.flatMap(
      HttpClientResponse.schemaBodyJson(
        Schema.Struct({
          versions: Schema.Record(Schema.String, Schema.Unknown),
        }),
      ),
    ),
  );
  return Object.keys(metadata.versions);
});

const stage = Effect.fn("ForkPackages.stage")(function* (
  destination: string,
  build: string,
  dryRun: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dir, "..");
  const packages = [];
  for (const sourceDirectory of yield* publishedPackages(
    path.join(root, "packages"),
  )) {
    const manifest = yield* fs
      .readFileString(path.join(sourceDirectory, "package.json"))
      .pipe(
        Effect.flatMap(
          Schema.decodeEffect(Schema.fromJsonString(PackageManifest)),
        ),
      );
    packages.push({ directory: path.basename(sourceDirectory), manifest });
  }
  const base = yield* Effect.fromResult(
    packageBaseVersion(packages.map((pkg) => pkg.manifest)),
  );
  yield* Effect.fromResult(chooseBuildVersion(base, [], build));
  const versions = yield* Effect.forEach(
    packages,
    (pkg) =>
      dryRun
        ? Effect.succeed([])
        : readVersions(forkPackageName(pkg.manifest.name)),
    { concurrency: "unbounded" },
  );
  const selected = yield* Effect.fromResult(
    chooseBuildVersion(base, versions.flat(), build),
  );
  const version = dryRun ? `${base}-fork.0` : selected;
  const stagingDirectory = path.resolve(destination);
  yield* fs.makeDirectory(stagingDirectory);
  for (const directory of ["packages", "tarballs", "original"])
    yield* fs.makeDirectory(path.join(stagingDirectory, directory));
  const plan = [];
  for (const pkg of packages) {
    const directory = path.join(stagingDirectory, "packages", pkg.directory);
    const archive = path.join(
      stagingDirectory,
      "original",
      `${pkg.directory}.tgz`,
    );
    yield* fs.makeDirectory(directory);
    yield* run(
      ["pnpm", "pack", "--out", archive],
      path.join(root, "packages", pkg.directory),
    );
    yield* run(
      ["tar", "-xzf", archive, "--strip-components=1", "-C", directory],
      root,
    );
    const packed = yield* fs
      .readFileString(path.join(directory, "package.json"))
      .pipe(
        Effect.flatMap(
          Schema.decodeEffect(Schema.fromJsonString(PackageManifest)),
        ),
      );
    const renamed = stageForkPackages(packed, version);
    yield* fs.writeFileString(
      path.join(directory, "package.json"),
      `${encodeJson(renamed)}\n`,
    );
    yield* run(
      [
        "pnpm",
        "pack",
        "--out",
        path.join(stagingDirectory, "tarballs", `${pkg.directory}.tgz`),
      ],
      directory,
    );
    plan.push({
      name: renamed.name,
      version,
      tarball: `tarballs/${pkg.directory}.tgz`,
    });
    yield* Console.log(`staged ${renamed.name}@${version}`);
  }
  yield* fs.writeFileString(
    path.join(stagingDirectory, "plan.json"),
    `${encodeJson({ version, packages: plan })}\n`,
  );
});

if (import.meta.main) {
  const [destination, build = "", mode = ""] = Bun.argv.slice(2);
  if (destination === undefined || (mode !== "" && mode !== "--dry-run")) {
    Console.error(
      "Usage: bun scripts/stageForkPackages.ts <new-staging-directory> [build-number] [--dry-run]",
    ).pipe(Effect.runSync);
    process.exitCode = 1;
  } else {
    stage(destination, build, mode === "--dry-run").pipe(
      Effect.tapError((error) => Console.error(error)),
      Effect.provide([BunServices.layer, FetchHttpClient.layer]),
      BunRuntime.runMain,
    );
  }
}
