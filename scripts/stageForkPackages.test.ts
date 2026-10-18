import * as BunServices from "@effect/platform-bun/BunServices";
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import {
  chooseBuildVersion,
  PackageManifest,
  packageBaseVersion,
  stageForkPackages,
  readVersions,
} from "./stageForkPackages";
import * as Schema from "effect/Schema";
import { publishedPackages } from "./checkPackContents";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const directories = await Effect.runPromise(
  publishedPackages().pipe(Effect.provide(BunServices.layer)),
);

test.each(directories)(
  "renames the real %s manifest without changing its input",
  (directory) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const input = yield* fs
          .readFileString(
            new URL(`../${directory}/package.json`, import.meta.url).pathname,
          )
          .pipe(
            Effect.flatMap(
              Schema.decodeEffect(Schema.fromJsonString(PackageManifest)),
            ),
          );
        const before = encodeJson(input);
        const output = stageForkPackages(input, "10.2.0-fork.7");
        expect(output).toMatchObject({
          name: `@gaganref/confect-${input.name.slice("@confect/".length)}`,
          version: "10.2.0-fork.7",
          repository: {
            type: "git",
            url: "git+https://github.com/gaganref/confect.git",
          },
          bugs: { url: "https://github.com/gaganref/confect" },
          homepage: input.homepage,
          publishConfig: {
            registry: "https://registry.npmjs.org",
            access: "public",
          },
          exports: input.exports,
        });
        for (const field of [
          "dependencies",
          "peerDependencies",
          "optionalDependencies",
        ] as const) {
          const dependencies = input[field];
          expect(output[field]).toEqual(
            dependencies === undefined
              ? undefined
              : Object.fromEntries(
                  Object.entries(dependencies).map(([name, range]) => [
                    name,
                    name.startsWith("@confect/")
                      ? `npm:@gaganref/confect-${name.slice("@confect/".length)}@10.2.0-fork.7`
                      : range,
                  ]),
                ),
          );
        }
        expect(output.devDependencies).toBeUndefined();
        expect(output.scripts).toBeUndefined();
        expect(encodeJson(input)).toBe(before);
      }).pipe(Effect.provide(BunServices.layer)),
    ),
);

test("rewrites all internal dependency maps and retains external ranges and metadata", () => {
  const output = stageForkPackages(
    {
      name: "@confect/js",
      version: "10.2.0",
      dependencies: { "@confect/core": "workspace:*", effect: "^4.0.0" },
      optionalDependencies: { "@confect/server": "workspace:^" },
      peerDependencies: { "@confect/core": "^10.2.0" },
      peerDependenciesMeta: { "@confect/core": { optional: true } },
      publishConfig: { access: "restricted", provenance: false, tag: "build" },
    },
    "10.2.0-fork.7",
  );
  expect(output).toMatchObject({
    dependencies: {
      "@confect/core": "npm:@gaganref/confect-core@10.2.0-fork.7",
      effect: "^4.0.0",
    },
    optionalDependencies: {
      "@confect/server": "npm:@gaganref/confect-server@10.2.0-fork.7",
    },
    peerDependencies: {
      "@confect/core": "npm:@gaganref/confect-core@10.2.0-fork.7",
    },
    peerDependenciesMeta: { "@confect/core": { optional: true } },
    publishConfig: {
      access: "public",
      registry: "https://registry.npmjs.org",
      tag: "build",
    },
  });
  expect(output.publishConfig).not.toHaveProperty("provenance");
});

test("starts at one and advances past the highest published build for this base", () => {
  expect(Result.getOrThrow(chooseBuildVersion("10.2.0", []))).toBe(
    "10.2.0-fork.1",
  );
  expect(
    Result.getOrThrow(
      chooseBuildVersion("10.2.0", [
        "10.2.0-fork.2",
        "10.2.0-fork.10",
        "10.3.0-fork.99",
        "10.2.0-next.90",
        "10.2.0-fork.11.extra",
      ]),
    ),
  ).toBe("10.2.0-fork.11");
  expect(
    Result.getOrThrow(chooseBuildVersion("10.2.0", ["10.2.0-fork.10"], "30")),
  ).toBe("10.2.0-fork.30");
});

test.each(["0", "-1", "1.5", "1e2", "01", "abc", "9007199254740992"])(
  "rejects invalid explicit build number %s",
  (value) => {
    const result = chooseBuildVersion("10.2.0", [], value);
    expect(Result.isFailure(result) && result.failure._tag).toBe(
      "InvalidBuildVersion",
    );
  },
);

test("rejects a prerelease base and exhausted build numbers", () => {
  for (const result of [
    chooseBuildVersion("10.2.0-next.1", []),
    chooseBuildVersion("10.2.0", ["10.2.0-fork.9007199254740991"]),
  ]) {
    expect(Result.isFailure(result) && result.failure._tag).toBe(
      "InvalidBuildVersion",
    );
  }
});

test("rejects an explicit version that any package has already published", () => {
  const result = chooseBuildVersion("10.2.0", ["10.2.0-fork.7"], "7");
  expect(Result.isFailure(result) && result.failure).toMatchObject({
    _tag: "BuildNumberUnavailable",
    version: "10.2.0-fork.7",
    highestBuild: 7,
  });
});

test("never accepts dry-run as a build number", () => {
  const result = chooseBuildVersion("10.2.0", [], "dry-run");
  expect(Result.isFailure(result) && result.failure._tag).toBe(
    "InvalidBuildVersion",
  );
});

test("requires all source packages to share the core base version", () => {
  const core = { name: "@confect/core", version: "10.2.0" };
  expect(
    Result.getOrThrow(
      packageBaseVersion([
        core,
        { name: "@confect/server", version: "10.2.0" },
      ]),
    ),
  ).toBe("10.2.0");
  const mismatch = packageBaseVersion([
    core,
    { name: "@confect/server", version: "10.3.0" },
  ]);
  expect(Result.isFailure(mismatch) && mismatch.failure).toMatchObject({
    _tag: "PackageVersionMismatch",
    packageName: "@confect/server",
    expected: "10.2.0",
    actual: "10.3.0",
  });
  const missing = packageBaseVersion([
    { name: "@confect/server", version: "10.2.0" },
  ]);
  expect(Result.isFailure(missing) && missing.failure).toMatchObject({
    _tag: "MissingCorePackage",
    packages: ["@confect/server"],
  });
});

test("rejects an unused override below the highest existing number", () => {
  const result = chooseBuildVersion("10.2.0", ["10.2.0-fork.10"], "7");
  expect(Result.isFailure(result) && result.failure).toMatchObject({
    _tag: "BuildNumberUnavailable",
    version: "10.2.0-fork.7",
    highestBuild: 10,
  });
});

const registryVersions = (body: string, status = 200) =>
  readVersions("@gaganref/confect-server").pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        expect(request.url).toBe(
          "https://registry.npmjs.org/@gaganref%2Fconfect-server",
        );
        expect(request.headers.authorization).toBeUndefined();
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(body, { status })),
        );
      }),
    ),
    Effect.provide(BunServices.layer),
  );

test.each([{ gaganref: "10.2.0-fork.1" }, {}])(
  "reads every published version without a latest tag %j",
  (tags) =>
    Effect.runPromise(
      registryVersions(
        JSON.stringify({
          "dist-tags": tags,
          versions: {
            "10.2.0-fork.1": {},
            "10.2.0-fork.4": {},
            "10.1.0-fork.99": {},
          },
        }),
      ).pipe(
        Effect.map((versions) => {
          expect(versions).toEqual([
            "10.2.0-fork.1",
            "10.2.0-fork.4",
            "10.1.0-fork.99",
          ]);
          expect(
            Result.getOrThrow(chooseBuildVersion("10.2.0", versions)),
          ).toBe("10.2.0-fork.5");
        }),
      ),
    ),
);

test("treats only an absent package as having no published versions", () =>
  Effect.runPromise(
    registryVersions('{"error":"not found"}', 404).pipe(
      Effect.map((versions) => expect(versions).toEqual([])),
    ),
  ));

for (const status of [401, 403, 500]) {
  test(`fails on registry status ${status}`, () =>
    Effect.runPromise(
      registryVersions('{"error":"registry failure"}', status).pipe(
        Effect.flip,
        Effect.map((error) =>
          expect(error).toMatchObject({
            _tag: "HttpClientError",
            reason: { _tag: "StatusCodeError", response: { status } },
          }),
        ),
      ),
    ));
}

for (const [body, expected] of [
  ["{", { _tag: "HttpClientError", reason: { _tag: "DecodeError" } }],
  ["{}", { _tag: "SchemaError" }],
  ['{"versions":[]}', { _tag: "SchemaError" }],
] as const) {
  test(`rejects malformed registry metadata ${body}`, () =>
    Effect.runPromise(
      registryVersions(body).pipe(
        Effect.flip,
        Effect.map((error) => expect(error).toMatchObject(expected)),
      ),
    ));
}
