import { describe, expect, it } from "@effect/vitest";
import { App, Component, Env, MiddlewareSpec, Mount } from "@confect/core";
import { defineComponent } from "convex/server";
import * as Schema from "effect/Schema";

const env = Env.make("tenant", {
  EMAIL_FROM: Env.string(),
  PLATFORM_URL: Env.optional(Env.string()),
});

const email = defineComponent("email");
const workpool = defineComponent("workpool");
const Email = Component.make("email", {
  env: { FROM: Schema.String, PLATFORM_URL: Schema.optionalKey(Schema.String) },
  client: (native: unknown) => native,
});
const Workpool = Component.make("workpool", {
  client: (native: unknown) => native,
});

const observe = {
  owner: "test/observe",
  format: 1,
  describe: () => null,
};

describe("App", () => {
  it("keeps the declared manifest sections for an app and a component, and defaults to none", () => {
    const manifestSections = [{ key: "observe", section: observe }];
    expect([
      App.make({ env, manifestSections }).manifestSections,
      App.make({ env, kind: "component", manifestSections }).manifestSections,
      App.make({ env }).manifestSections,
    ]).toEqual([manifestSections, manifestSections, []]);
  });

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
