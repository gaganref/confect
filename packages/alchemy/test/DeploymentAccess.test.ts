import { assert, describe, expect, it } from "@effect/vitest";
import * as DeploymentAccess from "@confect/alchemy/DeploymentAccess";
import { ConvexClient } from "@confect/alchemy/ConvexClient";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { Stack } from "alchemy/Stack";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { inspect } from "node:util";
import { key, mockClient } from "./fixtures/ConvexClient";
import * as NodeServices from "./fixtures/NodeTestServices";

const deployment = {
  name: "happy-otter-123",
  url: "https://happy-otter-123.convex.cloud",
};

const access = (
  kind: DeploymentAccess.Access,
  mock: ReturnType<typeof mockClient>,
) =>
  DeploymentAccess.layer(kind).pipe(
    Layer.provide(Layer.succeed(ConvexClient, mock.client)),
  );

const called = (mock: ReturnType<typeof mockClient>) =>
  Array.filter(
    Object.entries(mock.client),
    ([, method]) => method.mock.calls.length > 0,
  ).map(([name]) => name);

describe("DeploymentAccess grant", () => {
  it.effect(
    "returns the key Convex gives an OAuth login and proves no key was minted",
    () => {
      const mock = mockClient({ oauthToken: "oauth-login-token" });
      mock.state.keys = [key({ id: 7, name: "ci" })];
      return Effect.gen(function* () {
        const service = yield* DeploymentAccess.DeploymentAccess;
        const first = yield* service.deployKey(deployment);
        const second = yield* service.deployKey(deployment);
        expect(Redacted.value(first)).toBe(
          "dev:happy-otter-123|oauth-login-token",
        );
        expect(second).toBe(first);
        expect(Array.map(mock.state.keys, (row) => row.id)).toEqual([7]);
        expect(mock.client.createDeployKey).toHaveBeenCalledTimes(1);
        expect(mock.client.deleteDeployKey).not.toHaveBeenCalled();
      }).pipe(Effect.provide(access(DeploymentAccess.grant, mock)));
    },
  );

  it.effect("sends the management login to the deployment API", () => {
    const mock = mockClient({ oauthToken: "oauth-login-token" });
    return Effect.gen(function* () {
      const service = yield* DeploymentAccess.DeploymentAccess;
      expect(yield* service.api(deployment.url)).toBeUndefined();
      expect(called(mock)).toEqual([]);
    }).pipe(Effect.provide(access(DeploymentAccess.grant, mock)));
  });

  it.effect(
    "deletes a key the login minted, by its listed name, and refuses the grant",
    () => {
      const mock = mockClient({ deployKey: "dev:happy-otter-123|minted" });
      mock.state.keys = [key({ id: 3, name: "ci" })];
      return Effect.gen(function* () {
        const service = yield* DeploymentAccess.DeploymentAccess;
        const error = yield* Effect.flip(service.deployKey(deployment));
        assert(error._tag === "DeploymentGrantUnproven");
        expect(error.deploymentName).toBe("happy-otter-123");
        expect(error.reason).toBe("Minted");
        expect(error.keyIds).toEqual([4]);
        expect(Array.map(mock.state.keys, (row) => row.id)).toEqual([3]);
        expect(mock.client.deleteDeployKey).toHaveBeenCalledTimes(1);
        const [, sent] = mock.client.deleteDeployKey.mock.calls[0]!;
        expect(sent).not.toContain("minted");
        expect(inspect(error)).not.toContain("minted");
      }).pipe(Effect.provide(access(DeploymentAccess.grant, mock)));
    },
  );
});

describe("DeploymentAccess deployKey", () => {
  const supplied = Redacted.make("prod:brave-fox-456|supplied-secret");

  it.effect(
    "refuses a key whose prefix names another deployment before any call",
    () => {
      const mock = mockClient();
      return Effect.gen(function* () {
        const service = yield* DeploymentAccess.DeploymentAccess;
        for (const request of [
          service.api(deployment.url),
          service.deployKey(deployment),
        ]) {
          const error = yield* Effect.flip(request);
          assert(error._tag === "DeploymentAccessRefused");
          expect(error.kind).toBe("deployKey");
          expect(error.reason).toBe("OtherDeployment");
          expect(inspect(error)).not.toContain("supplied-secret");
        }
        expect(called(mock)).toEqual([]);
      }).pipe(
        Effect.provide(access(DeploymentAccess.deployKey(supplied), mock)),
      );
    },
  );

  it.effect("serves the deployment its prefix names", () => {
    const mock = mockClient();
    const own = {
      name: "brave-fox-456",
      url: "https://brave-fox-456.convex.cloud",
    };
    return Effect.gen(function* () {
      const service = yield* DeploymentAccess.DeploymentAccess;
      expect(yield* service.api(own.url)).toBe(supplied);
      expect(yield* service.deployKey(own)).toBe(supplied);
      expect(called(mock)).toEqual([]);
    }).pipe(Effect.provide(access(DeploymentAccess.deployKey(supplied), mock)));
  });
});

describe("DeploymentAccess local", () => {
  it.effect(
    "reads the admin key of the local deployment on every request",
    () =>
      Effect.gen(function* () {
        const node = yield* Layer.build(NodeServices.layer);
        return yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dotAlchemy = yield* fs.makeTempDirectoryScoped({
            prefix: "confect-local-access-",
          });
          const name = "confect-deployment-0123456789abcdef01234567";
          const local = { name, url: "http://127.0.0.1:3300" };
          const directory = path.join(
            dotAlchemy,
            "convex",
            "notes",
            "dev",
            name,
          );
          const write = (adminKey: string) =>
            Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
              name,
              version: "precompiled-2026-10-28-cccbade",
              instanceSecret: "00ff",
              adminKey,
              ports: { port: 3300, sitePort: 3301 },
            }).pipe(
              Effect.flatMap((identity) =>
                fs.writeFileString(
                  path.join(directory, "identity.json"),
                  identity,
                ),
              ),
            );
          const service = yield* DeploymentAccess.DeploymentAccess.pipe(
            Effect.provide(DeploymentAccess.localLayer),
            Effect.provideService(AlchemyContext, {
              dotAlchemy,
              dev: true,
              adopt: false,
            }),
            Effect.provideService(Stack, {
              name: "notes",
              stage: "dev",
              resources: {},
              bindings: {},
              actions: {},
            }),
          );
          const missing = yield* Effect.flip(service.deployKey(local));
          assert(missing._tag === "DeploymentAccessRefused");
          expect(missing.reason).toBe("UnknownDeployment");
          yield* fs.makeDirectory(directory, { recursive: true });
          yield* write(`${name}|0a1b2c`);
          expect(Redacted.value(yield* service.deployKey(local))).toBe(
            `${name}|0a1b2c`,
          );
          expect(Redacted.value((yield* service.api(local.url))!)).toBe(
            `${name}|0a1b2c`,
          );
          yield* write(`${name}|3d4e5f`);
          expect(Redacted.value(yield* service.deployKey(local))).toBe(
            `${name}|3d4e5f`,
          );
          expect(Redacted.value((yield* service.api(local.url))!)).toBe(
            `${name}|3d4e5f`,
          );
          const elsewhere = yield* Effect.flip(
            service.api("http://127.0.0.1:3400"),
          );
          assert(elsewhere._tag === "DeploymentAccessRefused");
          expect(elsewhere.reason).toBe("UnknownDeployment");
        }).pipe(Effect.provideContext(node));
      }),
  );
});
