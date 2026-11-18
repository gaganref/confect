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
import { assert, describe, expect } from "@effect/vitest";
import { AuthProviders, getAuthProvider } from "alchemy/Auth/AuthProvider";
import {
  CredentialsStore,
  CredentialsStoreLive,
} from "alchemy/Auth/Credentials";
import { ProfileStore, ProfileStoreLive } from "alchemy/Auth/Profile";
import { Interaction, makeNonInteractive } from "alchemy/Interaction";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { inspect } from "node:util";
import { lifecycle, project as testProject } from "./fixtures/ConvexClient";
import * as Context from "effect/Context";
import * as Arr from "effect/Array";
import { providerForMode } from "alchemy/Provider";

const stackEnvironment = Layer.mergeAll(
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
  FetchHttpClient.layer,
);

describe("providers", () => {
  it.effect("registers every resource without management credentials", () =>
    Effect.gen(function* () {
      const services = yield* Layer.build(
        Convex.providers().pipe(
          Layer.provide(stackEnvironment),
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
            Layer.provide(stackEnvironment),
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

const Token = Schema.Struct({ token: Schema.RedactedFromValue(Schema.String) });
let profileNumber = 0;
const authHarness = (
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
      (...[, init]: Parameters<typeof globalThis.fetch>) => {
        requests.push(new Headers(init?.headers).get("authorization"));
        return Promise.resolve(
          options.response?.() ?? Response.json(testProject()),
        );
      },
      { preconnect: () => undefined },
    );
    const services = yield* Layer.build(
      Layer.mergeAll(ProfileStoreLive, CredentialsStoreLive).pipe(
        Layer.provideMerge(
          stackEnvironment.pipe(
            Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
          ),
        ),
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
    const config = ConfigProvider.fromUnknown({
      ALCHEMY_PROFILE: profileName,
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
    return { request, requests, logs, auth, profiles, profileName };
  });

describe("profile credentials", () => {
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

  it.effect(
    "keeps a profile token out of failing request errors and rendered logs",
    () =>
      Effect.gen(function* () {
        const secret = "ProfileTokenMustNeverBeRendered";
        const harness = yield* authHarness({
          stored: Redacted.make(secret),
          response: () =>
            Response.json({ code: secret, message: secret }, { status: 401 }),
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
