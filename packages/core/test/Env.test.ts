import { describe, expect, expectTypeOf, it } from "@effect/vitest";
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
  config.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(values))),
  );

describe("Env", () => {
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
      expect(yield* read(env.EMAIL_FROM, values)).toBe("sender@example.test");
      expect(Redacted.value(yield* read(env.RESEND_API_KEY, values))).toBe(
        "test-key",
      );
      expect(yield* read(env.EMAIL_TRANSPORT, values)).toBe("log");
      expect(yield* read(env.PLATFORM_URL, values)).toEqual(Option.none());
      expect(
        yield* read(env.PLATFORM_URL, {
          ...values,
          PLATFORM_URL: "https://platform.example.test",
        }),
      ).toEqual(Option.some("https://platform.example.test"));
      const wrong = yield* Effect.flip(
        read(env.EMAIL_TRANSPORT, { ...values, EMAIL_TRANSPORT: "smtp" }),
      );
      expect(wrong._tag).toBe("ConfigError");
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
