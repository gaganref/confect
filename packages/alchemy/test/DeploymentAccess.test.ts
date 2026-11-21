import { assert, describe, expect, it } from "@effect/vitest";
import * as DeploymentAccess from "@confect/alchemy/DeploymentAccess";
import { ConvexApiError, ConvexClient } from "@confect/alchemy/ConvexClient";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { Stack } from "alchemy/Stack";
import * as Array from "effect/Array";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Record from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { inspect } from "node:util";
import { key as listedKey, mockClient } from "./fixtures/ConvexClient";
import * as NodeServices from "./fixtures/NodeTestServices";
import { assertIs } from "./internal/assertIs";

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
  const prefix = "confect-alchemy-access-";
  /**
   * The key name the grant check sent with its `n`th create, counting from 0.
   */
  const attemptName = (mock: ReturnType<typeof mockClient>, n = 0) =>
    mock.client.createDeployKey.mock.calls[n]![1].name;
  const ids = (mock: ReturnType<typeof mockClient>) =>
    Array.map(mock.state.keys, (row) => row.id);
  const writes = (mock: ReturnType<typeof mockClient>) =>
    Array.filter(called(mock), (name) => !/^(?:get|list)/.test(name));

  it.effect(
    "returns the key Convex gives a project login that mints nothing",
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
          expect(ids(mock)).toEqual([7]);
          expect(mock.client.createDeployKey).toHaveBeenCalledTimes(1);
          expect(attemptName(mock)).toMatch(
            /^confect-alchemy-access-[0-9a-f]{32}$/,
          );
          expect(mock.client.deleteDeployKey).not.toHaveBeenCalled();
        }),
      );
    },
  );

  it.effect("names each attempt with a part no other attempt shares", () => {
    const mock = mockClient({ oauthToken: "oauth-login-token" });
    mock.client.createDeployKey.mockImplementationOnce(() =>
      Effect.fail(
        ConvexApiError.make({
          operation: "createDeployKey",
          status: 503,
          code: "HttpError",
        }),
      ),
    );
    return withAccess(DeploymentAccess.grant, mock, (service) =>
      Effect.gen(function* () {
        const failed = yield* Effect.flip(service.deployKey(deployment));
        expect(failed._tag).toBe("ConvexApiError");
        const key = yield* service.deployKey(deployment);
        expect(Redacted.value(key)).toBe(
          "dev:happy-otter-123|oauth-login-token",
        );
        expect(mock.client.createDeployKey).toHaveBeenCalledTimes(2);
        expect(attemptName(mock, 0)).not.toBe(attemptName(mock, 1));
      }),
    );
  });

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

  it.effect("refuses a team-scoped login before any write", () => {
    const mock = mockClient({ deployKey: "dev:happy-otter-123|minted" });
    return withAccess(DeploymentAccess.grant, mock, (service) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(service.deployKey(deployment));
        assert(error._tag === "DeploymentGrantRefused");
        expect(error.reason).toBe("TeamScoped");
        expect(error.deploymentName).toBe("happy-otter-123");
        expect(error.message).toContain("project-scoped");
        expect(error.message).toContain("DeploymentAccess.deployKey");
        expect(called(mock)).toEqual(["getTokenDetails"]);
        expect(mock.state.keys).toEqual([]);
      }),
    );
  });

  it.effect(
    "refuses, naming them, when the deployment lists keys an earlier check left",
    () => {
      const mock = mockClient({ oauthToken: "oauth-login-token" });
      const left = `${prefix}0123456789abcdef0123456789abcdef`;
      mock.state.keys = [
        listedKey({ id: 3, name: "ci" }),
        listedKey({ id: 5, name: left }),
      ];
      return withAccess(DeploymentAccess.grant, mock, (service) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(service.deployKey(deployment));
          assert(error._tag === "DeploymentGrantRefused");
          expect(error.reason).toBe("LeftoverKeys");
          expect(error.keyNames).toEqual([left]);
          expect(error.message).toContain(left);
          expect(error.message).toContain("Convex dashboard");
          expect(writes(mock)).toEqual([]);
          expect(ids(mock)).toEqual([3, 5]);
        }),
      );
    },
  );

  it.effect(
    "deletes the key a project login minted by this attempt's listed name, and refuses",
    () => {
      const mock = mockClient({
        deployKey: "dev:happy-otter-123|minted-key-text",
        scope: "project",
      });
      mock.state.keys = [listedKey({ id: 3, name: "ci" })];
      return withAccess(DeploymentAccess.grant, mock, (service) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(service.deployKey(deployment));
          assert(error._tag === "DeploymentGrantUnproven");
          expect(error.reason).toBe("Minted");
          expect(error.deleted).toBe(true);
          expect(error.keyName).toBe(attemptName(mock));
          expect(error.message).toContain("was deleted");
          expect(error.message).toContain("DeploymentAccess.deployKey");
          expect(ids(mock)).toEqual([3]);
          expect(mock.client.deleteDeployKey).toHaveBeenCalledTimes(1);
          expect(mock.client.deleteDeployKey.mock.calls[0]![1]).toBe(
            attemptName(mock),
          );
          expect(inspect(error)).not.toContain("minted-key-text");
        }),
      );
    },
  );

  it.effect("says so when the minted key could not be deleted", () => {
    const mock = mockClient({
      deployKey: "dev:happy-otter-123|minted-key-text",
      scope: "project",
    });
    mock.client.deleteDeployKey.mockImplementationOnce(() =>
      Effect.fail(
        ConvexApiError.make({
          operation: "deleteDeployKey",
          status: 500,
          code: "HttpError",
        }),
      ),
    );
    return withAccess(DeploymentAccess.grant, mock, (service) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(service.deployKey(deployment));
        assert(error._tag === "DeploymentGrantUnproven");
        expect(error.reason).toBe("Minted");
        expect(error.deleted).toBe(false);
        expect(error.message).toContain("could not be deleted");
        expect(error.message).toContain(attemptName(mock));
        expect(Array.map(mock.state.keys, (row) => row.name)).toEqual([
          attemptName(mock),
        ]);
      }),
    );
  });

  it.effect(
    "leaves a key another actor adds during the check alone and asks for another deploy",
    () => {
      const mock = mockClient({ oauthToken: "oauth-login-token" });
      mock.client.createDeployKey.mockImplementationOnce((name) =>
        Effect.sync(() => {
          mock.state.keys.push(listedKey({ id: 99, name: "someone-else" }));
          return {
            deployKey: Redacted.make(`dev:${name}|oauth-login-token`),
          };
        }),
      );
      return withAccess(DeploymentAccess.grant, mock, (service) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(service.deployKey(deployment));
          assert(error._tag === "DeploymentGrantUnproven");
          expect(error.reason).toBe("ListingChanged");
          expect(error.message).toContain("Deploy again");
          expect(error.message).toContain("Nothing was deleted");
          expect(mock.client.deleteDeployKey).not.toHaveBeenCalled();
          expect(ids(mock)).toEqual([99]);
        }),
      );
    },
  );

  it.effect(
    "names the attempt's key when the second listing fails, and a retry refuses on it",
    () => {
      const mock = mockClient({
        deployKey: "dev:happy-otter-123|minted-key-text",
        scope: "project",
      });
      const listed = mock.client.listDeployKeys.getMockImplementation()!;
      mock.client.listDeployKeys
        .mockImplementationOnce(listed)
        .mockImplementationOnce(() =>
          Effect.fail(
            ConvexApiError.make({
              operation: "listDeployKeys",
              status: 503,
              code: "HttpError",
            }),
          ),
        );
      return withAccess(DeploymentAccess.grant, mock, (service) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(service.deployKey(deployment));
          assert(error._tag === "DeploymentGrantUnproven");
          expect(error.reason).toBe("ListingFailed");
          expect(error.keyName).toBe(attemptName(mock));
          expect(error.message).toContain(attemptName(mock));
          expect(mock.client.deleteDeployKey).not.toHaveBeenCalled();
          const retry = yield* Effect.flip(service.deployKey(deployment));
          assert(retry._tag === "DeploymentGrantRefused");
          expect(retry.reason).toBe("LeftoverKeys");
          expect(retry.keyNames).toEqual([attemptName(mock)]);
          expect(mock.client.createDeployKey).toHaveBeenCalledTimes(1);
        }),
      );
    },
  );

  it.effect.each([
    { login: "a project login that mints keys", mints: true },
    { login: "a project login that mints nothing", mints: false },
  ])(
    "after an attempt is interrupted under $login, a retry is safe",
    ({ mints }) => {
      const mock = mints
        ? mockClient({
            deployKey: "dev:happy-otter-123|minted-key-text",
            scope: "project",
          })
        : mockClient({ oauthToken: "oauth-login-token" });
      return Effect.gen(function* () {
        const listing = yield* Deferred.make<void>();
        const listed = mock.client.listDeployKeys.getMockImplementation()!;
        mock.client.listDeployKeys
          .mockImplementationOnce(listed)
          .mockImplementationOnce(() =>
            Deferred.succeed(listing, undefined).pipe(
              Effect.andThen(Effect.never),
            ),
          );
        return yield* withAccess(DeploymentAccess.grant, mock, (service) =>
          Effect.gen(function* () {
            const attempt = yield* service
              .deployKey(deployment)
              .pipe(Effect.forkChild);
            yield* Deferred.await(listing);
            yield* Fiber.interrupt(attempt);
            const retry = yield* service
              .deployKey(deployment)
              .pipe(Effect.result);
            if (mints) {
              assertIs(retry, Result.isFailure);
              assert(retry.failure._tag === "DeploymentGrantRefused");
              expect(retry.failure.reason).toBe("LeftoverKeys");
              expect(retry.failure.keyNames).toEqual([attemptName(mock)]);
              expect(mock.client.createDeployKey).toHaveBeenCalledTimes(1);
            } else {
              assertIs(retry, Result.isSuccess);
              expect(Redacted.value(retry.success)).toBe(
                "dev:happy-otter-123|oauth-login-token",
              );
              expect(mock.client.createDeployKey).toHaveBeenCalledTimes(2);
            }
          }),
        );
      });
    },
  );

  it.effect(
    "runs one check when two resources ask for one deployment at once",
    () => {
      const mock = mockClient({ oauthToken: "oauth-login-token" });
      return Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const listed = mock.client.listDeployKeys.getMockImplementation()!;
        mock.client.listDeployKeys.mockImplementationOnce((name) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(listed(name)),
          ),
        );
        return yield* withAccess(DeploymentAccess.grant, mock, (service) =>
          Effect.gen(function* () {
            const first = yield* service
              .deployKey(deployment)
              .pipe(Effect.forkChild);
            yield* Deferred.await(entered);
            const second = yield* service
              .deployKey(deployment)
              .pipe(Effect.forkChild);
            // Let the second request run as far as it can before the first
            // check finishes.
            for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow;
            yield* Deferred.succeed(release, undefined);
            const keys = yield* Fiber.joinAll([first, second]);
            expect(keys[0]).toBe(keys[1]);
            expect(mock.client.createDeployKey).toHaveBeenCalledTimes(1);
            expect(mock.client.getTokenDetails).toHaveBeenCalledTimes(1);
          }),
        );
      });
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

  const other = Redacted.make("dev:happy-otter-123|other-secret");

  it.effect("serves each deployment the supplied key that names it", () => {
    const mock = mockClient();
    const own = {
      name: "brave-fox-456",
      url: "https://brave-fox-456.convex.cloud",
    };
    return withAccess(
      DeploymentAccess.deployKey([supplied, other]),
      mock,
      (service) =>
        Effect.gen(function* () {
          const served = yield* Effect.all([
            service.api(own.url),
            service.deployKey(own),
            service.api(deployment.url),
            service.deployKey(deployment),
          ]);
          expect(served).toEqual([supplied, supplied, other, other]);
          expect(called(mock)).toEqual([]);
        }),
    );
  });

  it.effect(
    "refuses a deployment none of several supplied keys names before any call",
    () => {
      const mock = mockClient();
      const third = {
        name: "quiet-heron-789",
        url: "https://quiet-heron-789.convex.cloud",
      };
      return withAccess(
        DeploymentAccess.deployKey([supplied, other]),
        mock,
        (service) =>
          Effect.gen(function* () {
            for (const request of [
              service.api(third.url),
              service.deployKey(third),
            ]) {
              const error = yield* Effect.flip(request);
              assert(error._tag === "DeploymentAccessRefused");
              expect(error.reason).toBe("OtherDeployment");
              expect(error.deploymentName).toBe(third.name);
              expect(inspect(error)).not.toContain("secret");
            }
            expect(called(mock)).toEqual([]);
          }),
      );
    },
  );

  it.effect("refuses two supplied keys that name one deployment", () => {
    const mock = mockClient();
    const twin = Redacted.make("prod:brave-fox-456|twin-secret");
    return withAccess(
      DeploymentAccess.deployKey([supplied, other, twin]),
      mock,
      (service) =>
        Effect.gen(function* () {
          for (const request of [
            service.api(deployment.url),
            service.deployKey(deployment),
          ]) {
            const error = yield* Effect.flip(request);
            assert(error._tag === "DeploymentAccessRefused");
            expect(error.reason).toBe("DuplicateDeployment");
            expect(error.deploymentName).toBe("brave-fox-456");
            expect(inspect(error)).not.toContain("secret");
          }
          expect(called(mock)).toEqual([]);
        }),
    );
  });

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
