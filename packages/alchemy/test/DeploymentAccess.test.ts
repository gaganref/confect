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
import * as Record from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { inspect } from "node:util";
import { key as listedKey, mockClient } from "./fixtures/ConvexClient";
import * as NodeServices from "./fixtures/NodeTestServices";

const deployment = {
  name: "happy-otter-123",
  url: "https://happy-otter-123.convex.cloud",
};

/**
 * Run `body` with the service `access` builds over the fake client.
 */
const withAccess = <A, E>(
  access: DeploymentAccess.Access,
  mock: ReturnType<typeof mockClient>,
  body: (
    service: DeploymentAccess.DeploymentAccess["Service"],
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      DeploymentAccess.layer(access).pipe(
        Layer.provide(Layer.succeed(ConvexClient, mock.client)),
      ),
    );
    return yield* DeploymentAccess.DeploymentAccess.pipe(
      Effect.flatMap(body),
      Effect.provideContext(services),
    );
  }).pipe(Effect.scoped);

const called = (mock: ReturnType<typeof mockClient>) =>
  Array.map(
    Array.filter(
      Record.toEntries(mock.client),
      ([, method]) => method.mock.calls.length > 0,
    ),
    ([name]) => name,
  );

describe("DeploymentAccess grant", () => {
  it.effect(
    "returns the key Convex gives an OAuth login and proves no key was minted",
    () => {
      const mock = mockClient({ oauthToken: "oauth-login-token" });
      mock.state.keys = [listedKey({ id: 7, name: "ci" })];
      return withAccess(DeploymentAccess.grant, mock, (service) =>
        Effect.gen(function* () {
          const first = yield* service.deployKey(deployment);
          const second = yield* service.deployKey(deployment);
          expect(Redacted.value(first)).toBe(
            "dev:happy-otter-123|oauth-login-token",
          );
          expect(second).toBe(first);
          expect(Array.map(mock.state.keys, (row) => row.id)).toEqual([7]);
          expect(mock.client.createDeployKey).toHaveBeenCalledTimes(1);
          expect(mock.client.deleteDeployKey).not.toHaveBeenCalled();
        }),
      );
    },
  );

  it.effect("sends the management login to the deployment API", () => {
    const mock = mockClient({ oauthToken: "oauth-login-token" });
    return withAccess(DeploymentAccess.grant, mock, (service) =>
      Effect.gen(function* () {
        const key = yield* service.api(deployment.url);
        expect(key).toBeUndefined();
        expect(called(mock)).toEqual([]);
      }),
    );
  });

  it.effect(
    "deletes a key the login minted, by its listed name, and refuses the grant",
    () => {
      const mock = mockClient({ deployKey: "dev:happy-otter-123|minted" });
      mock.state.keys = [listedKey({ id: 3, name: "ci" })];
      return withAccess(DeploymentAccess.grant, mock, (service) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(service.deployKey(deployment));
          assert(error._tag === "DeploymentGrantUnproven");
          expect(error.deploymentName).toBe("happy-otter-123");
          expect(error.reason).toBe("Minted");
          expect(error.keyIds).toEqual([4]);
          expect(Array.map(mock.state.keys, (row) => row.id)).toEqual([3]);
          expect(mock.client.deleteDeployKey).toHaveBeenCalledTimes(1);
          const [, sent] = mock.client.deleteDeployKey.mock.calls[0]!;
          expect(sent).toBe("confect-alchemy-access");
          expect(inspect(error)).not.toContain("minted");
        }),
      );
    },
  );
});

describe("DeploymentAccess deployKey", () => {
  const supplied = Redacted.make("prod:brave-fox-456|supplied-secret");

  it.effect(
    "refuses a key whose prefix names another deployment before any call",
    () => {
      const mock = mockClient();
      return withAccess(DeploymentAccess.deployKey(supplied), mock, (service) =>
        Effect.gen(function* () {
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
        }),
      );
    },
  );

  it.effect("serves the deployment its prefix names", () => {
    const mock = mockClient();
    const own = {
      name: "brave-fox-456",
      url: "https://brave-fox-456.convex.cloud",
    };
    return withAccess(DeploymentAccess.deployKey(supplied), mock, (service) =>
      Effect.gen(function* () {
        const api = yield* service.api(own.url);
        const push = yield* service.deployKey(own);
        expect(api).toBe(supplied);
        expect(push).toBe(supplied);
        expect(called(mock)).toEqual([]);
      }),
    );
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
          const services = yield* Layer.build(
            DeploymentAccess.localLayer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(AlchemyContext, {
                    dotAlchemy,
                    dev: true,
                    adopt: false,
                  }),
                  Layer.succeed(Stack, {
                    name: "notes",
                    stage: "dev",
                    resources: {},
                    bindings: {},
                    actions: {},
                  }),
                ),
              ),
            ),
          );
          const service = yield* DeploymentAccess.DeploymentAccess.pipe(
            Effect.provideContext(services),
          );
          const reveal = (key: Redacted.Redacted<string> | undefined) =>
            key === undefined ? undefined : Redacted.value(key);
          const missing = yield* Effect.flip(service.deployKey(local));
          assert(missing._tag === "DeploymentAccessRefused");
          expect(missing.reason).toBe("UnknownDeployment");
          yield* fs.makeDirectory(directory, { recursive: true });
          for (const adminKey of [`${name}|0a1b2c`, `${name}|3d4e5f`]) {
            yield* write(adminKey);
            const push = yield* service.deployKey(local);
            const api = yield* service.api(local.url);
            expect(reveal(push)).toBe(adminKey);
            expect(reveal(api)).toBe(adminKey);
          }
          const elsewhere = yield* Effect.flip(
            service.api("http://127.0.0.1:3400"),
          );
          assert(elsewhere._tag === "DeploymentAccessRefused");
          expect(elsewhere.reason).toBe("UnknownDeployment");
        }).pipe(Effect.provideContext(node));
      }),
  );
});
