import { describe, expect, it } from "@effect/vitest";
import { App, Component, Env, MiddlewareSpec, Mount } from "@confect/core";
import { defineComponent } from "convex/server";
import { v } from "convex/values";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as Schema from "effect/Schema";

const env = Env.make("tenant", {
  EMAIL_FROM: Env.string(),
  RESEND_API_KEY: Env.secret(),
  EMAIL_TRANSPORT: Env.literals(["resend", "log"]),
  PLATFORM_URL: Env.optional(Env.string()),
});

const email = defineComponent("email", {
  env: {
    FROM: v.string(),
    KEY: v.string(),
    TRANSPORT: v.union(v.literal("resend"), v.literal("log")),
    PLATFORM_URL: v.optional(v.string()),
  },
});
const workpool = defineComponent("workpool");
const EmailApi = HttpApi.make("email").add(
  HttpApiGroup.make("health").add(HttpApiEndpoint.get("health", "/health")),
);

const emailEnv = {
  FROM: env.EMAIL_FROM,
  KEY: env.RESEND_API_KEY,
  TRANSPORT: env.EMAIL_TRANSPORT,
} as const;

const Email = Component.make("email", {
  env: { FROM: Schema.String, PLATFORM_URL: Schema.optionalKey(Schema.String) },
  client: (native: unknown) => native,
});
const Workpool = Component.make("workpool", {
  client: (native: unknown) => native,
});

describe("App", () => {
  it("keeps required middleware and defaults to no requirements", () => {
    class Required extends MiddlewareSpec.MiddlewareSpec<Required>()(
      "Required",
      {
        functionTypes: { query: true, mutation: true, action: true },
      },
    ) {}
    expect([
      App.make({ env, requiresMiddleware: [Required] }).requiresMiddleware.map(
        ({ key }) => key,
      ),
      App.make({ env }).requiresMiddleware.map(({ key }) => key),
    ]).toEqual([["Required"], []]);
  });

  it("keeps the env, each mount's options and their declaration order", () => {
    const app = App.make({
      env,
      mounts: {
        email: App.mount(email, {
          httpPrefix: "/email",
          env: { ...emailEnv, PLATFORM_URL: env.PLATFORM_URL },
        }),
        importsPool: App.mount(workpool),
        literalEmail: App.mount(email, {
          env: { FROM: "noreply@example.test", KEY: "k", TRANSPORT: "log" },
        }),
      },
    });
    expect(App.env(app)).toBe(env);
    expect(App.mounts(app).every((mount) => !("api" in mount))).toBe(true);
    expect(App.mounts(app)).toEqual([
      {
        name: "email",
        definition: email,
        httpPrefix: "/email",
        env: { ...emailEnv, PLATFORM_URL: env.PLATFORM_URL },
      },
      {
        name: "importsPool",
        definition: workpool,
        httpPrefix: undefined,
        env: {},
      },
      {
        name: "literalEmail",
        definition: email,
        httpPrefix: undefined,
        env: { FROM: "noreply@example.test", KEY: "k", TRANSPORT: "log" },
      },
    ]);
    expect(App.isApp(app)).toBe(true);
    expect(App.isApp({ env, mounts: {} })).toBe(false);
  });

  it("types each mount's env against the component's own declaration", () => {
    App.mount(workpool);
    App.mount(email, { env: emailEnv });
    // @ts-expect-error Test kits are discovered from the component package.
    App.mount(email, { env: emailEnv, testing: "email-kit/testing" });
    // @ts-expect-error A mount does not accept a testing option.
    App.mount(workpool, { testing: true });
    // @ts-expect-error The options are required when the component has required env.
    App.mount(email);
    // @ts-expect-error An HTTP prefix does not stand in for required env.
    App.mount(email, { httpPrefix: "/email" });
    App.mount(email, {
      // @ts-expect-error A required binding cannot be left out.
      env: { FROM: env.EMAIL_FROM, KEY: env.RESEND_API_KEY },
    });
    App.mount(email, {
      // @ts-expect-error An optional app variable cannot fill a required slot.
      env: { ...emailEnv, FROM: env.PLATFORM_URL },
    });
    App.mount(email, {
      // @ts-expect-error A plain string entry cannot fill a literal slot.
      env: { ...emailEnv, TRANSPORT: env.EMAIL_FROM },
    });
    App.mount(email, {
      // @ts-expect-error A constant must be one of the slot's literals.
      env: { ...emailEnv, TRANSPORT: "smtp" },
    });
    App.mount(email, {
      // @ts-expect-error A binding for a slot the component does not declare.
      env: { ...emailEnv, UNKNOWN: env.EMAIL_FROM },
    });
    // @ts-expect-error A mount does not accept an api, even with an HTTP prefix.
    App.mount(workpool, { httpPrefix: "/email", api: EmailApi });
    // @ts-expect-error A mount does not accept an api.
    App.mount(workpool, { api: EmailApi });
  });

  it("rejects a reference from another backend's env", () => {
    const platform = Env.make("platform", {
      EMAIL_FROM: Env.string(),
      RESEND_API_KEY: Env.secret(),
      EMAIL_TRANSPORT: Env.literals(["resend", "log"]),
    });
    App.make({ env, mounts: { email: App.mount(email, { env: emailEnv }) } });
    const either = (): string | typeof platform.EMAIL_FROM =>
      platform.EMAIL_FROM;
    App.make({
      env,
      mounts: {
        // @ts-expect-error A binding that may be another backend's entry is rejected too.
        email: App.mount(email, { env: { ...emailEnv, FROM: either() } }),
      },
    });
    App.make({
      env,
      mounts: {
        // @ts-expect-error The binding's entry belongs to the platform backend.
        email: App.mount(email, {
          env: { ...emailEnv, FROM: platform.EMAIL_FROM },
        }),
      },
    });
  });
  it("keeps the env, the definitions and each mount in list order", () => {
    const BulkEmail = Mount.make(Email, {
      name: "bulkEmail",
      httpPrefix: "/bulk-email",
      env: { FROM: env.EMAIL_FROM, PLATFORM_URL: env.PLATFORM_URL },
    });
    const ImportsPool = Mount.make(Workpool, { name: "importsPool" });
    const app = App.make({
      env,
      components: [email, workpool],
      mounts: [ImportsPool, BulkEmail],
    });
    expect(App.env(app)).toBe(env);
    expect(App.components(app)).toEqual([email, workpool]);
    expect(App.mounts(app)).toEqual([
      Mount.data(ImportsPool),
      Mount.data(BulkEmail),
    ]);
    const empty = App.make({ env });
    expect(App.mounts(empty)).toEqual([]);
    expect(App.isApp(app)).toBe(true);
    expect(App.isApp({ env, mounts: [] })).toBe(false);
  });

  it("rejects a mount bound to another backend's env", () => {
    const platform = Env.make("platform", { EMAIL_FROM: Env.string() });
    const own = Mount.make(Email, {
      name: "own",
      env: { FROM: env.EMAIL_FROM },
    });
    const foreign = Mount.make(Email, {
      name: "foreign",
      env: { FROM: platform.EMAIL_FROM },
    });
    const either = (): string | typeof platform.EMAIL_FROM =>
      platform.EMAIL_FROM;
    const maybe = Mount.make(Email, { name: "maybe", env: { FROM: either() } });
    App.make({ env, components: [email], mounts: [own] });
    // @ts-expect-error The mount binds an entry of the platform backend's env.
    App.make({ env, components: [email], mounts: [own, foreign] });
    // @ts-expect-error A binding that may be another backend's entry is rejected too.
    App.make({ env, components: [email], mounts: [maybe] });
  });
});
