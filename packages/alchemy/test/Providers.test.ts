import * as NodeServices from "./fixtures/NodeTestServices";
import { it } from "@effect/vitest";
import { Convex } from "@confect/alchemy";
import { Providers } from "@confect/alchemy/Providers";
import { ConvexApiError } from "@confect/alchemy/ConvexClient";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { ArtifactStore } from "alchemy/Artifacts";
import { Stack } from "alchemy/Stack";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Result from "effect/Result";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
} from "@effect/vitest";
import { AuthProviders, getAuthProvider } from "alchemy/Auth/AuthProvider";
import {
  CredentialsStore,
  CredentialsStoreLive,
  credentialsFilePath,
} from "alchemy/Auth/Credentials";
import { ProfileStore, ProfileStoreLive, rootDir } from "alchemy/Auth/Profile";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { vi } from "vitest";
import { Interaction, makeNonInteractive } from "alchemy/Interaction";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { inspect } from "node:util";
import { lifecycle, project as testProject } from "./fixtures/ConvexClient";
import * as Context from "effect/Context";
import * as Arr from "effect/Array";
import { providerForMode } from "alchemy/Provider";

const unexpectedRequests: string[] = [];
const rejectRequest = (
  input: Parameters<typeof globalThis.fetch>[0],
): never => {
  const url = input instanceof Request ? input.url : String(input);
  unexpectedRequests.push(url);
  return assert.fail("Unexpected HTTP request outside the fake transport");
};
const denyFetch: typeof globalThis.fetch = Object.assign(rejectRequest, {
  preconnect: () => undefined,
});

beforeEach(() => {
  vi.stubGlobal("fetch", denyFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(unexpectedRequests.splice(0)).toEqual([]);
});

const stackEnvironment = (fetch: typeof globalThis.fetch = denyFetch) =>
  Layer.mergeAll(
    NodeServices.layer,
    ConfigProvider.layer(ConfigProvider.fromUnknown({})),
    Layer.succeed(ArtifactStore, new Map()),
    Layer.succeed(Stack, {
      name: "test",
      stage: "test",
      resources: {},
      bindings: {},
      actions: {},
    }),
    FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
    ),
  );

describe("providers", () => {
  it.effect("registers every resource without management credentials", () =>
    Effect.gen(function* () {
      const services = yield* Layer.build(
        Convex.providers().pipe(
          Layer.provide(stackEnvironment()),
          Layer.provide(
            Layer.succeed(AlchemyContext, {
              dotAlchemy: ".alchemy",
              dev: false,
              adopt: false,
            }),
          ),
        ),
      );
      return yield* Effect.gen(function* () {
        const collection = yield* Providers;
        for (const resource of [
          Convex.Project,
          Convex.Deployment,
          Convex.DeployKey,
          Convex.EnvironmentVariables,
          Convex.Code,
          Convex.CustomDomain,

          Convex.LogStream,
          Convex.UsageLimit,
        ]) {
          const provider = collection.get(resource.Type);
          expect(provider).toBeDefined();
          expect(typeof provider?.reconcile).toBe("function");
          expect(typeof provider?.delete).toBe("function");
        }
      }).pipe(Effect.provideContext(services));
    }),
  );

  it.effect.each([
    { dev: false, mode: "live" },
    { dev: true, mode: "local" },
  ] as const)(
    "resolves the same resources to $mode providers when dev is $dev",
    ({ dev, mode }) =>
      Effect.gen(function* () {
        const services2 = yield* Layer.build(
          Convex.providers().pipe(
            Layer.provide(stackEnvironment()),
            Layer.provide(
              Layer.succeed(AlchemyContext, {
                dotAlchemy: ".alchemy",
                dev,
                adopt: false,
              }),
            ),
          ),
        );
        return yield* Effect.gen(function* () {
          const collection = yield* Providers;
          for (const resource of [
            Convex.Project,
            Convex.Deployment,
            Convex.DeployKey,
            Convex.EnvironmentVariables,
            Convex.Code,
            Convex.CustomDomain,

            Convex.LogStream,
            Convex.UsageLimit,
          ])
            expect(collection.get(resource.Type)?.mode).toBe(mode);
          const project = collection.get(Convex.Project.Type);
          const result = yield* Effect.flatMap(
            Effect.fromNullishOr(project),
            (provider) =>
              provider.reconcile({
                id: "Project",
                fqn: "Project",
                instanceId: "0123456789abcdef",
                news: { teamId: 10, name: "notes" },
                olds: undefined,
                output: undefined,
                bindings: [],
                session: {
                  note: () => Effect.void,
                },
              }),
          ).pipe(Effect.result);
          expect(result).toEqual(
            dev
              ? Result.succeed({
                  projectId: 0,
                  teamId: 10,
                  name: "notes",
                  slug: "notes",
                })
              : Result.fail(
                  ConvexApiError.make({
                    operation: "configure",
                    code: "InvalidConfiguration",
                  }),
                ),
          );
        }).pipe(Effect.provideContext(services2));
      }),
  );
});

describe("providers credential set", () => {
  it.live(
    "redacts the login a management call resolved from a later push's output",
    () =>
      Effect.gen(function* () {
        // No prefix the generic key pattern knows, so only the run's set can
        // redact it.
        const login = "OpaqueManagementLogin0123456789";
        const fetch: typeof globalThis.fetch = Object.assign(
          (...[input]: Parameters<typeof globalThis.fetch>) => {
            const url = input instanceof Request ? input.url : String(input);
            return url === "https://api.convex.dev/v1/projects/1"
              ? Promise.resolve(Response.json(testProject()))
              : rejectRequest(input);
          },
          { preconnect: () => undefined },
        );
        const services = yield* Layer.build(stackEnvironment(fetch));
        return yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* fs.makeTempDirectoryScoped({
            prefix: "confect-providers-push-",
          });
          const convex = path.join(cwd, "node_modules", "convex");
          yield* fs.makeDirectory(convex, { recursive: true });
          yield* fs.writeFileString(
            path.join(convex, "package.json"),
            '{"name":"convex","bin":{"convex":"cli.js"}}',
          );
          yield* fs.writeFileString(
            path.join(convex, "cli.js"),
            `require('node:fs').writeSync(2, 'Login ${login} refused\\n');
process.exit(1);`,
          );
          const dotAlchemy = yield* fs.makeTempDirectoryScoped({
            prefix: "confect-providers-state-",
          });
          const providerServices = yield* Layer.build(
            Convex.providers({
              token: Redacted.make(login),
              access: Convex.DeploymentAccess.deployKey(
                Redacted.make("prod:happy-otter-123|supplied-key-text"),
              ),
            }).pipe(
              Layer.provide(
                Layer.succeed(AlchemyContext, {
                  dotAlchemy,
                  dev: false,
                  adopt: false,
                }),
              ),
            ),
          );
          const collection = yield* Providers.pipe(
            Effect.provideContext(providerServices),
          );
          const projectProvider = collection.get(Convex.Project.Type);
          const codeProvider = collection.get(Convex.Code.Type);
          assert(projectProvider !== undefined && codeProvider !== undefined);
          const projects = yield* providerForMode(projectProvider, "live");
          const code = yield* providerForMode(codeProvider, "live");
          assert(projects?.read !== undefined && code !== undefined);
          yield* projects.read({
            ...lifecycle,
            olds: { teamId: 10, name: "example" },
            output: {
              projectId: 1,
              teamId: 10,
              name: "example",
              slug: "example",
            },
          });
          const exit = yield* code
            .reconcile({
              ...lifecycle,
              news: {
                deployment: {
                  name: "happy-otter-123",
                  url: "https://happy-otter-123.convex.cloud",
                },
                cwd,
              },
              olds: undefined,
              output: undefined,
            })
            .pipe(
              Effect.provideService(
                ConfigProvider.ConfigProvider,
                ConfigProvider.fromUnknown({
                  HOME: dotAlchemy,
                  LOCALAPPDATA: dotAlchemy,
                }),
              ),
              Effect.exit,
            );
          const shown = inspect(exit, { depth: null });
          expect(shown).toContain("CommandError");
          expect(shown).toContain("Login <REDACTED> refused");
          expect(shown).not.toContain(login);
        }).pipe(Effect.provideContext(services));
      }).pipe(Effect.scoped),
  );
});

const Token = Schema.Struct({ token: Schema.RedactedFromValue(Schema.String) });
let profileNumber = 0;
const requestHarness = (
  options: {
    readonly stored?: Redacted.Redacted<string>;
    readonly token?: Redacted.Redacted<string>;
    readonly environment?: Readonly<Record<string, string>>;
    readonly response?: () => Response;
  } = {},
) =>
  Effect.gen(function* () {
    const requests: Array<string | null> = [];
    const logs: string[] = [];
    const fetch: typeof globalThis.fetch = Object.assign(
      (...[input, init]: Parameters<typeof globalThis.fetch>) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url !== "https://api.convex.dev/v1/projects/1")
          return rejectRequest(input);
        requests.push(new Headers(init?.headers).get("authorization"));
        return Promise.resolve(
          options.response?.() ?? Response.json(testProject()),
        );
      },
      { preconnect: () => undefined },
    );
    const services = yield* Layer.build(stackEnvironment(fetch));
    const config = ConfigProvider.fromUnknown({
      ...options.environment,
    });
    const registry = {};
    const providerServices = yield* Layer.build(
      Convex.providers(
        options.token === undefined ? undefined : { token: options.token },
      ).pipe(
        Layer.provide(Layer.succeed(AuthProviders, registry)),
        Layer.provide(
          Layer.succeed(AlchemyContext, {
            dotAlchemy: ".alchemy",
            dev: false,
            adopt: false,
          }),
        ),
        Layer.provide(
          Logger.layer(
            [
              Logger.make((entry) => {
                logs.push(inspect(entry, { depth: null }));
              }),
            ],
            { mergeWithExisting: false },
          ),
        ),
      ),
    ).pipe(
      Effect.provideContext(
        Context.omit(ConfigProvider.ConfigProvider)(services),
      ),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.provideService(ConfigProvider.ConfigProvider, config),
    );
    const collection = yield* Providers.pipe(
      Effect.provideContext(providerServices),
    );
    const registered = collection.get(Convex.Project.Type);
    assert(registered !== undefined);
    const provider = yield* providerForMode(registered, "live");
    if (provider?.read === undefined)
      return yield* Effect.die("Project read provider is missing");
    const request = provider
      .read({
        ...lifecycle,
        olds: { teamId: 10, name: "example" },
        output: { projectId: 1, teamId: 10, name: "example", slug: "example" },
      })
      .pipe(Effect.provideService(ConfigProvider.ConfigProvider, config));
    const auth = getAuthProvider<
      { readonly method: "stored" },
      Redacted.Redacted<string>
    >("Convex").pipe(Effect.provideService(AuthProviders, registry));
    return { request, requests, logs, auth, fetch };
  });

const authHarness = (options: Parameters<typeof requestHarness>[0] = {}) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      Layer.mergeAll(ProfileStoreLive, CredentialsStoreLive).pipe(
        Layer.provideMerge(stackEnvironment()),
      ),
    );
    const profiles = yield* ProfileStore.pipe(Effect.provideContext(services));
    const credentials = yield* CredentialsStore.pipe(
      Effect.provideContext(services),
    );
    const profileName = `convex-test-${profileNumber++}`;
    yield* profiles.createProfile(profileName);
    if (options.stored !== undefined) {
      yield* credentials.write(profileName, "Convex", Token, {
        token: options.stored,
      });
      yield* profiles.setProviderConfig(profileName, "Convex", {
        method: "stored",
      });
    }
    const harness = yield* requestHarness({
      ...options,
      environment: { ALCHEMY_PROFILE: profileName, ...options.environment },
    });
    return { ...harness, profiles, profileName, credentials };
  });

const withUnavailableHome = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(NodeServices.layer);
    return yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "confect-blocked-home-",
      });
      const blocker = path.join(directory, "blocker");
      yield* fs.writeFileString(blocker, "blocker");
      const home = path.join(blocker, "home");
      const previous = rootDir();
      yield* Effect.acquireRelease(
        Effect.sync(() => vi.stubEnv("ALCHEMY_HOME", home)),
        () => Effect.sync(() => vi.stubEnv("ALCHEMY_HOME", previous)),
      );
      const before = yield* fs.stat(blocker);
      expect(before.type).toBe("File");
      const result = yield* effect;
      const after = yield* fs.stat(blocker);
      expect(after.type).toBe("File");
      return result;
    }).pipe(Effect.provideContext(services));
  });

interface CredentialCase {
  readonly source: "explicit" | "environment";
  readonly token?: Redacted.Redacted<string>;
  readonly environment: Readonly<Record<string, string>>;
}

const credentialCases: ReadonlyArray<CredentialCase> = [
  {
    source: "explicit",
    token: Redacted.make("explicit-access-token"),
    environment: {},
  },
  {
    source: "environment",
    environment: { CONVEX_ACCESS_TOKEN: "environment-access-token" },
  },
];

describe("profile credentials", () => {
  it.effect(
    "fails a request to any host the fake transport does not know",
    () =>
      Effect.gen(function* () {
        const harness = yield* requestHarness();
        expect(() => harness.fetch("https://unknown.invalid/")).toThrow(
          "Unexpected HTTP request",
        );
        expect(unexpectedRequests.splice(0)).toEqual([
          "https://unknown.invalid/",
        ]);
      }),
  );

  it.effect.each(credentialCases)(
    "authenticates with $source credentials without opening an unwritable Alchemy home",
    (options) =>
      withUnavailableHome(
        Effect.gen(function* () {
          const harness = yield* requestHarness(options);
          yield* harness.request;
          expect(harness.requests).toEqual([
            `Bearer ${options.source}-access-token`,
          ]);
        }),
      ),
  );

  it.effect(
    "returns a typed failure with its cause when the Alchemy home is unwritable",
    () =>
      withUnavailableHome(
        Effect.gen(function* () {
          const harness = yield* requestHarness();
          const error = yield* harness.request.pipe(Effect.flip);
          assert(Schema.is(ConvexApiError)(error));
          expect(error.code).toBe("InvalidConfiguration");
          expect(error).toHaveProperty("cause");
          expect(harness.requests).toEqual([]);
        }),
      ),
  );

  it.effect(
    "keeps an explicit token ahead of a stored profile without an environment token",
    () =>
      Effect.gen(function* () {
        const harness = yield* authHarness({
          stored: Redacted.make("profile-access-token"),
          token: Redacted.make("explicit-access-token"),
        });
        yield* harness.request;
        expect(harness.requests).toEqual(["Bearer explicit-access-token"]);
      }),
  );

  it.effect("resolves a Convex token from the active temporary profile", () =>
    Effect.gen(function* () {
      const harness = yield* authHarness({
        stored: Redacted.make("profile-access-token"),
      });
      yield* harness.request;
      expect(harness.requests).toEqual(["Bearer profile-access-token"]);
    }),
  );

  it.effect.each([undefined, "true"])(
    "keeps an explicit token ahead of the profile and environment under CI=%s",
    (ci) =>
      Effect.gen(function* () {
        const harness = yield* authHarness({
          stored: Redacted.make("profile-access-token"),
          token: Redacted.make("explicit-access-token"),
          environment: {
            CONVEX_ACCESS_TOKEN: "environment-access-token",
            ...(ci === undefined ? {} : { CI: ci }),
          },
        });
        yield* harness.request;
        expect(harness.requests).toEqual(["Bearer explicit-access-token"]);
      }),
  );

  it.effect.each([undefined, "true"])(
    "uses the environment ahead of a stored profile under CI=%s",
    (ci) =>
      Effect.gen(function* () {
        const harness = yield* authHarness({
          stored: Redacted.make("profile-access-token"),
          environment: {
            CONVEX_ACCESS_TOKEN: "environment-access-token",
            ...(ci === undefined ? {} : { CI: ci }),
          },
        });
        yield* harness.request;
        expect(harness.requests).toEqual(["Bearer environment-access-token"]);
      }),
  );

  it.effect(
    "keeps environment-only authentication working without a login",
    () =>
      Effect.gen(function* () {
        const harness = yield* authHarness({
          environment: { CONVEX_ACCESS_TOKEN: "environment-access-token" },
        });
        yield* harness.request;
        expect(harness.requests).toEqual(["Bearer environment-access-token"]);
      }),
  );

  it.effect(
    "refuses profile credentials in CI when the environment token is missing",
    () =>
      Effect.gen(function* () {
        const harness = yield* authHarness({
          stored: Redacted.make("profile-access-token"),
          environment: { CI: "true" },
        });
        const error = yield* harness.request.pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "ConvexApiError",
          code: "InvalidConfiguration",
        });
        expect(harness.requests).toEqual([]);
      }),
  );

  it.effect(
    "names the Convex login command in the typed missing-credentials error",
    () =>
      Effect.gen(function* () {
        const harness = yield* authHarness();
        const error = yield* harness.request.pipe(Effect.flip);
        assert(Schema.is(ConvexApiError)(error));
        expect(error.message).toContain("alchemy profile edit --add Convex");
        expect(error.message).toContain("CONVEX_ACCESS_TOKEN");
        expect(harness.requests).toEqual([]);
      }),
  );

  it.effect(
    "keeps the login hint and cause when Convex has never been connected",
    () =>
      Effect.gen(function* () {
        const harness = yield* authHarness();
        const error = yield* harness.request.pipe(Effect.flip);
        assert(Schema.is(ConvexApiError)(error));
        expect(error.message).toBe(
          "Convex credentials are unavailable. Run `alchemy profile edit --add Convex` to log in. In CI, set CONVEX_ACCESS_TOKEN.",
        );
        expect(error.cause).toBeDefined();
        expect(harness.requests).toEqual([]);
      }),
  );

  it.effect.each(["missing", "unreadable"] as const)(
    "names reconfigure and keeps the cause for a connected provider with a %s stored credential",
    (state) =>
      Effect.gen(function* () {
        const harness = yield* authHarness({
          stored: Redacted.make("profile-access-token"),
        });
        if (state === "missing") {
          yield* harness.credentials.delete(harness.profileName, "Convex");
        } else {
          const services = yield* Layer.build(NodeServices.layer);
          const fs = yield* FileSystem.FileSystem.pipe(
            Effect.provideContext(services),
          );
          yield* fs.writeFileString(
            credentialsFilePath(harness.profileName, "Convex"),
            '{"token":"UnreadableSecretMustStayOutOfTheHint"',
          );
        }
        const error = yield* harness.request.pipe(Effect.flip);
        assert(Schema.is(ConvexApiError)(error));
        expect(error.message).toBe(
          "Stored Convex credentials are unavailable. Run `alchemy profile edit --reconfigure Convex` to replace the token.",
        );
        expect(error.cause).toBeDefined();
        expect(error.message).not.toContain(
          "UnreadableSecretMustStayOutOfTheHint",
        );
        expect(harness.requests).toEqual([]);
      }),
  );

  it.effect(
    "names only the environment variable and keeps the cause in CI",
    () =>
      withUnavailableHome(
        Effect.gen(function* () {
          const harness = yield* requestHarness({
            environment: { CI: "true" },
          });
          const error = yield* harness.request.pipe(Effect.flip);
          assert(Schema.is(ConvexApiError)(error));
          expect(error.message).toBe(
            "Convex credentials are unavailable in CI. Set CONVEX_ACCESS_TOKEN.",
          );
          expect(error.message).not.toContain("alchemy profile");
          expect(error.cause).toBeDefined();
          expect(harness.requests).toEqual([]);
        }),
      ),
  );

  it.effect("keeps reconfigure guidance in profile login failures", () =>
    Effect.gen(function* () {
      const harness = yield* authHarness({
        stored: Redacted.make("profile-access-token"),
      });
      yield* harness.credentials.delete(harness.profileName, "Convex");
      const auth = yield* harness.auth;
      const error = yield* auth
        .login(harness.profileName, { method: "stored" })
        .pipe(
          Effect.provideService(Interaction, makeNonInteractive()),
          Effect.flip,
        );
      expect(error.message).toContain(
        "alchemy profile edit --reconfigure Convex",
      );
      expect(error.cause).toBeDefined();
    }),
  );

  it.effect("keeps environment-only guidance in auth-provider failures", () =>
    withUnavailableHome(
      Effect.gen(function* () {
        const harness = yield* requestHarness({ environment: { CI: "true" } });
        const auth = yield* harness.auth;
        assert(auth.readEnvironment !== undefined);
        const error = yield* auth.readEnvironment.pipe(Effect.flip);
        expect(error.message).toContain("CONVEX_ACCESS_TOKEN");
        expect(error.message).not.toContain("alchemy profile");
        expect(error.cause).toBeDefined();
      }),
    ),
  );

  it.effect("removes stored credentials before the next resolution", () =>
    Effect.gen(function* () {
      const harness = yield* authHarness({
        stored: Redacted.make("profile-access-token"),
      });
      const services = yield* Layer.build(NodeServices.layer);
      const fs = yield* FileSystem.FileSystem.pipe(
        Effect.provideContext(services),
      );
      const file = credentialsFilePath(harness.profileName, "Convex");
      const before = yield* fs.exists(file);
      expect(before).toBe(true);
      const auth = yield* harness.auth;
      yield* auth
        .logout(harness.profileName, { method: "stored" })
        .pipe(Effect.provideService(Interaction, makeNonInteractive()));
      yield* harness.profiles.deleteProviderConfig(
        harness.profileName,
        "Convex",
      );
      const after = yield* fs.exists(file);
      expect(after).toBe(false);
      const error = yield* harness.request.pipe(Effect.flip);
      assert(Schema.is(ConvexApiError)(error));
      expect(error.message).toBe(
        "Convex credentials are unavailable. Run `alchemy profile edit --add Convex` to log in. In CI, set CONVEX_ACCESS_TOKEN.",
      );
      expect(error.cause).toBeDefined();
      expect(harness.requests).toEqual([]);
    }),
  );

  it.effect("registers Convex with hidden token entry and no token flags", () =>
    Effect.gen(function* () {
      const harness = yield* authHarness();
      const auth = yield* harness.auth;
      expect(auth.configureWith).toBeUndefined();
      expect(auth.configureMethods).toBeUndefined();
      const interaction = makeNonInteractive();
      const prompts: string[] = [];
      const config = yield* auth.configure(harness.profileName).pipe(
        Effect.provideService(Interaction, {
          ...interaction,
          prompt: {
            ...interaction.prompt,
            password: (options) => {
              prompts.push(options.message);
              return Effect.succeed("hidden-prompt-token");
            },
          },
        }),
      );
      expect(prompts).toEqual(["Convex team access token"]);
      expect(inspect(config)).not.toContain("hidden-prompt-token");
      yield* harness.profiles.setProviderConfig(
        harness.profileName,
        "Convex",
        config,
      );
      yield* harness.request;
      expect(harness.requests).toEqual(["Bearer hidden-prompt-token"]);
    }),
  );

  it.effect.each(["", "Prefix", "PrefixAndSuffix"])(
    "keeps a profile token out of failing request errors and rendered logs with %s around it",
    (surrounding) =>
      Effect.gen(function* () {
        const secret = "ProfileTokenMustNeverBeRendered";
        const harness = yield* authHarness({
          stored: Redacted.make(secret),
          response: () =>
            Response.json(
              {
                code: `${surrounding}${secret}${surrounding}`,
                message: secret,
              },
              { status: 401 },
            ),
        });
        const logs: string[] = [];
        const logging = yield* Layer.build(
          Logger.layer(
            [
              Logger.make((entry) => {
                logs.push(inspect(entry, { depth: null }));
              }),
            ],
            { mergeWithExisting: false },
          ),
        );
        const error = yield* harness.request.pipe(
          Effect.tapError((failure) => Effect.logError(failure)),
          Effect.provideContext(logging),
          Effect.flip,
        );
        assert(Schema.is(ConvexApiError)(error));
        expect(error).toMatchObject({
          _tag: "ConvexApiError",
          code: "HttpError",
          status: 401,
        });
        const json = yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.Unknown),
        )(error);
        const rendered = Arr.join(
          [
            String(error),
            inspect(error, { depth: null }),
            json,
            ...harness.logs,
            ...logs,
          ],
          "\n",
        );
        expect(rendered).not.toContain(secret);
        expect(harness.requests).toEqual([`Bearer ${secret}`]);
      }),
  );
});
