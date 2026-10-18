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
          // @ts-expect-error Only domain, issuer and jwks take the site URL.
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
