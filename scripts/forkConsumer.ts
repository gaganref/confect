import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as String from "effect/String";
import { pipe } from "effect/Function";
import * as Array from "effect/Array";
import * as Record from "effect/Record";

const encodeJson = Schema.encodeSync(
  Schema.fromJsonString(Schema.Unknown, { space: 2 }),
);

export class InvalidConsumerVersion extends Schema.TaggedError<InvalidConsumerVersion>()(
  "InvalidConsumerVersion",
  { version: Schema.String },
) {}

export const consumerManifest = (version: string, tarballs?: string) => {
  if (!/^\d+\.\d+\.\d+-fork\.(0|[1-9]\d*)$/.test(version))
    return Result.fail(InvalidConsumerVersion.make({ version }));
  const forkPackage = (name: string) =>
    tarballs === undefined
      ? `npm:@gaganref/confect-${name}@${version}`
      : `file:${tarballs}/${name}.tgz`;
  return Result.succeed({
    name: "confect-install-check",
    private: true,
    type: "module",
    dependencies: {
      "@confect/alchemy": forkPackage("alchemy"),
      "@confect/core": forkPackage("core"),
      "@confect/foldkit": forkPackage("foldkit"),
      "@confect/js": forkPackage("js"),
      "@confect/react": forkPackage("react"),
      "@confect/server": forkPackage("server"),
      "@confect/test": forkPackage("test"),
      "@confect/cli": forkPackage("cli"),
      alchemy: "2.0.0-beta.86",
      foldkit: "0.170.0",
      react: "19.3.1",
      convex: "1.49.0",
      "convex-test": "0.0.67",
      "counter-kit": "link:./kits/counter-kit",
      effect: "4.1.4",
      "@effect/platform-node": "4.1.4",
    },
    // Alchemy pulls in capnp-es, whose compiler peer admits TypeScript 5 and 6.
    devDependencies: {
      "@types/node": "26.6.5",
      "@types/react": "19.3.0",
      typescript: "6.0.3",
      vite: "8.3.4",
      vitest: "5.0.3",
    },
    packageManager: "pnpm@12.8.1",
  });
};

type ConsumerManifest = Result.Result.Success<
  ReturnType<typeof consumerManifest>
>;

export const installCommand = (manifest: ConsumerManifest) =>
  `pnpm add --strict-peer-dependencies ${pipe(
    Record.toEntries(manifest.dependencies),
    Array.filter(([name]) => pipe(name, String.startsWith("@confect/"))),
    Array.map(([name, spec]) => `'${name}@${spec}'`),
    Array.join(" "),
  )}`;

/**
 * @internal
 */
export const writeConsumer = Effect.fn("ConsumerFixture.write")(function* (
  destination: string,
  manifest: ConsumerManifest,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(destination, { recursive: true });
  const template = path.join(import.meta.dir, "consumer");
  for (const file of yield* fs.readDirectory(template, { recursive: true })) {
    if (!pipe(file, String.endsWith(".template"))) continue;
    const target = path.join(
      destination,
      pipe(file, String.replace(/\.template$/, "")),
    );
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    const contents = yield* fs.readFileString(path.join(template, file));
    yield* fs.writeFileString(target, contents);
  }
  yield* fs.writeFileString(
    path.join(destination, "package.json"),
    `${encodeJson(manifest)}\n`,
  );
  yield* fs.writeFileString(
    path.join(destination, "install-command.txt"),
    `${installCommand(manifest)}\n`,
  );
  yield* fs.writeFileString(
    path.join(destination, "pnpm-workspace.yaml"),
    Array.join(
      [
        "minimumReleaseAgeExclude:",
        ...pipe(
          Record.values(manifest.dependencies),
          Array.filter((spec) =>
            pipe(spec, String.startsWith("npm:@gaganref/")),
          ),
          Array.map((spec) => `  - "${pipe(spec, String.slice(4))}"`),
        ),
        "",
        "overrides:",
        ...pipe(
          Record.toEntries(manifest.dependencies),
          Array.filter(
            ([name, spec]) =>
              pipe(name, String.startsWith("@confect/")) &&
              pipe(spec, String.startsWith("file:")),
          ),
          Array.map(([name, spec]) => `  "${name}": "${spec}"`),
        ),
        `  effect: ${manifest.dependencies.effect}`,
        `  convex: ${manifest.dependencies.convex}`,
        `  "@effect/platform-node": ${manifest.dependencies["@effect/platform-node"]}`,
        `  "@effect/platform-node-shared": ${manifest.dependencies["@effect/platform-node"]}`,
        "allowBuilds:",
        "  esbuild: false",
        "  workerd: false",
        "",
      ],
      "\n",
    ),
  );
});

if (import.meta.main) {
  const [destination, version, tarballs] = Bun.argv.slice(2);
  const manifest = consumerManifest(version ?? "", tarballs);
  if (!destination || Result.isFailure(manifest)) {
    Console.error(
      "Usage: bun scripts/forkConsumer.ts <new-directory> <build-version> [absolute-tarball-directory]",
      Result.isFailure(manifest) ? manifest.failure : undefined,
    ).pipe(Effect.runSync);
    process.exitCode = 1;
  } else {
    writeConsumer(destination, manifest.success).pipe(
      Effect.provide(BunServices.layer),
      BunRuntime.runMain,
    );
  }
}
