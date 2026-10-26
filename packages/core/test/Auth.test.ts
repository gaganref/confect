import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { App, Auth, Env } from "@confect/core";
import { defineComponent } from "convex/server";

const authCore = defineComponent("auth");
const workpool = defineComponent("workpool");
const app = App.make({
  env: Env.make("tenant", {}),
  mounts: {
    auth: App.mount(authCore, { httpPrefix: "/auth" }),
    importsPool: App.mount(workpool),
  },
});

describe("Auth", () => {
  it("accepts app declarations and rejects component declarations by type", () => {
    const component = App.make({
      kind: "component",
      env: Env.make("counter", {}),
    });
    expectTypeOf(app.kind).toEqualTypeOf<"app">();
    expectTypeOf(component.kind).toEqualTypeOf<"component">();
    expectTypeOf(Auth.make(app, { providers: [] }).app).toEqualTypeOf<
      typeof app
    >();
    // @ts-expect-error Auth.make accepts only app declarations.
    Auth.make(component, { providers: [] });
    const checkUnion = (either: App.Any) => {
      // @ts-expect-error A declaration whose kind is not known to be app is rejected.
      Auth.make(either, { providers: [] });
    };
    void checkUnion;
  });

  it("keeps Convex's provider list with site URL placeholders", () => {
    const auth = Auth.make(app, {
      providers: [
        {
          type: "customJwt",
          applicationID: "tenant",
          issuer: Auth.siteUrl(),
          jwks: Auth.siteUrl(app.mounts.auth, "/.well-known/jwks.json"),
          algorithm: "RS256",
        },
        { domain: "https://login.example.edu", applicationID: "campus" },
      ],
    });
    expect(Auth.isAuth(auth)).toBe(true);
    expect(Auth.providers(auth)).toEqual([
      {
        type: "customJwt",
        applicationID: "tenant",
        issuer: Auth.siteUrl(),
        jwks: Auth.siteUrl("/auth/.well-known/jwks.json"),
        algorithm: "RS256",
      },
      { domain: "https://login.example.edu", applicationID: "campus" },
    ]);
    expect(Auth.siteUrlPath(Auth.siteUrl(app.mounts.auth))).toBe("/auth");
    const slashed = App.mount(authCore, { httpPrefix: "/auth/" });
    expect(Auth.siteUrlPath(Auth.siteUrl(slashed, "/jwks.json"))).toBe(
      "/auth/jwks.json",
    );
    expect(Auth.siteUrlPath("https://login.example.edu")).toBeUndefined();
  });

  it("describes deployment cloud URLs and required env provider fields", () => {
    const env = Env.make("tenant", {
      ISSUER: Env.string(),
      OPTIONAL: Env.optional(Env.string()),
      SECRET: Env.secret(),
    });
    const auth = Auth.make(App.make({ env }), {
      providers: [
        {
          type: "customJwt",
          issuer: env.ISSUER,
          jwks: Auth.cloudUrl("/.well-known/jwks.json"),
          applicationID: Auth.siteUrl(),
          algorithm: "ES256",
        },
      ],
    });
    expect(Auth.cloudUrlPath(Auth.cloudUrl("/components/auth"))).toBe(
      "/components/auth",
    );
    expect(Auth.cloudUrlPath(Auth.cloudUrl())).toBe("");
    expect(Auth.providers(auth)[0]).toEqual({
      type: "customJwt",
      issuer: env.ISSUER,
      jwks: Auth.cloudUrl("/.well-known/jwks.json"),
      applicationID: Auth.siteUrl(),
      algorithm: "ES256",
    });
    const invalid: Auth.Provider = {
      domain: "https://issuer.test",
      // @ts-expect-error Optional env values cannot configure a required provider field.
      applicationID: env.OPTIONAL,
    };
    const secret: Auth.Provider = {
      // @ts-expect-error Provider configuration is public, not a secret.
      domain: env.SECRET,
      applicationID: "convex",
    };
    void invalid;
    void secret;
  });

  it("accepts only what Convex's AuthProvider accepts", () => {
    Auth.make(app, {
      providers: [
        {
          type: "customJwt",
          issuer: "https://issuer.example.test",
          jwks: "https://issuer.example.test/jwks",
          // @ts-expect-error Convex supports RS256 and ES256 only.
          algorithm: "HS256",
        },
      ],
    });
    Auth.make(app, {
      providers: [
        {
          domain: "https://login.example.edu",
          applicationID: Auth.siteUrl(),
        },
      ],
    });
    const unprefixed = () =>
      // @ts-expect-error A mount without an HTTP prefix has no URL to point at.
      Auth.siteUrl(app.mounts.importsPool);
    void unprefixed;
  });
});
