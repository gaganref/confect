import { describe, expect, it } from "@effect/vitest";
import { App, Env } from "@confect/core";
import { defineComponent } from "convex/server";
import { v } from "convex/values";
import * as HttpApi from "effect/http-api/HttpApi";

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

const emailEnv = {
  FROM: env.EMAIL_FROM,
  KEY: env.RESEND_API_KEY,
  TRANSPORT: env.EMAIL_TRANSPORT,
} as const;

describe("App", () => {
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
    expect(App.mounts(app)).toEqual([
      {
        name: "email",
        definition: email,
        httpPrefix: "/email",
        api: undefined,
        env: { ...emailEnv, PLATFORM_URL: env.PLATFORM_URL },
      },
      {
        name: "importsPool",
        definition: workpool,
        httpPrefix: undefined,
        api: undefined,
        env: {},
      },
      {
        name: "literalEmail",
        definition: email,
        httpPrefix: undefined,
        api: undefined,
        env: { FROM: "noreply@example.test", KEY: "k", TRANSPORT: "log" },
      },
    ]);
    expect(App.isApp(app)).toBe(true);
    expect(App.isApp({ env, mounts: {} })).toBe(false);
  });

  it("types each mount's env against the component's own declaration", () => {
    App.mount(workpool);
    App.mount(email, { env: emailEnv });
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
    // @ts-expect-error A mount's api describes routes under its prefix, so it needs one.
    App.mount(workpool, { api: HttpApi.make("workpool") });
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
});
