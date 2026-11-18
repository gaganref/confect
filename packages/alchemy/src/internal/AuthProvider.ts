import {
  AuthError,
  AuthProviderLayer,
  AuthProvidersLive,
} from "alchemy/Auth/AuthProvider";
import {
  CredentialsStore,
  CredentialsStoreLive,
} from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import {
  lazyCredentials,
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

/**
 * @stability unstable
 */
export const managementTokenLayer = Layer.effect(
  ManagementToken,
  lazyCredentials<Redacted.Redacted<string>>()(providerName, (token) => token),
).pipe(
  Layer.provide(ConvexAuth),
  Layer.provide(ProfileStoreLive.pipe(Layer.orDie)),
  Layer.provide(CredentialsStoreLive),
  Layer.provide(AuthProvidersLive),
);
