import {
  AuthError,
  AuthProviderLayer,
  AuthProvidersLive,
} from "alchemy/Auth/AuthProvider";
import {
  CredentialsStore,
  CredentialsStoreLive,
} from "alchemy/Auth/Credentials";
import { ProfileStore, ProfileStoreLive } from "alchemy/Auth/Profile";
import {
  lazyCredentials,
  deferUntilFirstUse,
  type CredentialsUnavailable,
} from "alchemy/Auth/Resolve";
import {
  collectFieldValues,
  storedSecret,
} from "alchemy/Auth/StoredAuthProvider";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

const providerName = "Convex";
const AuthConfig = Schema.Struct({ method: Schema.Literal("stored") });
const Token = Schema.Struct({ token: Schema.RedactedFromValue(Schema.String) });

export const credentialsHint =
  "Convex credentials are unavailable. Run `alchemy profile edit --add Convex` to log in. In CI, set CONVEX_ACCESS_TOKEN.";

const unavailable = () => AuthError.make({ message: credentialsHint });

const ConvexAuth = AuthProviderLayer<
  typeof AuthConfig.Type,
  Redacted.Redacted<string>
>()(
  providerName,
  Effect.gen(function* () {
    const credentials = yield* CredentialsStore;
    const read = Effect.fn("ConvexAuth.read")(function* (profileName: string) {
      const stored = yield* credentials
        .read(profileName, providerName, Token)
        .pipe(Effect.mapError(unavailable));
      if (stored === undefined) return yield* unavailable();
      return stored.token;
    });
    return {
      configSchema: AuthConfig,
      configure: Effect.fn("ConvexAuth.configure")(function* (
        profileName: string,
      ) {
        const values = yield* collectFieldValues([
          { name: "token", label: "Convex team access token", secret: true },
        ]);
        const token = storedSecret(values.token);
        if (token === undefined) return yield* unavailable();
        yield* credentials
          .write(profileName, providerName, Token, { token })
          .pipe(Effect.mapError(unavailable));
        return { method: "stored" as const };
      }),
      login: (profileName, config) => read(profileName).pipe(Effect.as(config)),
      logout: (profileName) =>
        credentials
          .delete(profileName, providerName)
          .pipe(Effect.mapError(unavailable)),
      details: (profileName) =>
        read(profileName).pipe(
          Effect.as({ lines: [{ key: "token", value: "<redacted>" }] }),
        ),
      read: (profileName) => read(profileName),
      readEnvironment: Config.Redacted("CONVEX_ACCESS_TOKEN").pipe(
        Effect.mapError(unavailable),
      ),
      environment: [
        {
          name: "CONVEX_ACCESS_TOKEN",
          required: true,
          secret: true,
          description:
            "Convex team access token for CI and environment authentication.",
        },
      ],
    };
  }),
);

export class ManagementToken extends Context.Service<
  ManagementToken,
  Effect.Effect<Redacted.Redacted<string>, CredentialsUnavailable>
>()("@confect/alchemy/internal/AuthProvider/ManagementToken") {}

// Alchemy creates profile directories while building its store. Defer that
// build as well as credential resolution so environment and deploy keys need no home.
const lazyProfileStore = Layer.effect(
  ProfileStore,
  Effect.gen(function* () {
    const profiles = yield* deferUntilFirstUse(
      ProfileStoreLive.pipe(
        Layer.build,
        Effect.map(Context.get(ProfileStore)),
        Effect.scoped,
      ),
    );
    return ProfileStore.of({
      current: profiles.pipe(Effect.flatMap((store) => store.current)),
      readManifest: profiles.pipe(
        Effect.flatMap((store) => store.readManifest),
      ),
      getProfile: (name) =>
        profiles.pipe(Effect.flatMap((store) => store.getProfile(name))),
      ensureProfile: (name) =>
        profiles.pipe(Effect.flatMap((store) => store.ensureProfile(name))),
      createProfile: (name) =>
        profiles.pipe(Effect.flatMap((store) => store.createProfile(name))),
      renameProfile: (name, newName) =>
        profiles.pipe(
          Effect.flatMap((store) => store.renameProfile(name, newName)),
        ),
      setProviderConfig: (profile, provider, values) =>
        profiles.pipe(
          Effect.flatMap((store) =>
            store.setProviderConfig(profile, provider, values),
          ),
        ),
      deleteProviderConfig: (profile, provider) =>
        profiles.pipe(
          Effect.flatMap((store) =>
            store.deleteProviderConfig(profile, provider),
          ),
        ),
      deleteProfile: (name) =>
        profiles.pipe(Effect.flatMap((store) => store.deleteProfile(name))),
      loadProviderConfig: (auth, profile) =>
        profiles.pipe(
          Effect.flatMap((store) => store.loadProviderConfig(auth, profile)),
        ),
    });
  }),
);

/**
 * @stability unstable
 */
export const managementTokenLayer = Layer.effect(
  ManagementToken,
  lazyCredentials<Redacted.Redacted<string>>()(providerName, (token) => token),
).pipe(
  Layer.provide(ConvexAuth),
  Layer.provide(lazyProfileStore),
  Layer.provide(CredentialsStoreLive),
  Layer.provide(AuthProvidersLive),
);
