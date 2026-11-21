import type * as DeploymentApi from "@convex-dev/platform/deploymentApi";
import { expectTypeOf } from "@effect/vitest";
import type * as LogStreamDecoder from "../src/internal/LogStream";
import * as ConvexClient from "@confect/alchemy/ConvexClient";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Exit from "effect/Exit";
import { recordSpans } from "./fixtures/Spans";
import { assertIs } from "./internal/assertIs";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { inspect } from "node:util";
import * as Arr from "effect/Array";
import * as Str from "effect/String";

const token = Redacted.make("management-secret-for-tests");
const deployKey = Redacted.make("deployment-secret-for-tests");
const clientLayer = ConvexClient.layer({ token });
const deploymentUrl = "https://happy-otter-123.eu-west-1.convex.cloud";

const project = {
  id: 42,
  teamId: 7,
  name: "Example",
  slug: "example",
  teamSlug: "team",
  createTime: 100,
} satisfies ConvexClient.Project;

const deployment = {
  kind: "cloud",
  id: 43,
  name: "happy-otter-123",
  projectId: 42,
  deploymentType: "custom",
  region: "aws-eu-west-1",
  class: "s16",
  isDefault: false,
  reference: "branch/main",
  createTime: 100,
  deploymentUrl,
} satisfies ConvexClient.Deployment;

const mockHttp = (responses: readonly Response[]) => {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const client = HttpClient.make((request) => {
    const response = responses[requests.length];
    requests.push(request);
    return response === undefined
      ? Effect.die("Unexpected HTTP request")
      : Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });
  return { requests, layer: Layer.succeed(HttpClient.HttpClient, client) };
};

const requestBody = (
  request: HttpClientRequest.HttpClientRequest | undefined,
): Effect.Effect<unknown, Schema.SchemaError> =>
  request?.body._tag === "Uint8Array"
    ? Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
        new TextDecoder().decode(request.body.body),
      )
    : Effect.undefined;

const expectSecretSafe = Effect.fnUntraced(function* (
  value: unknown,
  secret: string,
) {
  const json = yield* Schema.encodeUnknownEffect(
    Schema.fromJsonString(Schema.Unknown),
  )(value);
  expect(json).not.toContain(secret);
  expect(String(value)).not.toContain(secret);
  expect(inspect(value)).not.toContain(secret);
});

describe("ConvexClient", () => {
  it.effect.each(["ap-southeast-2", "ca-central-1"] as const)(
    "supports the %s cloud region",
    (region) => {
      const url = `https://happy-otter-123.${region}.convex.cloud`;
      const regional = {
        ...deployment,
        region: `aws-${region}`,
        deploymentUrl: url,
      };
      const http = mockHttp([
        Response.json(regional),
        Response.json({ environmentVariables: {} }),
      ]);
      return Effect.gen(function* () {
        const services = yield* Layer.build(
          clientLayer.pipe(Layer.provide(http.layer)),
        );
        return yield* Effect.gen(function* () {
          const client = yield* ConvexClient.ConvexClient;
          const deployment2 = yield* client.getDeployment(deployment.name);
          expect(deployment2).toEqual(regional);
          const environmentVariables = yield* client.listEnvironmentVariables(
            url,
            deployKey,
          );
          expect(environmentVariables).toEqual({});
          expect(http.requests[1]?.url).toBe(
            `${url}/api/v1/list_environment_variables`,
          );
        }).pipe(Effect.provideContext(services));
      });
    },
  );

  it.effect(
    "paginates all projects and authenticates management requests",
    () => {
      const secondProject = { ...project, id: 41 };
      const http = mockHttp([
        Response.json({
          items: [project],
          pagination: { hasMore: true, nextCursor: "next/+" },
        }),
        Response.json({
          items: [secondProject],
          pagination: { hasMore: false },
        }),
      ]);
      return Effect.gen(function* () {
        const services2 = yield* Layer.build(
          clientLayer.pipe(Layer.provide(http.layer)),
        );
        return yield* Effect.gen(function* () {
          const client = yield* ConvexClient.ConvexClient;
          const projects = yield* client.listProjects(7);
          expect(projects).toEqual([project, secondProject]);
          expect(Arr.map(http.requests, (request) => request.url)).toEqual([
            "https://api.convex.dev/v1/teams/7/projects",
            "https://api.convex.dev/v1/teams/7/projects?cursor=next%2F%2B",
          ]);
          for (const request of http.requests) {
            expect(request.method).toBe("GET");
            expect(request.headers.authorization).toBe(
              `Bearer ${Redacted.value(token)}`,
            );
          }
        }).pipe(Effect.provideContext(services2));
      });
    },
  );

  it.effect("rejects incomplete and repeated pagination cursors", () => {
    const http = mockHttp([
      Response.json({ items: [], pagination: { hasMore: true } }),
      Response.json({
        items: [],
        pagination: { hasMore: true, nextCursor: "same" },
      }),
      Response.json({
        items: [],
        pagination: { hasMore: true, nextCursor: "same" },
      }),
    ]);
    return Effect.gen(function* () {
      const services3 = yield* Layer.build(
        clientLayer.pipe(Layer.provide(http.layer)),
      );
      return yield* Effect.gen(function* () {
        const client = yield* ConvexClient.ConvexClient;
        const projects = yield* client.listProjects(7).pipe(Effect.flip);
        expect(projects).toMatchObject({
          code: "InvalidPagination",
        });
        const projects2 = yield* client.listProjects(7).pipe(Effect.flip);
        expect(projects2).toMatchObject({
          code: "InvalidPagination",
        });
        expect(http.requests).toHaveLength(3);
      }).pipe(Effect.provideContext(services3));
    });
  });

  it.effect(
    "uses the official project create, get, patch, and delete contracts",
    () => {
      const created = { id: 42, projectId: 42, slug: "example" };
      const http = mockHttp([
        Response.json(created),
        Response.json(project),
        Response.json({ ...project, name: "Renamed" }),
        new Response(null, { status: 200 }),
      ]);
      const createInput = { projectName: "Example" };
      const updateInput = { name: "Renamed" };
      return Effect.gen(function* () {
        const services4 = yield* Layer.build(
          clientLayer.pipe(Layer.provide(http.layer)),
        );
        return yield* Effect.gen(function* () {
          const client = yield* ConvexClient.ConvexClient;
          const project2 = yield* client.createProject(7, createInput);
          expect(project2).toEqual(created);
          const project3 = yield* client.getProject(42);
          expect(project3).toEqual(project);
          const updateProject2 = yield* client.updateProject(42, updateInput);
          expect(updateProject2).toEqual({
            ...project,
            name: "Renamed",
          });
          const deleteProject2 = yield* client.deleteProject(42);
          expect(deleteProject2).toBeUndefined();
          expect(
            Arr.map(http.requests, ({ method, url }) => [method, url]),
          ).toEqual([
            ["POST", "https://api.convex.dev/v1/teams/7/create_project"],
            ["GET", "https://api.convex.dev/v1/projects/42"],
            ["PATCH", "https://api.convex.dev/v1/projects/42"],
            ["POST", "https://api.convex.dev/v1/projects/42/delete"],
          ]);
          const requestBodyResult = yield* requestBody(http.requests[0]);
          expect(requestBodyResult).toEqual(createInput);
          const requestBodyResult2 = yield* requestBody(http.requests[2]);
          expect(requestBodyResult2).toEqual(updateInput);
          expect(createInput).toEqual({ projectName: "Example" });
          expect(updateInput).toEqual({ name: "Renamed" });
        }).pipe(Effect.provideContext(services4));
      });
    },
  );

  it.effect(
    "uses deployment endpoints and validates cloud and local responses",
    () => {
      const local = {
        kind: "local",
        name: "local-instance",
        createTime: 100,
        deploymentType: "dev",
        projectId: 42,
        creator: 1,
        port: 3210,
        deviceName: "laptop",
        isActive: true,
      } satisfies ConvexClient.Deployment;
      const http = mockHttp([
        Response.json([deployment, local]),
        Response.json(deployment),
        Response.json(deployment),
        new Response(null, { status: 200 }),
        new Response(null, { status: 204 }),
      ]);
      const input = {
        type: "custom",
        reference: "branch/main",
        region: "aws-eu-west-1",
        class: "s16",
      } satisfies ConvexClient.CreateDeploymentInput;
      const update = {
        reference: "branch/next",
        expiresAt: null,
        sendLogsToClient: false,
      };
      return Effect.gen(function* () {
        const services5 = yield* Layer.build(
          clientLayer.pipe(Layer.provide(http.layer)),
        );
        return yield* Effect.gen(function* () {
          const client = yield* ConvexClient.ConvexClient;
          const deployments = yield* client.listDeployments(42);
          expect(deployments).toEqual([deployment, local]);
          const deployment2 = yield* client.getDeployment("name/with slash");
          expect(deployment2).toEqual(deployment);
          const deployment3 = yield* client.createDeployment(42, input);
          expect(deployment3).toEqual(deployment);
          const updateDeployment2 = yield* client.updateDeployment(
            deployment.name,
            update,
          );
          expect(updateDeployment2).toBeUndefined();
          const deleteDeployment2 = yield* client.deleteDeployment(
            deployment.name,
          );
          expect(deleteDeployment2).toBeUndefined();
          expect(
            Arr.map(http.requests, ({ method, url }) => [method, url]),
          ).toEqual([
            ["GET", "https://api.convex.dev/v1/projects/42/list_deployments"],
            [
              "GET",
              "https://api.convex.dev/v1/deployments/name%2Fwith%20slash",
            ],
            ["POST", "https://api.convex.dev/v1/projects/42/create_deployment"],
            ["PATCH", "https://api.convex.dev/v1/deployments/happy-otter-123"],
            [
              "POST",
              "https://api.convex.dev/v1/deployments/happy-otter-123/delete",
            ],
          ]);
          const requestBodyResult = yield* requestBody(http.requests[2]);
          expect(requestBodyResult).toEqual(input);
          const requestBodyResult2 = yield* requestBody(http.requests[3]);
          expect(requestBodyResult2).toEqual(update);
        }).pipe(Effect.provideContext(services5));
      });
    },
  );

  it.effect(
    "redacts created deploy keys and preserves safe key metadata",
    () => {
      const key = {
        id: 5,
        name: "automation",
        creationTime: 100,
        allowedActions: [
          "deployment:env:view",
          "deployment:aiGateway:use",
          "deployment:future:action",
        ],
      };
      const http = mockHttp([
        Response.json({ deployKey: Redacted.value(deployKey) }),
        Response.json([key]),
        new Response(null, { status: 200 }),
        new Response(null, { status: 200 }),
      ]);
      const input = {
        name: "automation",
        allowedActions: ["deployment:env:view"],
      } satisfies ConvexClient.CreateDeployKeyInput;
      return Effect.gen(function* () {
        const services6 = yield* Layer.build(
          clientLayer.pipe(Layer.provide(http.layer)),
        );
        return yield* Effect.gen(function* () {
          const client = yield* ConvexClient.ConvexClient;
          const created = yield* client.createDeployKey(deployment.name, input);
          expect(Redacted.value(created.deployKey)).toBe(
            Redacted.value(deployKey),
          );
          yield* expectSecretSafe(created, Redacted.value(deployKey));
          const deployKeys = yield* client.listDeployKeys(deployment.name);
          expect(deployKeys).toEqual([key]);
          yield* client.deleteDeployKey(
            deployment.name,
            "automation (1d26168f)",
          );
          yield* client.deleteDeployKey(deployment.name, key.name);
          expect(Arr.map(http.requests, ({ url }) => url)).toEqual([
            "https://api.convex.dev/v1/deployments/happy-otter-123/create_deploy_key",
            "https://api.convex.dev/v1/deployments/happy-otter-123/list_deploy_keys",
            "https://api.convex.dev/v1/deployments/happy-otter-123/delete_deploy_key",
            "https://api.convex.dev/v1/deployments/happy-otter-123/delete_deploy_key",
          ]);
          const requestBodyResult = yield* requestBody(http.requests[0]);
          expect(requestBodyResult).toEqual(input);
          const requestBodyResult2 = yield* requestBody(http.requests[2]);
          expect(requestBodyResult2).toEqual({ id: "automation (1d26168f)" });
          const requestBodyResult3 = yield* requestBody(http.requests[3]);
          expect(requestBodyResult3).toEqual({
            id: "automation",
          });
          yield* expectSecretSafe(created, Redacted.value(deployKey));
        }).pipe(Effect.provideContext(services6));
      });
    },
  );

  it.effect(
    "does not expose a token the server echoes when revocation fails",
    () => {
      const http = mockHttp([
        Response.json({ message: Redacted.value(deployKey) }, { status: 500 }),
      ]);
      return Effect.gen(function* () {
        const services7 = yield* Layer.build(
          clientLayer.pipe(Layer.provide(http.layer)),
        );
        return yield* Effect.gen(function* () {
          const client = yield* ConvexClient.ConvexClient;
          const error = yield* client
            .deleteDeployKey(deployment.name, "automation")
            .pipe(Effect.flip);
          const requestBodyResult = yield* requestBody(http.requests[0]);
          expect(requestBodyResult).toEqual({ id: "automation" });
          expect(error).toMatchObject({
            operation: "deleteDeployKey",
            status: 500,
            code: "HttpError",
          });
          yield* expectSecretSafe(error, Redacted.value(deployKey));
          expect(http.requests).toHaveLength(1);
        }).pipe(Effect.provideContext(services7));
      });
    },
  );

  it.effect(
    "uses deployment authentication and redacts environment values without a management token",
    () => {
      const secret = "environment-secret-for-tests";
      const http = mockHttp([
        Response.json({ environmentVariables: { API_KEY: secret, EMPTY: "" } }),
        new Response(null, { status: 200 }),
      ]);
      const changes = [
        { name: "API_KEY", value: Redacted.make(secret) },
        { name: "PLAIN", value: "plain" },
        { name: "REMOVE" },
        { name: "NULL_REMOVE", value: null },
      ];
      return Effect.gen(function* () {
        const client = yield* ConvexClient.ConvexClient;
        const values = yield* client.listEnvironmentVariables(
          `${deploymentUrl}/`,
          deployKey,
        );
        const apiKey = values.API_KEY;
        const empty = values.EMPTY;
        if (apiKey === undefined || empty === undefined)
          return yield* Effect.die("Missing environment variables");
        expect(Redacted.value(apiKey)).toBe(secret);
        expect(Redacted.value(empty)).toBe("");
        yield* expectSecretSafe(values, secret);
        yield* client.updateEnvironmentVariables(
          deploymentUrl,
          deployKey,
          changes,
        );
        expect(Arr.map(http.requests, ({ url }) => url)).toEqual([
          `${deploymentUrl}/api/v1/list_environment_variables`,
          `${deploymentUrl}/api/v1/update_environment_variables`,
        ]);
        for (const request of http.requests) {
          expect(request.headers.authorization).toBe(
            `Convex ${Redacted.value(deployKey)}`,
          );
        }
        const requestBodyResult = yield* requestBody(http.requests[1]);
        expect(requestBodyResult).toEqual({
          changes: [
            { name: "API_KEY", value: secret },
            { name: "PLAIN", value: "plain" },
            { name: "REMOVE" },
            { name: "NULL_REMOVE", value: null },
          ],
        });
        expect(changes).toEqual([
          { name: "API_KEY", value: Redacted.make(secret) },
          { name: "PLAIN", value: "plain" },
          { name: "REMOVE" },
          { name: "NULL_REMOVE", value: null },
        ]);
      }).pipe(
        Effect.provide([
          ConvexClient.layer().pipe(Layer.provide(http.layer)),
          ConfigProvider.layer(ConfigProvider.fromUnknown({})),
        ]),
      );
    },
  );

  it.effect("loads management credentials lazily from Config", () => {
    const http = mockHttp([Response.json(project)]);
    return Effect.gen(function* () {
      const client = yield* ConvexClient.ConvexClient;
      yield* client.getProject(42);
      expect(http.requests[0]?.headers.authorization).toBe(
        "Bearer config-token",
      );
    }).pipe(
      Effect.provide([
        ConvexClient.layer().pipe(Layer.provide(http.layer)),
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ CONVEX_ACCESS_TOKEN: "config-token" }),
        ),
      ]),
    );
  });

  it.effect(
    "fails with a sanitized configuration error only when management credentials are needed",
    () => {
      const http = mockHttp([]);
      return Effect.gen(function* () {
        const client = yield* ConvexClient.ConvexClient;
        const project2 = yield* client.getProject(42).pipe(Effect.flip);
        expect(project2).toMatchObject({
          _tag: "ConvexApiError",
          code: "InvalidConfiguration",
        });
        expect(http.requests).toHaveLength(0);
      }).pipe(
        Effect.provide([
          ConvexClient.layer().pipe(Layer.provide(http.layer)),
          ConfigProvider.layer(ConfigProvider.fromUnknown({})),
        ]),
      );
    },
  );

  it.effect(
    "rejects unsafe deployment targets before transmitting keys",
    () => {
      const http = mockHttp([]);
      const urls = [
        "http://happy-otter-123.convex.cloud",
        "https://secret@happy-otter-123.convex.cloud",
        "https://happy-otter-123.convex.cloud/?secret=value",
        "https://happy-otter-123.convex.cloud/#secret",
        "https://happy-otter-123.convex.cloud/path",
        "https://happy-otter-123.convex.cloud:444",
        "https://happy-otter-123.convex.cloud.attacker.example",
        "https://attacker.example",
        "http://127.0.0.1:3300",
        "not a URL",
      ];
      return Effect.gen(function* () {
        const services8 = yield* Layer.build(
          clientLayer.pipe(Layer.provide(http.layer)),
        );
        return yield* Effect.gen(function* () {
          const client = yield* ConvexClient.ConvexClient;
          for (const url of urls) {
            const readError = yield* client
              .listEnvironmentVariables(url, deployKey)
              .pipe(Effect.flip);
            const writeError = yield* client
              .updateEnvironmentVariables(url, deployKey, [])
              .pipe(Effect.flip);
            expect(readError).toMatchObject({ code: "InvalidRequest" });
            expect(writeError).toMatchObject({ code: "InvalidRequest" });
            yield* expectSecretSafe(readError, url);
            yield* expectSecretSafe(writeError, Redacted.value(deployKey));
          }
          expect(http.requests).toHaveLength(0);
        }).pipe(Effect.provideContext(services8));
      });
    },
  );

  it.effect(
    "classifies status failures without retaining bodies or retrying mutations",
    () => {
      const secret = "untrusted-error-body-secret";
      const http = mockHttp(
        Arr.map([404, 409, 401, 429, 500, 302], (status) =>
          Response.json({ code: secret, message: secret }, { status }),
        ),
      );
      return Effect.gen(function* () {
        const services9 = yield* Layer.build(
          clientLayer.pipe(Layer.provide(http.layer)),
        );
        return yield* Effect.gen(function* () {
          const client = yield* ConvexClient.ConvexClient;
          for (const [status, tag] of [
            [404, "ConvexNotFound"],
            [409, "ConvexConflict"],
            [401, "ConvexApiError"],
            [429, "ConvexApiError"],
            [500, "ConvexApiError"],
            [302, "ConvexApiError"],
          ]) {
            const error = yield* client
              .createProject(7, { projectName: "Example" })
              .pipe(Effect.flip);
            expect(error).toMatchObject({
              _tag: tag,
              status,
              operation: "createProject",
              code: "HttpError",
            });
            yield* expectSecretSafe(error, secret);
            yield* expectSecretSafe(error, Redacted.value(token));
          }
          expect(http.requests).toHaveLength(6);
        }).pipe(Effect.provideContext(services9));
      });
    },
  );

  it.effect.each([
    {
      body: {
        code: "OptimisticConcurrencyControlFailure",
        message: "body-secret",
      },
      serverCode: "OptimisticConcurrencyControlFailure",
    },
    { body: { message: "body-secret" }, serverCode: undefined },
    { body: { code: 42 }, serverCode: undefined },
    { body: { code: Str.repeat(64)("A") }, serverCode: Str.repeat(64)("A") },
    { body: { code: Str.repeat(65)("A") }, serverCode: undefined },
    { body: { code: Str.repeat(1_000_000)("a") }, serverCode: undefined },
    {
      body: { code: "prod:happy-otter-123|leaked-key-in-code" },
      serverCode: undefined,
    },
  ])(
    "preserves the server code independently of the HTTP classification ($serverCode)",
    ({ body, serverCode }) => {
      const http = mockHttp([Response.json(body, { status: 503 })]);
      return Effect.gen(function* () {
        const services = yield* Layer.build(
          clientLayer.pipe(Layer.provide(http.layer)),
        );
        return yield* Effect.gen(function* () {
          const client = yield* ConvexClient.ConvexClient;
          const error = yield* client
            .updateEnvironmentVariables(deploymentUrl, deployKey, [])
            .pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag: "ConvexApiError",
            operation: "updateEnvironmentVariables",
            status: 503,
            code: "HttpError",
          });
          expect(error.serverCode).toBe(serverCode);
          expect(error.message).toContain("updateEnvironmentVariables");
          expect(error.message).toContain("503");
          expect(error.message).toContain(serverCode ?? "HttpError");
          yield* expectSecretSafe(error, "body-secret");
        }).pipe(Effect.provideContext(services));
      });
    },
  );

  it.effect.each([404, 409, 503])(
    "preserves validated server codes for function HTTP failures (%s)",
    (status) => {
      const http = mockHttp([
        Response.json(
          {
            code: "OptimisticConcurrencyControlFailure",
            message: "function-body-secret",
          },
          { status },
        ),
      ]);
      return Effect.gen(function* () {
        const services = yield* Layer.build(
          clientLayer.pipe(Layer.provide(http.layer)),
        );
        return yield* Effect.gen(function* () {
          const client = yield* ConvexClient.ConvexClient;
          const error = yield* client
            .runFunction(deploymentUrl, deployKey, "test:run", {})
            .pipe(
              Effect.match({
                onSuccess: () => expect.unreachable("Expected an HTTP error"),
                onFailure: (failure) => failure,
              }),
            );
          expect(error).toMatchObject({
            _tag:
              status === 404
                ? "ConvexNotFound"
                : status === 409
                  ? "ConvexConflict"
                  : "ConvexApiError",
            operation: "runFunction",
            status,
            code: "HttpError",
            serverCode: "OptimisticConcurrencyControlFailure",
          });
          yield* expectSecretSafe(error, "function-body-secret");
        }).pipe(Effect.provideContext(services));
      });
    },
  );

  it.effect("keeps a legitimate server code with an empty credential", () => {
    const http = mockHttp([
      Response.json({ code: "SafeServerCode" }, { status: 503 }),
    ]);
    return Effect.gen(function* () {
      const services = yield* Layer.build(
        clientLayer.pipe(Layer.provide(http.layer)),
      );
      return yield* Effect.gen(function* () {
        const client = yield* ConvexClient.ConvexClient;
        const error = yield* client
          .runFunction(deploymentUrl, Redacted.make(""), "test:run", {})
          .pipe(
            Effect.match({
              onSuccess: () => expect.unreachable("Expected an HTTP error"),
              onFailure: (failure) => failure,
            }),
          );
        expect(error).toMatchObject({
          _tag: "ConvexApiError",
          status: 503,
          code: "HttpError",
          serverCode: "SafeServerCode",
        });
      }).pipe(Effect.provideContext(services));
    });
  });

  it.effect("limits error body reads to 8 KiB before parsing", () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(new TextEncoder().encode(Str.repeat(1024)(" ")));
          if (pulls === 20) {
            controller.enqueue(
              new TextEncoder().encode('{"code":"TestFailure"}'),
            );
            controller.close();
          }
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const http = mockHttp([new Response(body, { status: 503 })]);
    return Effect.gen(function* () {
      const services = yield* Layer.build(
        clientLayer.pipe(Layer.provide(http.layer)),
      );
      return yield* Effect.gen(function* () {
        const client = yield* ConvexClient.ConvexClient;
        const error = yield* client
          .updateEnvironmentVariables(deploymentUrl, deployKey, [])
          .pipe(Effect.flip);
        expect(error).toMatchObject({ code: "HttpError", status: 503 });
        expect(error.serverCode).toBeUndefined();
        expect(pulls).toBeLessThanOrEqual(9);
        expect(cancelled).toBe(true);
      }).pipe(Effect.provideContext(services));
    });
  });

  it.effect(
    "times out an error body that never finishes after five seconds",
    () => {
      const secret = "unfinished-body-secret";
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(`{"message":"${secret}"`),
          );
        },
        cancel() {
          cancelled = true;
        },
      });
      const http = mockHttp([new Response(body, { status: 503 })]);
      return Effect.gen(function* () {
        const services = yield* Layer.build(
          clientLayer.pipe(Layer.provide(http.layer)),
        );
        return yield* Effect.gen(function* () {
          const client = yield* ConvexClient.ConvexClient;
          const fiber = yield* client
            .updateEnvironmentVariables(deploymentUrl, deployKey, [])
            .pipe(Effect.flip, Effect.forkScoped);
          yield* TestClock.adjust("4999 millis");
          expect(fiber.pollUnsafe()).toBeUndefined();
          yield* TestClock.adjust("1 millis");
          expect(fiber.pollUnsafe()).toBeDefined();
          const error = yield* Fiber.join(fiber);
          expect(error).toMatchObject({ code: "HttpError", status: 503 });
          expect(error.serverCode).toBeUndefined();
          expect(cancelled).toBe(true);
          yield* expectSecretSafe(error, secret);
        }).pipe(Effect.provideContext(services));
      });
    },
  );

  it.effect("ignores non-JSON error bodies", () => {
    const http = mockHttp([new Response("body-secret", { status: 503 })]);
    return Effect.gen(function* () {
      const services = yield* Layer.build(
        clientLayer.pipe(Layer.provide(http.layer)),
      );
      return yield* Effect.gen(function* () {
        const client = yield* ConvexClient.ConvexClient;
        const error = yield* client
          .updateEnvironmentVariables(deploymentUrl, deployKey, [])
          .pipe(Effect.flip);
        expect(error.code).toBe("HttpError");
        expect(error.serverCode).toBeUndefined();
        yield* expectSecretSafe(error, "body-secret");
      }).pipe(Effect.provideContext(services));
    });
  });

  it.effect(
    "keeps missing reads and deletes in the typed not-found channel",
    () => {
      const http = mockHttp(
        Array.from({ length: 4 }, () => new Response(null, { status: 404 })),
      );
      return Effect.gen(function* () {
        const services10 = yield* Layer.build(
          clientLayer.pipe(Layer.provide(http.layer)),
        );
        return yield* Effect.gen(function* () {
          const client = yield* ConvexClient.ConvexClient;
          for (const operation of [
            client.getProject(42).pipe(Effect.asVoid),
            client.deleteProject(42),
            client.getDeployment(deployment.name).pipe(Effect.asVoid),
            client.deleteDeployment(deployment.name),
          ]) {
            const operationResult = yield* operation.pipe(Effect.flip);
            expect(operationResult).toBeInstanceOf(ConvexClient.ConvexNotFound);
          }
        }).pipe(Effect.provideContext(services10));
      });
    },
  );

  it.effect("sanitizes malformed JSON and response validation failures", () => {
    const secret = "malformed-response-secret";
    const http = mockHttp([
      new Response(secret),
      Response.json({ ...project, id: secret }),
      Response.json({ deployKey: { secret } }),
      Response.json({ environmentVariables: { SECRET: { secret } } }),
    ]);
    return Effect.gen(function* () {
      const services11 = yield* Layer.build(
        clientLayer.pipe(Layer.provide(http.layer)),
      );
      return yield* Effect.gen(function* () {
        const client = yield* ConvexClient.ConvexClient;
        for (const operation of [
          client.getProject(42).pipe(Effect.asVoid),
          client.getProject(42).pipe(Effect.asVoid),
          client
            .createDeployKey(deployment.name, { name: "automation" })
            .pipe(Effect.asVoid),
          client
            .listEnvironmentVariables(deploymentUrl, deployKey)
            .pipe(Effect.asVoid),
        ]) {
          const error = yield* operation.pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag: "ConvexApiError",
            status: 200,
            code: "InvalidResponse",
          });
          yield* expectSecretSafe(error, secret);
        }
      }).pipe(Effect.provideContext(services11));
    });
  });

  it.effect(
    "sanitizes transport errors that include credentials and requests",
    () => {
      const secret = "network-secret";
      const transport = HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: { secret },
            }),
          }),
        ),
      );
      return Effect.gen(function* () {
        const services12 = yield* Layer.build(
          clientLayer.pipe(
            Layer.provide(Layer.succeed(HttpClient.HttpClient, transport)),
          ),
        );
        return yield* Effect.gen(function* () {
          const client = yield* ConvexClient.ConvexClient;
          const error = yield* client.getProject(42).pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag: "ConvexApiError",
            code: "TransportError",
          });
          expect(error.message).toBe("getProject failed (TransportError)");
          yield* expectSecretSafe(error, secret);
          yield* expectSecretSafe(error, Redacted.value(token));
        }).pipe(Effect.provideContext(services12));
      });
    },
  );

  describe("credentials in server text", () => {
    const login = "project:team-a:project-b|LoginTokenPart0123456789";
    const tokenPart = "LoginTokenPart0123456789";
    const run = <A, E>(
      responses: readonly Response[],
      body: (
        client: ConvexClient.ConvexClient["Service"],
      ) => Effect.Effect<A, E>,
    ) =>
      Effect.gen(function* () {
        const http = mockHttp(responses);
        const spans = yield* recordSpans;
        const services = yield* Layer.build(
          ConvexClient.layer({ token: Redacted.make(login) }).pipe(
            Layer.provide(http.layer),
          ),
        );
        const exit = yield* ConvexClient.ConvexClient.pipe(
          Effect.flatMap(body),
          Effect.provideContext(services),
          Effect.withTracer(spans.tracer),
          Effect.exit,
        );
        return { exit, spans: spans.text() };
      });
    const expectClean = (exit: Exit.Exit<unknown, unknown>, spans: string) =>
      Effect.gen(function* () {
        expect(Exit.isFailure(exit)).toBe(true);
        expect(spans).toContain("ConvexClient.");
        for (const shown of [
          inspect(exit, { depth: null }),
          Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "",
          spans,
        ])
          expect(shown).not.toContain(tokenPart);
        if (Exit.isFailure(exit))
          yield* expectSecretSafe(Cause.squash(exit.cause), tokenPart);
      });

    it.effect(
      "keeps the login a function error echoes out of the error, its exit and every span",
      () =>
        Effect.gen(function* () {
          const { exit, spans } = yield* run(
            [
              Response.json(project),
              Response.json(
                { status: "error", errorMessage: `init failed for ${login}` },
                { status: 560 },
              ),
            ],
            (client) =>
              client
                .getProject(42)
                .pipe(
                  Effect.andThen(
                    client.runFunction(
                      deploymentUrl,
                      Redacted.make("prod:happy-otter-123|unrelated-key-text"),
                      "init:run",
                      {},
                    ),
                  ),
                ),
          );
          assertIs(exit, Exit.isFailure);
          const error = Cause.squash(exit.cause);
          assert(Schema.is(ConvexClient.ConvexFunctionError)(error));
          expect(error.errorMessage).toContain("init failed for ");
          expect(error.errorMessage).toContain("<REDACTED>");
          yield* expectClean(exit, spans);
        }),
    );

    it.effect(
      "keeps only the token part a function error echoes out of the error and every span",
      () =>
        Effect.gen(function* () {
          const { exit, spans } = yield* run(
            [
              Response.json(
                { status: "error", errorMessage: `bad token ${tokenPart}` },
                { status: 560 },
              ),
            ],
            (client) =>
              client.runFunction(
                deploymentUrl,
                Redacted.make(`dev:happy-otter-123|${login}`),
                "init:run",
                {},
              ),
          );
          assertIs(exit, Exit.isFailure);
          const error = Cause.squash(exit.cause);
          assert(Schema.is(ConvexClient.ConvexFunctionError)(error));
          expect(error.errorMessage).toBe("bad token <REDACTED>");
          yield* expectClean(exit, spans);
        }),
    );

    it.effect(
      "keeps a returned deploy key and a function's answer out of every span",
      () =>
        Effect.gen(function* () {
          const minted = "dev:happy-otter-123|MintedKeySecret0123456789";
          const http = mockHttp([
            Response.json({ deployKey: minted }),
            Response.json({ status: "success", value: `echo ${tokenPart}` }),
          ]);
          const spans = yield* recordSpans;
          const services = yield* Layer.build(
            ConvexClient.layer({ token: Redacted.make(login) }).pipe(
              Layer.provide(http.layer),
            ),
          );
          const [created, answer] = yield* ConvexClient.ConvexClient.pipe(
            Effect.flatMap((client) =>
              Effect.all([
                client.createDeployKey("happy-otter-123", { name: "ci" }),
                client.runFunction(
                  deploymentUrl,
                  Redacted.make(`dev:happy-otter-123|${login}`),
                  "health:digest",
                  {},
                ),
              ]),
            ),
            Effect.provideContext(services),
            Effect.withTracer(spans.tracer),
          );
          expect(Redacted.value(created.deployKey)).toBe(minted);
          expect(answer).toBe(`echo ${tokenPart}`);
          expect(spans.text()).toContain("ConvexClient.createDeployKey");
          expect(spans.text()).toContain("ConvexClient.runFunction");
          expect(spans.text()).not.toContain("MintedKeySecret0123456789");
          expect(spans.text()).not.toContain(tokenPart);
        }),
    );

    it.effect("drops a server code that is the login's token part", () =>
      Effect.gen(function* () {
        const { exit, spans } = yield* run(
          [Response.json({ code: tokenPart }, { status: 503 })],
          (client) => client.getProject(42),
        );
        assertIs(exit, Exit.isFailure);
        const error = Cause.squash(exit.cause);
        assert(Schema.is(ConvexClient.ConvexApiError)(error));
        expect(error.status).toBe(503);
        expect(error.serverCode).toBeUndefined();
        yield* expectClean(exit, spans);
      }),
    );
  });

  it.effect("disables automatic redirects on the Fetch transport", () => {
    const requests: (RequestInit | undefined)[] = [];
    const fetch: typeof globalThis.fetch = Object.assign(
      (...[_input, init]: Parameters<typeof globalThis.fetch>) => {
        requests.push(init);
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "https://attacker.example" },
          }),
        );
      },
      { preconnect: () => undefined },
    );
    return Effect.gen(function* () {
      const services13 = yield* Layer.build(
        clientLayer.pipe(Layer.provide(FetchHttpClient.layer)),
      );
      return yield* Effect.gen(function* () {
        const client = yield* ConvexClient.ConvexClient;
        const error = yield* client
          .listEnvironmentVariables(deploymentUrl, deployKey)
          .pipe(Effect.flip);
        expect(error).toMatchObject({ code: "HttpError", status: 302 });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.redirect).toBe("manual");
      }).pipe(Effect.provideContext(services13));
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
  });

  it.effect(
    "sends environment requests from a local client only to a loopback backend",
    () => {
      const http = mockHttp([
        Response.json({ environmentVariables: { ORIGIN: "local" } }),
      ]);
      return Effect.gen(function* () {
        const services14 = yield* Layer.build(
          ConvexClient.layer({ mode: "local" }).pipe(Layer.provide(http.layer)),
        );
        return yield* Effect.gen(function* () {
          const client = yield* ConvexClient.ConvexClient;
          const variables = yield* client.listEnvironmentVariables(
            "http://127.0.0.1:3300",
            deployKey,
          );
          expect(Redacted.value(variables.ORIGIN!)).toBe("local");
          expect(http.requests[0]?.url).toBe(
            "http://127.0.0.1:3300/api/v1/list_environment_variables",
          );
          for (const url of [
            deploymentUrl,
            "http://localhost:3300",
            "http://127.0.0.1:3300/api",
            "http://192.168.1.2:3300",
          ]) {
            const failure = yield* client
              .listEnvironmentVariables(url, deployKey)
              .pipe(Effect.flip);
            expect(failure).toEqual(
              ConvexClient.ConvexApiError.make({
                operation: "listEnvironmentVariables",
                code: "InvalidRequest",
              }),
            );
          }
          expect(http.requests).toHaveLength(1);
        }).pipe(Effect.provideContext(services14));
      });
    },
  );
});

it.effect("uses custom-domain and canonical-URL HTTP contracts", () => {
  const domain = {
    deploymentName: "happy-otter-123",
    domain: "api.example.com",
    requestDestination: "convexCloud" as const,
    creationTime: 100,
    verificationTime: null,
  };
  const urls = {
    convexCloudUrl: "https://api.example.com",
    convexSiteUrl: "https://happy-otter-123.convex.site",
  };
  const http = mockHttp([
    new Response(null, { status: 200 }),
    Response.json({ domains: [domain] }),
    Response.json(urls),
    new Response(null, { status: 200 }),
    new Response(null, { status: 200 }),
    new Response(null, { status: 200 }),
  ]);
  return Effect.gen(function* () {
    const services = yield* Layer.build(
      clientLayer.pipe(Layer.provide(http.layer)),
    );
    return yield* Effect.gen(function* () {
      const client = yield* ConvexClient.ConvexClient;
      const input = {
        domain: domain.domain,
        requestDestination: domain.requestDestination,
      };
      yield* client.createCustomDomain("happy/otter", input);
      const domains = yield* client.listCustomDomains("happy/otter");
      expect(domains).toEqual([domain]);
      const canonicalUrls = yield* client.getCanonicalUrls(deploymentUrl);
      expect(canonicalUrls).toEqual(urls);
      yield* client.updateCanonicalUrl(deploymentUrl, {
        requestDestination: "convexCloud",
        url: "https://api.example.com",
      });
      yield* client.updateCanonicalUrl(deploymentUrl, {
        requestDestination: "convexCloud",
      });
      yield* client.deleteCustomDomain("happy/otter", input);
      expect(
        Arr.map(http.requests, ({ method, url }) => [method, url]),
      ).toEqual([
        [
          "POST",
          "https://api.convex.dev/v1/deployments/happy%2Fotter/create_custom_domain",
        ],
        [
          "GET",
          "https://api.convex.dev/v1/deployments/happy%2Fotter/custom_domains",
        ],
        ["GET", `${deploymentUrl}/api/v1/get_canonical_urls`],
        ["POST", `${deploymentUrl}/api/v1/update_canonical_url`],
        ["POST", `${deploymentUrl}/api/v1/update_canonical_url`],
        [
          "POST",
          "https://api.convex.dev/v1/deployments/happy%2Fotter/delete_custom_domain",
        ],
      ]);
      const createBody = yield* requestBody(http.requests[0]);
      expect(createBody).toEqual(input);
      const setBody = yield* requestBody(http.requests[3]);
      expect(setBody).toEqual({
        requestDestination: "convexCloud",
        url: "https://api.example.com",
      });
      const resetBody = yield* requestBody(http.requests[4]);
      expect(resetBody).toEqual({
        requestDestination: "convexCloud",
      });
      const deleteBody = yield* requestBody(http.requests[5]);
      expect(deleteBody).toEqual(input);
      expect(
        Arr.map(http.requests, (request) => request.headers.authorization),
      ).toEqual([
        "Bearer management-secret-for-tests",
        "Bearer management-secret-for-tests",
        "Convex management-secret-for-tests",
        "Convex management-secret-for-tests",
        "Convex management-secret-for-tests",
        "Bearer management-secret-for-tests",
      ]);
    }).pipe(Effect.provideContext(services));
  });
});

it.effect.each([401, 403, 404, 409])(
  "preserves custom-domain and canonical-URL HTTP status %s without server text",
  (status) => {
    const body = Str.repeat(10000)("private-server-detail");
    const http = mockHttp(
      Array.from({ length: 5 }, () => new Response(body, { status })),
    );
    return Effect.gen(function* () {
      const services = yield* Layer.build(
        clientLayer.pipe(Layer.provide(http.layer)),
      );
      return yield* Effect.gen(function* () {
        const client = yield* ConvexClient.ConvexClient;
        const input = {
          domain: "api.example.com",
          requestDestination: "convexCloud" as const,
        };
        for (const effect of [
          client.listCustomDomains("notes").pipe(Effect.asVoid),
          client.createCustomDomain("notes", input),
          client.deleteCustomDomain("notes", input),
          client.getCanonicalUrls(deploymentUrl).pipe(Effect.asVoid),
          client.updateCanonicalUrl(deploymentUrl, {
            requestDestination: "convexCloud",
          }),
        ]) {
          const error = yield* effect.pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag:
              status === 404
                ? "ConvexNotFound"
                : status === 409
                  ? "ConvexConflict"
                  : "ConvexApiError",
            status,
            code: "HttpError",
          });
          yield* expectSecretSafe(error, "private-server-detail");
        }
      }).pipe(Effect.provideContext(services));
    });
  },
);

it.effect.each([
  {
    domains: [
      {
        deploymentName: "notes",
        domain: "api.example.com",
        requestDestination: "web",
        creationTime: 100,
        verificationTime: null,
      },
    ],
  },
  {
    domains: [
      {
        deploymentName: "notes",
        domain: "api.example.com",
        requestDestination: "convexCloud",
        creationTime: 100,
        verificationTime: "private-server-detail",
      },
    ],
  },
])("rejects malformed custom-domain response $domains", (body) => {
  const http = mockHttp([Response.json(body)]);
  return Effect.gen(function* () {
    const services = yield* Layer.build(
      clientLayer.pipe(Layer.provide(http.layer)),
    );
    return yield* Effect.gen(function* () {
      const client = yield* ConvexClient.ConvexClient;
      const error = yield* client.listCustomDomains("notes").pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "ConvexApiError",
        code: "InvalidResponse",
      });
      yield* expectSecretSafe(error, "private-server-detail");
    }).pipe(Effect.provideContext(services));
  });
});

const webhookStream = {
  id: "stream/+",
  logStreamType: "webhook",
  status: { type: "active" },
  url: "https://logs.example.test",
  format: "jsonl",
  topics: null,
  hmacSecret: "made-up-webhook-hmac",
} as const;

describe("log stream client", () => {
  it.effect("unwraps a credential URL only in webhook HTTP requests", () => {
    const url =
      "https://user:made-up-webhook-password@logs.example.test/made-up-webhook-token";
    const http = mockHttp([
      Response.json({
        id: "one",
        logStreamType: "webhook",
        hmacSecret: "made-up-webhook-hmac",
      }),
      new Response(null, { status: 200 }),
      new Response(url, { status: 400 }),
    ]);
    return Effect.gen(function* () {
      const services = yield* Layer.build(
        clientLayer.pipe(Layer.provide(http.layer)),
      );
      return yield* Effect.gen(function* () {
        const client = yield* ConvexClient.ConvexClient;
        const input = {
          logStreamType: "webhook",
          url: Redacted.make(url),
          format: "jsonl",
        } as const;
        const created = yield* client.createLogStream(
          deploymentUrl,
          deployKey,
          input,
        );
        yield* client.updateLogStream(deploymentUrl, deployKey, "one", input);
        const rejected = yield* client
          .createLogStream(deploymentUrl, deployKey, input)
          .pipe(Effect.result);
        expect(rejected).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ConvexApiError", status: 400 },
        });
        for (const request of http.requests) {
          const body = yield* requestBody(request);
          expect(body).toEqual({
            logStreamType: "webhook",
            url,
            format: "jsonl",
          });
        }
        for (const secret of [
          "made-up-webhook-password",
          "made-up-webhook-token",
          "made-up-webhook-hmac",
        ])
          yield* expectSecretSafe([created, rejected], secret);
      }).pipe(Effect.provideContext(services));
    });
  });

  it.effect.each([
    "",
    Str.repeat(129)("x"),
    "made-up-response-secret\n",
    "<private>",
  ])("rejects an unsafe stream ID without exposing the response", (id) => {
    const body = { ...webhookStream, id };
    const http = mockHttp([
      Response.json(body),
      Response.json(body),
      Response.json([body]),
    ]);
    return Effect.gen(function* () {
      const services = yield* Layer.build(
        clientLayer.pipe(Layer.provide(http.layer)),
      );
      return yield* Effect.gen(function* () {
        const client = yield* ConvexClient.ConvexClient;
        const operations: readonly Effect.Effect<
          unknown,
          ConvexClient.ConvexClientError
        >[] = [
          client.createLogStream(deploymentUrl, deployKey, {
            logStreamType: "webhook",
            url: webhookStream.url,
            format: "jsonl",
          }),
          client.getLogStream(deploymentUrl, deployKey, "stream-1"),
          client.listLogStreams(deploymentUrl, deployKey),
        ];
        for (const operation of operations) {
          const result = yield* operation.pipe(Effect.result);
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "ConvexApiError", code: "InvalidResponse" },
          });
          yield* expectSecretSafe(result, "made-up-response-secret");
          yield* expectSecretSafe(result, webhookStream.hmacSecret);
        }
      }).pipe(Effect.provideContext(services));
    });
  });

  it.effect(
    "uses deployment log stream contracts and redacts returned secrets",
    () => {
      const http = mockHttp([
        Response.json({
          logStreamType: "webhook",
          id: "stream/+",
          hmacSecret: webhookStream.hmacSecret,
        }),
        Response.json(webhookStream),
        Response.json([webhookStream]),
        new Response(null, { status: 200 }),
        new Response(null, { status: 200 }),
      ]);
      return Effect.gen(function* () {
        const services = yield* Layer.build(
          clientLayer.pipe(Layer.provide(http.layer)),
        );
        return yield* Effect.gen(function* () {
          const client = yield* ConvexClient.ConvexClient;
          const created = yield* client.createLogStream(
            deploymentUrl,
            deployKey,
            {
              logStreamType: "webhook",
              url: webhookStream.url,
              format: "jsonl",
            },
          );
          expect(Redacted.value(created)).toEqual({
            logStreamType: "webhook",
            id: "stream/+",
            hmacSecret: webhookStream.hmacSecret,
          });
          const found = yield* client.getLogStream(
            deploymentUrl,
            deployKey,
            "stream/+",
          );
          expect(Redacted.value(found)).toEqual(webhookStream);
          const listed = yield* client.listLogStreams(deploymentUrl, deployKey);
          expect(Arr.map(listed, Redacted.value)).toEqual([webhookStream]);
          yield* client.updateLogStream(deploymentUrl, deployKey, "stream/+", {
            logStreamType: "webhook",
            url: "https://new.example.test",
            topics: null,
          });
          yield* client.deleteLogStream(deploymentUrl, deployKey, "stream/+");
          expect(
            Arr.map(http.requests, ({ method, url }) => [method, url]),
          ).toEqual([
            ["POST", `${deploymentUrl}/api/v1/create_log_stream`],
            ["GET", `${deploymentUrl}/api/v1/get_log_stream/stream%2F%2B`],
            ["GET", `${deploymentUrl}/api/v1/list_log_streams`],
            ["POST", `${deploymentUrl}/api/v1/update_log_stream/stream%2F%2B`],
            ["POST", `${deploymentUrl}/api/v1/delete_log_stream/stream%2F%2B`],
          ]);
          const createBody = yield* requestBody(http.requests[0]);
          expect(createBody).toEqual({
            logStreamType: "webhook",
            url: webhookStream.url,
            format: "jsonl",
          });
          const updateBody = yield* requestBody(http.requests[3]);
          expect(updateBody).toEqual({
            logStreamType: "webhook",
            url: "https://new.example.test",
            topics: null,
          });
          for (const request of http.requests)
            expect(request.headers.authorization).toBe(
              `Convex ${Redacted.value(deployKey)}`,
            );
          for (const result of [created, found, listed])
            yield* expectSecretSafe(result, webhookStream.hmacSecret);
        }).pipe(Effect.provideContext(services));
      });
    },
  );

  it.effect.each([
    {
      logStreamType: "axiom",
      apiKey: Redacted.make("made-up-axiom-key"),
      datasetName: "backend",
      attributes: [{ key: "app", value: "notes" }],
    },
    {
      logStreamType: "sentry",
      dsn: Redacted.make("made-up-sentry-dsn"),
      tags: { app: "notes" },
    },
  ] as const)(
    "unwraps $logStreamType credentials only in requests",
    (input) => {
      const http = mockHttp([
        Response.json({ id: "one", logStreamType: input.logStreamType }),
        new Response(null, { status: 200 }),
      ]);
      return Effect.gen(function* () {
        const services = yield* Layer.build(
          clientLayer.pipe(Layer.provide(http.layer)),
        );
        return yield* Effect.gen(function* () {
          const client = yield* ConvexClient.ConvexClient;
          yield* client.createLogStream(deploymentUrl, deployKey, input);
          yield* client.updateLogStream(deploymentUrl, deployKey, "one", input);
          const expected =
            input.logStreamType === "axiom"
              ? {
                  logStreamType: "axiom",
                  apiKey: "made-up-axiom-key",
                  datasetName: "backend",
                  attributes: [{ key: "app", value: "notes" }],
                }
              : {
                  logStreamType: "sentry",
                  dsn: "made-up-sentry-dsn",
                  tags: { app: "notes" },
                };
          for (const request of http.requests) {
            const body = yield* requestBody(request);
            expect(body).toEqual(expected);
          }
          expect(
            Redacted.isRedacted(
              input.logStreamType === "axiom" ? input.apiKey : input.dsn,
            ),
          ).toBe(true);
        }).pipe(Effect.provideContext(services));
      });
    },
  );

  it.effect.each([401, 403, 404, 409, 500])(
    "keeps HTTP %s distinct and discards secret response bodies",
    (status) => {
      const http = mockHttp([
        new Response("made-up-api-error-secret", { status }),
      ]);
      return Effect.gen(function* () {
        const services = yield* Layer.build(
          clientLayer.pipe(Layer.provide(http.layer)),
        );
        return yield* Effect.gen(function* () {
          const client = yield* ConvexClient.ConvexClient;
          const error = yield* client
            .getLogStream(deploymentUrl, deployKey, "one")
            .pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag:
              status === 404
                ? "ConvexNotFound"
                : status === 409
                  ? "ConvexConflict"
                  : "ConvexApiError",
            status,
          });
          yield* expectSecretSafe(error, "made-up-api-error-secret");
          yield* expectSecretSafe(error, Redacted.value(deployKey));
        }).pipe(Effect.provideContext(services));
      });
    },
  );

  it.effect.each([
    { ...webhookStream, hmacSecret: undefined },
    { ...webhookStream, status: { type: "unknown" } },
    { ...webhookStream, status: { type: "failed" } },
    { ...webhookStream, logStreamType: "unknown" },
    { ...webhookStream, format: "xml" },
    { ...webhookStream, topics: ["unknown"] },
  ])("rejects malformed log stream responses without payloads", (body) => {
    const http = mockHttp([Response.json(body)]);
    return Effect.gen(function* () {
      const services = yield* Layer.build(
        clientLayer.pipe(Layer.provide(http.layer)),
      );
      return yield* Effect.gen(function* () {
        const client = yield* ConvexClient.ConvexClient;
        const error = yield* client
          .getLogStream(deploymentUrl, deployKey, "one")
          .pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "ConvexApiError",
          code: "InvalidResponse",
        });
        yield* expectSecretSafe(error, webhookStream.hmacSecret);
      }).pipe(Effect.provideContext(services));
    });
  });
});

const streamResponses = [
  {
    id: "datadog",
    logStreamType: "datadog",
    siteLocation: "US1",
    ddTags: ["app:notes"],
    service: null,
    topics: ["console"],
    status: { type: "pending" },
  },
  { ...webhookStream, status: { type: "restarting" } },
  {
    id: "axiom",
    logStreamType: "axiom",
    datasetName: "backend",
    attributes: [{ key: "app", value: "notes" }],
    ingestUrl: null,
    topics: null,
    status: { type: "active" },
  },
  {
    id: "sentry",
    logStreamType: "sentry",
    tags: { app: "notes" },
    status: { type: "failed", reason: "made-up-private-failure" },
  },
  {
    id: "posthog-logs",
    logStreamType: "postHogLogs",
    host: null,
    serviceName: "notes",
    topics: null,
    status: { type: "deleting" },
  },
  {
    id: "posthog-errors",
    logStreamType: "postHogErrorTracking",
    host: null,
    status: { type: "active" },
  },
  {
    id: "s3",
    logStreamType: "s3Export",
    bucket: "example",
    region: "us-east-1",
    prefix: null,
    accessKeyId: "made-up-access-key-id",
    period: "hourly",
    selection: {
      _other: "excluded",
      "": {
        _other: "excluded",
        notes: { _other: "included", private: "excluded" },
      },
    },
    status: { type: "active" },
  },
];
it.effect.each(streamResponses)(
  "decodes and redacts the $logStreamType response",
  (body) => {
    const http = mockHttp([Response.json(body), Response.json([body])]);
    return Effect.gen(function* () {
      const services = yield* Layer.build(
        clientLayer.pipe(Layer.provide(http.layer)),
      );
      return yield* Effect.gen(function* () {
        const client = yield* ConvexClient.ConvexClient;
        const stream = yield* client.getLogStream(
          deploymentUrl,
          deployKey,
          body.id,
        );
        const streams = yield* client.listLogStreams(deploymentUrl, deployKey);
        expect(Redacted.value(stream)).toEqual(body);
        expect(Arr.map(streams, Redacted.value)).toEqual([body]);
        for (const secret of [
          webhookStream.hmacSecret,
          "made-up-private-failure",
          "made-up-access-key-id",
        ])
          yield* expectSecretSafe([stream, streams], secret);
      }).pipe(Effect.provideContext(services));
    });
  },
);

type Variant<A, K> = A extends { readonly logStreamType: infer Kind }
  ? K extends Kind
    ? A
    : never
  : never;
type Fields<A extends { readonly logStreamType: string }> = {
  [K in A["logStreamType"]]: keyof Variant<A, K>;
};
it("requires an explicit review when platform log stream fields change", () => {
  expectTypeOf<Fields<DeploymentApi.CreateLogStreamArgs>>().toEqualTypeOf<{
    datadog:
      | "logStreamType"
      | "siteLocation"
      | "ddApiKey"
      | "ddTags"
      | "service"
      | "topics";
    webhook: "logStreamType" | "url" | "format" | "topics";
    axiom:
      | "logStreamType"
      | "apiKey"
      | "datasetName"
      | "attributes"
      | "ingestUrl"
      | "topics";
    sentry: "logStreamType" | "dsn" | "tags";
    postHogLogs: "logStreamType" | "apiKey" | "host" | "serviceName" | "topics";
    postHogErrorTracking: "logStreamType" | "apiKey" | "host";
    s3Export:
      | "logStreamType"
      | "bucket"
      | "region"
      | "prefix"
      | "accessKeyId"
      | "secretAccessKey"
      | "selection"
      | "period";
  }>();
  expectTypeOf<Fields<typeof LogStreamDecoder.Config.Type>>().toEqualTypeOf<
    Fields<DeploymentApi.LogStreamConfig>
  >();
  expectTypeOf<Fields<typeof LogStreamDecoder.Created.Type>>().toEqualTypeOf<
    Fields<DeploymentApi.CreateLogStreamResponse>
  >();
});

it.effect(
  "uses the usage-limit deployment contracts with the configured access token",
  () => {
    const limit = {
      id: "limit/+",
      metric: "functionCalls",
      window: "month",
      limitType: "warning",
      limit: 100000,
      enabled: true,
    } as const;
    const input = {
      metric: "functionCalls",
      window: "month",
      limitType: "warning",
      limit: 100000,
      enabled: true,
    } as const;
    const http = mockHttp([
      Response.json({ usageLimits: [limit] }),
      Response.json({ usageLimit: limit }),
      Response.json({ usageLimit: { ...limit, limit: 200000 } }),
      new Response(null, { status: 200 }),
    ]);
    return Effect.gen(function* () {
      const services = yield* Layer.build(
        clientLayer.pipe(Layer.provide(http.layer)),
      );
      const client = yield* ConvexClient.ConvexClient.pipe(
        Effect.provideContext(services),
      );
      const listed = yield* client.listUsageLimits(deploymentUrl);
      expect(listed).toEqual([limit]);
      const created = yield* client.createUsageLimit(deploymentUrl, input);
      expect(created).toEqual(limit);
      const updated = yield* client.updateUsageLimit(deploymentUrl, limit.id, {
        ...input,
        limit: 200000,
      });
      expect(updated).toEqual({ ...limit, limit: 200000 });
      yield* client.deleteUsageLimit(deploymentUrl, limit.id);
      expect(
        Arr.map(http.requests, ({ method, url }) => [method, url]),
      ).toEqual([
        ["GET", `${deploymentUrl}/api/v1/list_usage_limits`],
        ["POST", `${deploymentUrl}/api/v1/create_usage_limit`],
        ["POST", `${deploymentUrl}/api/v1/update_usage_limit/limit%2F%2B`],
        ["POST", `${deploymentUrl}/api/v1/delete_usage_limit/limit%2F%2B`],
      ]);
      const createdBody = yield* requestBody(http.requests[1]);
      expect(createdBody).toEqual(input);
      const updatedBody = yield* requestBody(http.requests[2]);
      expect(updatedBody).toEqual({
        ...input,
        limit: 200000,
      });
      for (const request of http.requests)
        expect(request.headers.authorization).toBe(
          `Convex ${Redacted.value(token)}`,
        );
    });
  },
);

it.effect.each([401, 403, 404, 409])(
  "preserves usage-limit HTTP status %s",
  (status) => {
    const http = mockHttp([Response.json({ secret: "untrusted" }, { status })]);
    return Effect.gen(function* () {
      const services = yield* Layer.build(
        clientLayer.pipe(Layer.provide(http.layer)),
      );
      const client = yield* ConvexClient.ConvexClient.pipe(
        Effect.provideContext(services),
      );
      const error = yield* client
        .listUsageLimits(deploymentUrl)
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag:
          status === 404
            ? "ConvexNotFound"
            : status === 409
              ? "ConvexConflict"
              : "ConvexApiError",
        status,
      });
      yield* expectSecretSafe(error, "untrusted");
      yield* expectSecretSafe(error, Redacted.value(token));
    });
  },
);

it.effect("rejects unknown usage-limit response literals", () => {
  const http = mockHttp([
    Response.json({
      usageLimits: [
        {
          id: "bad",
          metric: "futureMetric",
          window: "month",
          limitType: "warning",
          limit: 1,
          enabled: true,
        },
      ],
    }),
  ]);
  return Effect.gen(function* () {
    const services = yield* Layer.build(
      clientLayer.pipe(Layer.provide(http.layer)),
    );
    const client = yield* ConvexClient.ConvexClient.pipe(
      Effect.provideContext(services),
    );
    const error = yield* client
      .listUsageLimits(deploymentUrl)
      .pipe(Effect.flip);
    expect(error).toMatchObject({
      _tag: "ConvexApiError",
      code: "InvalidResponse",
    });
  });
});

it.effect.each(["management", "deployment", "function"] as const)(
  "drops an identifier-shaped %s credential from serverCode",
  (auth) =>
    Effect.gen(function* () {
      const secret = "MadeUpIdentifierToken123";
      const http = mockHttp([Response.json({ code: secret }, { status: 403 })]);
      const services = yield* Layer.build(
        ConvexClient.layer({ token: Redacted.make(secret) }).pipe(
          Layer.provide(http.layer),
        ),
      );
      const client = yield* ConvexClient.ConvexClient.pipe(
        Effect.provideContext(services),
      );
      const request =
        auth === "management"
          ? client.listProjects(7)
          : auth === "deployment"
            ? client.updateEnvironmentVariables(
                deploymentUrl,
                Redacted.make(secret),
                [],
              )
            : client.runFunction(
                deploymentUrl,
                Redacted.make(secret),
                "test:run",
                {},
              );
      const result = yield* request.pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConvexApiError", status: 403, code: "HttpError" },
      });
      expect(inspect(result, { depth: null })).not.toContain(secret);
      yield* expectSecretSafe(result, secret);
    }),
);
