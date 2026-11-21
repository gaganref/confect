import { assert, describe, expect, it } from "@effect/vitest";
import * as DeploymentAccess from "@confect/alchemy/DeploymentAccess";
import * as ConvexClientModule from "@confect/alchemy/ConvexClient";
import {
  ConvexApiError,
  ConvexClient,
  type DeployKey,
} from "@confect/alchemy/ConvexClient";
import * as EnvironmentVariables from "@confect/alchemy/EnvironmentVariables";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { Stack } from "alchemy/Stack";
import * as Array from "effect/Array";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Record from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { inspect } from "node:util";
import {
  key as listedKey,
  lifecycle,
  mockClient,
} from "./fixtures/ConvexClient";
import { recordSpans } from "./fixtures/Spans";
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
        expect(called(mock)).toEqual(["getTokenDetails"]);
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
          expect(error.message).toContain("may have left");
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
    "leaves a key another actor adds during the check alone and uses the returned key",
    () => {
      const mock = mockClient({ oauthToken: "oauth-login-token" });
      mock.client.createDeployKey.mockImplementationOnce((name) =>
        Effect.sync(() => {
          mock.state.keys.push(listedKey({ id: 99, name: "someone-else" }));
          return {
            deployKey: Redacted.make(`dev:${name}|oauth-login-token`),
            reusesLogin: true,
          };
        }),
      );
      return withAccess(DeploymentAccess.grant, mock, (service) =>
        Effect.gen(function* () {
          const key = yield* service.deployKey(deployment);
          expect(Redacted.value(key)).toBe(
            "dev:happy-otter-123|oauth-login-token",
          );
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

describe("DeploymentAccess grant outcomes", () => {
  const login = "project:team-a:project-b|LoginTokenPart0123456789";
  const loginSecret = "LoginTokenPart0123456789";
  const mintedSecret = "MintedKeySecret0123456789";
  const forms = {
    wholeLogin: `dev:happy-otter-123|${login}`,
    loginSecret: `dev:happy-otter-123|${loginSecret}`,
    other: `dev:happy-otter-123|${mintedSecret}`,
  };
  const generated = "confect-alchemy-access-0123456789abcdef0123456789abcdef";

  interface Api {
    readonly scope?: "teamToken" | "projectToken";
    readonly rows?: ReadonlyArray<DeployKey>;
    /**
     * The deploy key `create_deploy_key` answers.
     */
    readonly returned: string;
    /**
     * Rows the create adds, given the requested name and the create's index.
     */
    readonly adds?: (
      keyName: string,
      create: number,
    ) => ReadonlyArray<DeployKey>;
    /**
     * A failed answer to the listing with this index, counting from 0.
     */
    readonly failListing?: (listing: number) => Response | undefined;
  }

  /**
   * A fake management API behind the real client and access layer.
   */
  const fakeApi = (api: Api) => {
    const state = {
      rows: [...(api.rows ?? [])],
      requests: [] as string[],
      deleted: [] as string[],
      creates: 0,
      listings: 0,
    };
    const respond = Effect.fnUntraced(function* (
      request: HttpClientRequest.HttpClientRequest,
    ) {
      const path = new URL(request.url).pathname;
      state.requests.push(`${request.method} ${path}`);
      const body =
        request.body._tag === "Uint8Array"
          ? yield* Schema.decodeEffect(
              Schema.fromJsonString(
                Schema.Struct({
                  name: Schema.optionalKey(Schema.String),
                  id: Schema.optionalKey(Schema.String),
                }),
              ),
            )(new TextDecoder().decode(request.body.body))
          : {};
      switch (path) {
        case "/v1/token_details":
          return Response.json({
            id: 11,
            name: "login",
            createTime: 0,
            ...(api.scope === "teamToken"
              ? { type: "teamToken", teamId: 10 }
              : { type: "projectToken", projectId: 1 }),
          });
        case "/v1/deployments/happy-otter-123/list_deploy_keys": {
          const failed = api.failListing?.(state.listings++);
          return failed ?? Response.json(state.rows);
        }
        case "/v1/deployments/happy-otter-123/create_deploy_key":
          state.rows.push(...(api.adds?.(body.name!, state.creates++) ?? []));
          return Response.json({ deployKey: api.returned });
        case "/v1/deployments/happy-otter-123/delete_deploy_key":
          state.deleted.push(body.id!);
          state.rows = Array.filter(state.rows, (row) => row.name !== body.id);
          return new Response(null, { status: 200 });
      }
      return yield* Effect.die(`Unexpected request ${request.method} ${path}`);
    });
    const http = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        respond(request).pipe(
          Effect.map((response) =>
            HttpClientResponse.fromWeb(request, response),
          ),
          Effect.orDie,
        ),
      ),
    );
    return { state, http };
  };

  /**
   * One run: a fresh access layer and client over `fake`, with every span and
   * debug log recorded.
   */
  const grantRun = <A, E>(
    fake: ReturnType<typeof fakeApi>,
    body: (
      service: DeploymentAccess.DeploymentAccess["Service"],
    ) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const spans = yield* recordSpans;
      const logs: string[] = [];
      const services = yield* Layer.build(
        DeploymentAccess.layer(DeploymentAccess.grant).pipe(
          Layer.provide(
            ConvexClientModule.layer({ token: Redacted.make(login) }),
          ),
          Layer.provide(fake.http),
        ),
      );
      const exit = yield* DeploymentAccess.DeploymentAccess.pipe(
        Effect.flatMap(body),
        Effect.provideContext(services),
        Effect.withTracer(spans.tracer),
        Effect.provideService(
          Logger.CurrentLoggers,
          new Set([
            Logger.make(({ message, logLevel }) => {
              logs.push(`${logLevel} ${inspect(message)}`);
            }),
          ]),
        ),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
        Effect.exit,
      );
      return { exit, spans: spans.text(), logs };
    }).pipe(Effect.scoped);

  const row = (id: number, name: string, oauth = false) =>
    listedKey({
      id,
      name,
      ...(oauth ? { managedBy: { oauthApp: "some-app" } } : {}),
    });
  const attempt = (keyName: string) => row(500, keyName);
  const suffixed = (keyName: string) => row(501, `${keyName} (0a1b2c3d)`);
  const foreign = (oauth: boolean) => (_: string, create: number) => [
    row(600 + create, `grant-${create}`, oauth),
  ];

  type Outcome =
    | { readonly ok: true }
    | {
        readonly tag: "DeploymentGrantRefused" | "DeploymentGrantUnproven";
        readonly reason: string;
        readonly deleted?: boolean;
      };

  const cases: ReadonlyArray<{
    readonly name: string;
    readonly api: Api;
    readonly runs?: number;
    readonly outcome: Outcome;
    readonly deletes?: "attempt" | "none";
    readonly unconfirmedLog?: boolean;
  }> = [
    {
      name: "a returned key whose secret is the whole login",
      api: { returned: forms.wholeLogin },
      outcome: { ok: true },
    },
    {
      name: "a returned key whose secret is the login's secret part",
      api: { returned: forms.loginSecret },
      outcome: { ok: true },
    },
    {
      name: "a different returned key and no row under the attempt's name",
      api: { returned: forms.other },
      outcome: { ok: true },
      unconfirmedLog: true,
    },
    {
      name: "a different returned key and a row under the attempt's name",
      api: { returned: forms.other, adds: (name) => [attempt(name)] },
      outcome: {
        tag: "DeploymentGrantUnproven",
        reason: "Minted",
        deleted: true,
      },
      deletes: "attempt",
    },
    {
      name: "a different returned key and a row under the attempt's suffixed name",
      api: { returned: forms.other, adds: (name) => [suffixed(name)] },
      outcome: {
        tag: "DeploymentGrantUnproven",
        reason: "Minted",
        deleted: true,
      },
      deletes: "attempt",
    },
    {
      name: "the login returned and a row under the attempt's name",
      api: { returned: forms.loginSecret, adds: (name) => [attempt(name)] },
      outcome: {
        tag: "DeploymentGrantUnproven",
        reason: "Minted",
        deleted: true,
      },
      deletes: "attempt",
    },
    {
      name: "the login returned and a plain row added under another name once",
      api: {
        returned: forms.loginSecret,
        adds: (name, create) => (create === 0 ? foreign(false)(name, 0) : []),
      },
      runs: 2,
      outcome: { ok: true },
    },
    {
      name: "the login returned and an OAuth row added under another name once",
      api: {
        returned: forms.loginSecret,
        adds: (name, create) => (create === 0 ? foreign(true)(name, 0) : []),
      },
      runs: 2,
      outcome: { ok: true },
    },
    {
      name: "the login returned and a plain row added under another name on every create",
      api: { returned: forms.loginSecret, adds: foreign(false) },
      runs: 3,
      outcome: { ok: true },
    },
    {
      name: "the login returned and an OAuth row added under another name on every create",
      api: { returned: forms.loginSecret, adds: foreign(true) },
      runs: 3,
      outcome: { ok: true },
    },
    {
      name: "a different returned key and an OAuth row added under another name on every create",
      api: { returned: forms.other, adds: foreign(true) },
      runs: 3,
      outcome: { ok: true },
      unconfirmedLog: true,
    },
    {
      name: "the login returned and a failed second listing",
      api: {
        returned: forms.loginSecret,
        failListing: (n) =>
          n === 1 ? new Response(null, { status: 503 }) : undefined,
      },
      outcome: { ok: true },
    },
    {
      name: "a different returned key and a failed second listing",
      api: {
        returned: forms.other,
        failListing: (n) =>
          n === 1 ? new Response(null, { status: 503 }) : undefined,
      },
      outcome: { tag: "DeploymentGrantUnproven", reason: "ListingFailed" },
    },
    {
      name: "a possible leftover under the generated grammar",
      api: { returned: forms.loginSecret, rows: [row(3, generated)] },
      outcome: { tag: "DeploymentGrantRefused", reason: "LeftoverKeys" },
    },
    {
      name: "a possible leftover under the generated grammar with Convex's suffix",
      api: {
        returned: forms.loginSecret,
        rows: [row(3, `${generated} (0a1b2c3d)`)],
      },
      outcome: { tag: "DeploymentGrantRefused", reason: "LeftoverKeys" },
    },
    {
      name: "a possible leftover under the first version's fixed name",
      api: {
        returned: forms.loginSecret,
        rows: [row(3, "confect-alchemy-access")],
      },
      outcome: { tag: "DeploymentGrantRefused", reason: "LeftoverKeys" },
    },
    {
      name: "a foreign name with the same prefix",
      api: {
        returned: forms.loginSecret,
        rows: [
          row(3, "confect-alchemy-access-ci-main", true),
          row(4, `${generated}0`),
          row(5, "confect-alchemy-access-0123456789ABCDEF0123456789ABCDEF"),
        ],
      },
      outcome: { ok: true },
    },
  ];

  it.effect.each(cases)(
    "$name",
    ({ api, runs = 1, outcome, deletes = "none", unconfirmedLog = false }) =>
      Effect.gen(function* () {
        const fake = fakeApi(api);
        const before = Array.map(fake.state.rows, (each) => each.name);
        for (let run = 0; run < runs; run++) {
          const { exit, spans, logs } = yield* grantRun(fake, (service) =>
            service.deployKey(deployment),
          );
          const shown = [
            inspect(exit, { depth: null }),
            Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "",
            spans,
            ...logs,
          ];
          for (const text of shown) {
            expect(text).not.toContain(loginSecret);
            expect(text).not.toContain(mintedSecret);
          }
          if ("ok" in outcome) {
            assertIs(exit, Exit.isSuccess);
            expect(Redacted.value(exit.value)).toBe(api.returned);
          } else {
            assertIs(exit, Exit.isFailure);
            const error = Cause.squash(exit.cause);
            expect(error).toMatchObject({
              _tag: outcome.tag,
              reason: outcome.reason,
              ...(outcome.deleted === undefined
                ? {}
                : { deleted: outcome.deleted }),
            });
          }
          const unconfirmed = Array.filter(logs, (line) =>
            Str.includes("not confirmed by comparison")(line),
          );
          expect(unconfirmed).toHaveLength(unconfirmedLog ? 1 : 0);
          if (unconfirmedLog) expect(unconfirmed[0]).toMatch(/^DEBUG /i);
        }
        const requested = Array.filter(fake.state.requests, (request) =>
          Str.endsWith("/create_deploy_key")(request),
        );
        expect(fake.state.deleted).toHaveLength(deletes === "attempt" ? 1 : 0);
        if (deletes === "attempt")
          expect(fake.state.deleted[0]).toMatch(
            /^confect-alchemy-access-[0-9a-f]{32}(?: \(0a1b2c3d\))?$/,
          );
        for (const name of before)
          expect(Array.map(fake.state.rows, (each) => each.name)).toContain(
            name,
          );
        if ("ok" in outcome || outcome.reason !== "LeftoverKeys")
          expect(requested).toHaveLength(runs);
        else expect(requested).toHaveLength(0);
      }),
  );

  it.effect(
    "names possible leftovers without claiming who made them or asking to delete unchecked",
    () =>
      Effect.gen(function* () {
        const fake = fakeApi({
          returned: forms.loginSecret,
          rows: [row(3, generated), row(4, "confect-alchemy-access-ci-main")],
        });
        const { exit } = yield* grantRun(fake, (service) =>
          service.deployKey(deployment),
        );
        assertIs(exit, Exit.isFailure);
        const error = Cause.squash(exit.cause);
        assert(Schema.is(DeploymentAccess.DeploymentGrantRefused)(error));
        expect(error.keyNames).toEqual([generated]);
        expect(error.message).toContain(generated);
        expect(error.message).not.toContain("confect-alchemy-access-ci-main");
        expect(error.message).toContain("may have left");
        expect(error.message).toContain("before you delete");
        expect(error.message).not.toContain("earlier grant check created");
        expect(error.message).toContain("DeploymentAccess.deployKey");
      }),
  );

  it.effect(
    "keeps a returned key that is not the login out of a failed second listing's echo",
    () =>
      Effect.gen(function* () {
        const fake = fakeApi({
          returned: forms.other,
          failListing: (n) =>
            n === 1
              ? Response.json({ code: mintedSecret }, { status: 503 })
              : undefined,
        });
        const { exit, spans } = yield* grantRun(fake, (service) =>
          service.deployKey(deployment),
        );
        assertIs(exit, Exit.isFailure);
        const error = Cause.squash(exit.cause);
        assert(Schema.is(DeploymentAccess.DeploymentGrantUnproven)(error));
        expect(error.reason).toBe("ListingFailed");
        assert(Schema.is(ConvexApiError)(error.cause));
        expect(error.cause.status).toBe(503);
        expect(error.cause.serverCode).toBeUndefined();
        expect(fake.state.requests).toEqual([
          "GET /v1/token_details",
          "GET /v1/deployments/happy-otter-123/list_deploy_keys",
          "POST /v1/deployments/happy-otter-123/create_deploy_key",
          "GET /v1/deployments/happy-otter-123/list_deploy_keys",
        ]);
        expect(spans).toContain("ConvexClient.listDeployKeys");
        for (const text of [
          inspect(exit, { depth: null }),
          inspect(error.cause, { depth: null }),
          Cause.pretty(exit.cause),
          error.message,
          spans,
        ])
          expect(text).not.toContain(mintedSecret);
      }),
  );
});

describe("DeploymentAccess grant scope", () => {
  const url = deployment.url;

  it.effect("refuses a team-scoped login on the deployment API path", () => {
    const mock = mockClient();
    return withAccess(DeploymentAccess.grant, mock, (service) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(service.api(url));
        assert(error._tag === "DeploymentGrantRefused");
        expect(error.reason).toBe("TeamScoped");
        expect(error.deploymentName).toBe(deployment.name);
        expect(called(mock)).toEqual(["getTokenDetails"]);
      }),
    );
  });

  it.effect(
    "checks the scope once for the deployment API and the push together",
    () => {
      const mock = mockClient({ oauthToken: "oauth-login-token" });
      return withAccess(DeploymentAccess.grant, mock, (service) =>
        Effect.gen(function* () {
          const first = yield* service.api(url);
          yield* service.deployKey(deployment);
          const again = yield* service.api(url);
          expect([first, again]).toEqual([undefined, undefined]);
          expect(mock.client.getTokenDetails).toHaveBeenCalledTimes(1);
        }),
      );
    },
  );

  it.effect(
    "refuses an environment-only apply under a team-scoped login before its update",
    () => {
      const mock = mockClient();
      return Effect.gen(function* () {
        const services = yield* Layer.build(
          DeploymentAccess.layer(DeploymentAccess.grant).pipe(
            Layer.provideMerge(Layer.succeed(ConvexClient, mock.client)),
          ),
        );
        const provider = yield* EnvironmentVariables.provider.pipe(
          Effect.provideContext(services),
        );
        const error = yield* Effect.flip(
          provider.reconcile({
            ...lifecycle,
            news: { url, variables: { MANAGED: Redacted.make("value") } },
            olds: undefined,
            output: undefined,
          }),
        );
        expect(error).toMatchObject({
          _tag: "DeploymentGrantRefused",
          reason: "TeamScoped",
        });
        expect(error.message).toContain("nothing was sent");
        expect(called(mock)).toEqual(["getTokenDetails"]);
        expect(mock.state.environmentUpdates).toEqual([]);
      }).pipe(Effect.scoped);
    },
  );
});
