import * as BunServices from "@effect/platform-bun/BunServices";
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  consumerManifest,
  installCommand,
  writeConsumer,
} from "./forkConsumer";

test("pins all eight public aliases to the requested fork build", () => {
  expect(consumerManifest("10.2.0-fork.7").pipe(Result.getOrThrow)).toEqual({
    name: "confect-install-check",
    private: true,
    type: "module",
    dependencies: {
      "@confect/alchemy": "npm:@gaganref/confect-alchemy@10.2.0-fork.7",
      "@confect/foldkit": "npm:@gaganref/confect-foldkit@10.2.0-fork.7",
      "@confect/js": "npm:@gaganref/confect-js@10.2.0-fork.7",
      "@confect/react": "npm:@gaganref/confect-react@10.2.0-fork.7",
      "@confect/core": "npm:@gaganref/confect-core@10.2.0-fork.7",
      "@confect/server": "npm:@gaganref/confect-server@10.2.0-fork.7",
      "@confect/test": "npm:@gaganref/confect-test@10.2.0-fork.7",
      "@confect/cli": "npm:@gaganref/confect-cli@10.2.0-fork.7",
      alchemy: "2.0.0-beta.86",
      foldkit: "0.170.0",
      react: "19.3.1",
      convex: "1.49.0",
      "convex-test": "0.0.67",
      "counter-kit": "link:./kits/counter-kit",
      effect: "4.1.4",
      "@effect/platform-node": "4.1.4",
    },
    devDependencies: {
      "@types/node": "26.6.5",
      "@types/react": "19.3.0",
      typescript: "6.0.3",
      vite: "8.3.4",
      vitest: "5.0.3",
    },
    packageManager: "pnpm@12.8.1",
  });
});

test("uses packed fork packages without fetching their internal aliases", () => {
  const manifest = Result.getOrThrow(
    consumerManifest("10.2.0-fork.0", "/tmp/build/tarballs"),
  );
  expect(manifest.dependencies).toMatchObject({
    "@confect/core": "file:/tmp/build/tarballs/core.tgz",
    "@confect/server": "file:/tmp/build/tarballs/server.tgz",
    "@confect/test": "file:/tmp/build/tarballs/test.tgz",
    "@confect/cli": "file:/tmp/build/tarballs/cli.tgz",
  });
});

test("prints the executable strict add command for the generated aliases", () => {
  const manifest = Result.getOrThrow(consumerManifest("10.2.0-fork.7"));
  expect(installCommand(manifest)).toBe(
    "pnpm add --strict-peer-dependencies '@confect/alchemy@npm:@gaganref/confect-alchemy@10.2.0-fork.7' '@confect/core@npm:@gaganref/confect-core@10.2.0-fork.7' '@confect/foldkit@npm:@gaganref/confect-foldkit@10.2.0-fork.7' '@confect/js@npm:@gaganref/confect-js@10.2.0-fork.7' '@confect/react@npm:@gaganref/confect-react@10.2.0-fork.7' '@confect/server@npm:@gaganref/confect-server@10.2.0-fork.7' '@confect/test@npm:@gaganref/confect-test@10.2.0-fork.7' '@confect/cli@npm:@gaganref/confect-cli@10.2.0-fork.7'",
  );
});

test("writes and refreshes a consumer with aligned peers", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDirectoryScoped = yield* fs.makeTempDirectoryScoped();
      const directory = path.join(tempDirectoryScoped, "consumer");
      yield* writeConsumer(
        directory,
        Result.getOrThrow(consumerManifest("10.2.0-fork.0")),
      );
      yield* writeConsumer(
        directory,
        Result.getOrThrow(consumerManifest("10.2.0-fork.0")),
      );
      const manifest = yield* fs.readFileString(
        path.join(directory, "package.json"),
      );
      const decoded = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.Unknown),
      )(manifest);
      expect(decoded).toMatchObject({
        dependencies: {
          "@confect/core": "npm:@gaganref/confect-core@10.2.0-fork.0",
          "@confect/server": "npm:@gaganref/confect-server@10.2.0-fork.0",
          "@confect/test": "npm:@gaganref/confect-test@10.2.0-fork.0",
          "@confect/cli": "npm:@gaganref/confect-cli@10.2.0-fork.0",
        },
      });
      const contents = yield* fs.readFileString(
        path.join(directory, "pnpm-workspace.yaml"),
      );
      expect(contents).toBe(`minimumReleaseAgeExclude:
  - "@gaganref/confect-alchemy@10.2.0-fork.0"
  - "@gaganref/confect-core@10.2.0-fork.0"
  - "@gaganref/confect-foldkit@10.2.0-fork.0"
  - "@gaganref/confect-js@10.2.0-fork.0"
  - "@gaganref/confect-react@10.2.0-fork.0"
  - "@gaganref/confect-server@10.2.0-fork.0"
  - "@gaganref/confect-test@10.2.0-fork.0"
  - "@gaganref/confect-cli@10.2.0-fork.0"

overrides:
  effect: 4.1.4
  convex: 1.49.0
  "@effect/platform-node": 4.1.4
  "@effect/platform-node-shared": 4.1.4
allowBuilds:
  esbuild: false
  workerd: false
`);
      const found = yield* fs.exists(
        path.join(directory, "convex/_generated/api.ts"),
      );
      expect(found).toBe(true);
      const found2 = yield* fs.exists(
        path.join(directory, "confect/hello.spec.ts"),
      );
      expect(found2).toBe(true);
      const found3 = yield* fs.exists(
        path.join(directory, "confect/hello.impl.ts"),
      );
      expect(found3).toBe(true);
      const found4 = yield* fs.exists(path.join(directory, "pnpm-lock.yaml"));
      expect(found4).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  ));

test("writes a declared host, mounted component and callback consumer", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDirectoryScoped = yield* fs.makeTempDirectoryScoped();
      const directory = path.join(tempDirectoryScoped, "consumer");
      yield* writeConsumer(
        directory,
        Result.getOrThrow(consumerManifest("10.2.0-fork.0")),
      );
      for (const file of [
        "confect/env.ts",
        "confect/app.ts",
        "confect/auth.ts",
        "confect/http.ts",
        "confect/component.ts",
        "kits/counter-kit/package.json",
        "kits/counter-kit/convex.config.ts",
        "kits/counter-kit/testing.ts",
        "components/counter/confect/env.ts",
        "components/counter/confect/app.ts",
        "components/counter/confect/api.ts",
        "components/counter/confect/http.ts",
        "components/counter/confect/callbacks.ts",
        "components/counter/confect/counter.spec.ts",
        "components/counter/confect/counter.impl.ts",
        "components/counter/confect/tables/batches.ts",
        "components/counter/confect/tables/emails.ts",
        "components/counter/convex/_generated/api.ts",
        "components/counter/convex/_generated/component.ts",
      ]) {
        const found = yield* fs.exists(path.join(directory, file));
        expect(found).toBe(true);
      }
      for (const [file, contract] of [
        ["confect/app.ts", 'httpPrefix: "/counter"'],
        ["confect/app.ts", 'from "counter-kit/convex.config.js"'],
        ["confect/app.ts", 'name: "kitted"'],
        ["confect/component.ts", "Component.bind"],
        ["components/counter/confect/callbacks.ts", "Callback.mutation"],
        ["components/counter/confect/tables/emails.ts", '.group("batchId")'],
        ["consumer.test.ts", "Component.groups(counterContract)"],
        ["confect/hello.impl.ts", "Callback.create"],
        ["consumer.test.ts", "toBe(43)"],
      ] as const) {
        const contents = yield* fs.readFileString(path.join(directory, file));
        expect(contents).toContain(contract);
      }
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  ));

test.each([
  "",
  "latest",
  "10.2.0",
  "10.2.0-fork.01",
  "1.0.0-fork.1\n",
  "1.0.0-fork.1\r",
  "'; exit 0",
])("rejects a non-build version %j before writing a consumer", (version) => {
  const result = consumerManifest(version);
  expect(Result.isFailure(result) && result.failure).toMatchObject({
    _tag: "InvalidConsumerVersion",
    version,
  });
});
