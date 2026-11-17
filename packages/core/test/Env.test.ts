import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import { Env } from "@confect/core";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

const env = Env.make("tenant", {
  EMAIL_FROM: Env.string(),
  RESEND_API_KEY: Env.secret(),
  EMAIL_TRANSPORT: Env.literals(["resend", "log"]),
  PLATFORM_URL: Env.optional(Env.string()),
  WEBHOOK_SECRET: Env.optional(Env.secret()),
});

const read = <A>(config: Config.Config<A>, values: Record<string, string>) =>
  Effect.gen(function* () {
    const services = yield* ConfigProvider.fromUnknown(values).pipe(
      ConfigProvider.layer,
      Layer.build,
    );
    return yield* config.pipe(Effect.provideContext(services));
  }).pipe(Effect.scoped);

describe("Env", () => {
  it.each(["CONVEX_SITE_URL", "CONVEX_CLOUD_URL"])(
    "refuses the reserved slot %s when its key is widened",
    (key: string) => {
      expect(() => Env.make("tenant", { [key]: Env.string() })).toThrowError(
        expect.objectContaining({
          _tag: "ReservedEnvKey",
          key,
          message: `The env slot "${key}" is reserved for a Convex built-in address; read it without declaring a slot.`,
        }),
      );
    },
  );

  it("reserves the keys of Convex's built-in deployment addresses", () => {
    const refused = () => {
      void Env.make("tenant", {
        // @ts-expect-error Convex supplies this address without a declared slot.
        CONVEX_SITE_URL: Env.string(),
      });
      void Env.make("tenant", {
        // @ts-expect-error Convex supplies this address without a declared slot.
        CONVEX_CLOUD_URL: Env.string(),
      });
    };
    void refused;
    const custom = Env.make("tenant", {
      CONVEX_CUSTOM_URL: Env.string(),
      CONVEX_SITE_URL_2: Env.string(),
      MY_CONVEX_SITE_URL: Env.string(),
      SITE_URL: Env.string(),
      CONVEX_URL: Env.string(),
      convex_site_url: Env.string(),
    });
    expectTypeOf(custom.CONVEX_CUSTOM_URL).toExtend<Config.Config<string>>();
    expect(Env.descriptors(custom)).toHaveLength(6);
  });

  it("types each entry as the Config a handler yields", () => {
    expectTypeOf(env.EMAIL_FROM).toExtend<Config.Config<string>>();
    expectTypeOf(env.RESEND_API_KEY).toExtend<
      Config.Config<Redacted.Redacted<string>>
    >();
    expectTypeOf(env.EMAIL_TRANSPORT).toExtend<
      Config.Config<"resend" | "log">
    >();
    expectTypeOf(env.PLATFORM_URL).toExtend<
      Config.Config<Option.Option<string>>
    >();
    expectTypeOf(env.WEBHOOK_SECRET).toExtend<
      Config.Config<Option.Option<Redacted.Redacted<string>>>
    >();
  });

  it.effect("reads each entry under its own key", () =>
    Effect.gen(function* () {
      const values = {
        EMAIL_FROM: "sender@example.test",
        RESEND_API_KEY: "test-key",
        EMAIL_TRANSPORT: "log",
      };
      expect(Config.isConfig(env.EMAIL_FROM)).toBe(true);
      const readResult = yield* read(env.EMAIL_FROM, values);
      expect(readResult).toBe("sender@example.test");
      const readResult2 = yield* read(env.RESEND_API_KEY, values);
      expect(Redacted.value(readResult2)).toBe("test-key");
      const readResult3 = yield* read(env.EMAIL_TRANSPORT, values);
      expect(readResult3).toBe("log");
      const readResult4 = yield* read(env.PLATFORM_URL, values);
      expect(readResult4).toEqual(Option.none());
      const readResult5 = yield* read(env.PLATFORM_URL, {
        ...values,
        PLATFORM_URL: "https://platform.example.test",
      });
      expect(readResult5).toEqual(Option.some("https://platform.example.test"));
      const wrong = yield* Effect.flip(
        read(env.EMAIL_TRANSPORT, { ...values, EMAIL_TRANSPORT: "smtp" }),
      );
      expect(wrong._tag).toBe("ConfigError");
    }),
  );

  it.effect("reads built-in addresses without declaring slots", () =>
    Effect.gen(function* () {
      const declared = Env.make("tenant", { SERVICE_URL: Env.string() });
      const values = {
        SERVICE_URL: "https://service.example.test",
        CONVEX_SITE_URL: "https://example.convex.site",
        CONVEX_CLOUD_URL: "https://example.convex.cloud",
      };
      const serviceUrl = yield* read(declared.SERVICE_URL, values);
      expect(serviceUrl).toBe("https://service.example.test");
      const siteUrl = yield* read(Config.String("CONVEX_SITE_URL"), values);
      expect(siteUrl).toBe("https://example.convex.site");
      const cloudUrl = yield* read(Config.String("CONVEX_CLOUD_URL"), values);
      expect(cloudUrl).toBe("https://example.convex.cloud");
    }),
  );

  it("describes every entry as plain data in declaration order", () => {
    expect(Env.name(env)).toBe("tenant");
    expect(Env.descriptors(env)).toEqual([
      ["EMAIL_FROM", { kind: "string", optional: false }],
      ["RESEND_API_KEY", { kind: "secret", optional: false }],
      [
        "EMAIL_TRANSPORT",
        { kind: "literals", values: ["resend", "log"], optional: false },
      ],
      ["PLATFORM_URL", { kind: "string", optional: true }],
      ["WEBHOOK_SECRET", { kind: "secret", optional: true }],
    ]);
    expect(Env.origin(env.EMAIL_TRANSPORT)).toEqual({
      backend: "tenant",
      key: "EMAIL_TRANSPORT",
    });
  });

  it("recognises envs and entries without matching ordinary values", () => {
    expect(Env.isEnv(env)).toBe(true);
    expect(Env.isEntry(env.EMAIL_FROM)).toBe(true);
    expect(Env.isEnv({ EMAIL_FROM: env.EMAIL_FROM })).toBe(false);
    expect(Env.isEntry(Config.String("EMAIL_FROM"))).toBe(false);
  });

  it("makes the backend name part of every entry's type", () => {
    const platform = Env.make("platform", { EMAIL_FROM: Env.string() });
    expectTypeOf(platform.EMAIL_FROM).not.toExtend<typeof env.EMAIL_FROM>();
    expectTypeOf<Env.Name<typeof env>>().toEqualTypeOf<"tenant">();
    // @ts-expect-error A widened name would make every env interchangeable.
    Env.make("tenant" as string, {});
    // @ts-expect-error An optional entry cannot be made optional again.
    Env.optional(Env.optional(Env.string()));
  });
});
