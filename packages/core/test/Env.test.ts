import * as Rec from "effect/Record";
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

it("refuses automatic provider selectors at compile time and runtime", () => {
  expect(() => {
    // @ts-expect-error A provider selector cannot be automatic.
    Env.automatic(Env.providers({ ses: {} }));
  }).toThrowError(
    expect.objectContaining({
      _tag: "InvalidEnvProviders",
      reason: "AutomaticSelector",
    }),
  );
});

it("refuses automatic provider settings", () => {
  expect(() =>
    Env.make("email", {
      CHOICE: Env.providers({ ses: { KEY: Env.automatic(Env.secret()) } }),
    }),
  ).toThrowError(
    expect.objectContaining({
      _tag: "InvalidEnvProviders",
      reason: "AutomaticSetting",
      provider: "ses",
      key: "KEY",
    }),
  );
});

it.each([false, true])(
  "refuses a nested provider selector, optional=%s",
  (optional) => {
    const nested: Env.AnyField = optional
      ? Env.optional(Env.providers({ inner: { INNER_KEY: Env.secret() } }))
      : Env.providers({ inner: { INNER_KEY: Env.secret() } });
    expect(() => Env.providers({ outer: { NESTED: nested } })).toThrowError(
      expect.objectContaining({
        _tag: "InvalidEnvProviders",
        reason: "NestedSelector",
        provider: "outer",
        key: "NESTED",
      }),
    );
  },
);

it("refuses nested provider selectors in typed declarations", () => {
  expect(() =>
    Env.providers({
      outer: {
        // @ts-expect-error A provider setting cannot itself be a selector.
        NESTED: Env.providers({ inner: {} }),
      },
    }),
  ).toThrow();
  expect(() =>
    Env.providers({
      outer: {
        // @ts-expect-error An optional selector is still a selector.
        NESTED: Env.optional(Env.providers({ inner: {} })),
      },
    }),
  ).toThrow();
});

describe("Env", () => {
  it.effect(
    "marks an automatic field without changing how a handler reads it",
    () =>
      Effect.gen(function* () {
        const staged = Env.make("host", { STAGE: Env.automatic(Env.string()) });
        expect(Env.descriptors(staged)).toEqual([
          ["STAGE", { kind: "string", optional: false, automatic: true }],
        ]);
        const stage = yield* read(staged.STAGE, { STAGE: "preview" });
        expect(stage).toBe("preview");
      }),
  );

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

  it.each(["CONVEX_SITE_URL", "CONVEX_CLOUD_URL"])(
    "refuses an automatic reserved slot %s",
    (key: string) => {
      expect(() =>
        Env.make("host", { [key]: Env.automatic(Env.string()) }),
      ).toThrowError(expect.objectContaining({ _tag: "ReservedEnvKey", key }));
    },
  );

  it.each(["CONVEX_SITE_URL", "CONVEX_CLOUD_URL"])(
    "refuses reserved provider selectors and settings %s",
    (key: string) => {
      expect(() =>
        Env.make("host", {
          [key]: Env.providers({ ses: { SES_KEY: Env.secret() } }),
        }),
      ).toThrowError(expect.objectContaining({ _tag: "ReservedEnvKey", key }));
      expect(() =>
        Env.make("host", {
          CHOICE: Env.providers({ ses: { [key]: Env.secret() } }),
        }),
      ).toThrowError(expect.objectContaining({ _tag: "ReservedEnvKey", key }));
    },
  );

  it.effect(
    "reads a pool with only its named providers and preserves optional settings",
    () =>
      Effect.gen(function* () {
        const email = Env.make("email", {
          PROVIDER: Env.providers({
            ses: {
              SES_KEY: Env.secret(),
              SES_REGION: Env.optional(Env.string()),
            },
            resend: { RESEND_KEY: Env.secret() },
          }),
        });
        const pool = yield* read(email.PROVIDER, {
          PROVIDER: '{"pool":["ses"]}',
          SES_KEY: "key",
          RESEND_KEY: "unused",
        });
        expect(pool.choice).toEqual({ pool: ["ses"] });
        expect(pool.providers.ses?.SES_REGION).toEqual(Option.none());
        expect(pool.providers.resend).toBeUndefined();
      }),
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

  it.effect(
    "declares a provider choice beside each provider's slots and reads the named providers' settings",
    () =>
      Effect.gen(function* () {
        const email = Env.make("email", {
          EMAIL_PROVIDER: Env.providers({
            ses: { SES_REGION: Env.string(), SES_KEY: Env.secret() },
            resend: { RESEND_API_KEY: Env.secret() },
          }),
        });
        expect(Env.descriptors(email)).toEqual([
          [
            "EMAIL_PROVIDER",
            { kind: "providers", values: ["ses", "resend"], optional: false },
          ],
          [
            "SES_REGION",
            {
              kind: "string",
              optional: true,
              provider: {
                selector: "EMAIL_PROVIDER",
                name: "ses",
                required: true,
              },
            },
          ],
          [
            "SES_KEY",
            {
              kind: "secret",
              optional: true,
              provider: {
                selector: "EMAIL_PROVIDER",
                name: "ses",
                required: true,
              },
            },
          ],
          [
            "RESEND_API_KEY",
            {
              kind: "secret",
              optional: true,
              provider: {
                selector: "EMAIL_PROVIDER",
                name: "resend",
                required: true,
              },
            },
          ],
        ]);
        const fixed = yield* read(email.EMAIL_PROVIDER, {
          EMAIL_PROVIDER: "resend",
          RESEND_API_KEY: "key",
        });
        expect(fixed.choice).toBe("resend");
        expect(Redacted.value(fixed.providers.resend!.RESEND_API_KEY)).toBe(
          "key",
        );
        expect(fixed.providers.ses).toBeUndefined();
        const failover = yield* read(email.EMAIL_PROVIDER, {
          EMAIL_PROVIDER: '{"active":"ses","standby":["resend"]}',
          SES_REGION: "eu-west-1",
          SES_KEY: "ses-key",
          RESEND_API_KEY: "key",
        });
        expect(failover.choice).toEqual({ active: "ses", standby: ["resend"] });
        expect(failover.providers.ses?.SES_REGION).toBe("eu-west-1");
        const refusals: ReadonlyArray<Record<string, string>> = [
          { EMAIL_PROVIDER: "sms" },
          { EMAIL_PROVIDER: '{"active":"ses","standby":["ses"]}' },
          { EMAIL_PROVIDER: '{"pool":[]}' },
          {
            EMAIL_PROVIDER: '{"active":"ses","standby":["resend"]}',
            RESEND_API_KEY: "key",
          },
        ];
        for (const refused of refusals) {
          const result = yield* read(email.EMAIL_PROVIDER, refused).pipe(
            Effect.result,
          );
          expect(result._tag).toBe("Failure");
        }
      }),
  );

  it("tags each provider setting with the selector it belongs to", () => {
    const channels = Env.make("email", {
      EMAIL_PROVIDER: Env.providers({ ses: { SES_KEY: Env.secret() } }),
      SMS_PROVIDER: Env.optional(
        Env.providers({ ses: { SNS_REGION: Env.optional(Env.string()) } }),
      ),
    });
    expect(Env.descriptors(channels)).toEqual([
      [
        "EMAIL_PROVIDER",
        { kind: "providers", values: ["ses"], optional: false },
      ],
      [
        "SES_KEY",
        {
          kind: "secret",
          optional: true,
          provider: { selector: "EMAIL_PROVIDER", name: "ses", required: true },
        },
      ],
      ["SMS_PROVIDER", { kind: "providers", values: ["ses"], optional: true }],
      [
        "SNS_REGION",
        {
          kind: "string",
          optional: true,
          provider: { selector: "SMS_PROVIDER", name: "ses", required: false },
        },
      ],
    ]);
  });

  it("refuses a provider setting named like a slot or selector, at compile time and at runtime", () => {
    expect(() =>
      Env.make("email", {
        // @ts-expect-error SES_KEY is also a setting of EMAIL_PROVIDER's ses provider.
        SES_KEY: Env.secret(),
        EMAIL_PROVIDER: Env.providers({ ses: { SES_KEY: Env.secret() } }),
      }),
    ).toThrowError(
      expect.objectContaining({
        _tag: "DuplicateEnvKey",
        key: "SES_KEY",
        first: "SES_KEY",
        second: "EMAIL_PROVIDER.ses.SES_KEY",
      }),
    );
    expect(() =>
      Env.make("email", {
        // @ts-expect-error SMS_PROVIDER is also a setting of EMAIL_PROVIDER's ses provider.
        SMS_PROVIDER: Env.providers({ sns: { SNS_KEY: Env.secret() } }),
        EMAIL_PROVIDER: Env.providers({ ses: { SMS_PROVIDER: Env.string() } }),
      }),
    ).toThrowError(
      expect.objectContaining({
        _tag: "DuplicateEnvKey",
        key: "SMS_PROVIDER",
      }),
    );
  });

  it.each([
    [
      "two providers of one selector",
      {
        EMAIL_PROVIDER: Env.providers({
          ses: { API_KEY: Env.secret() },
          resend: { API_KEY: Env.secret() },
        }),
      },
      "API_KEY",
      "EMAIL_PROVIDER.ses.API_KEY",
      "EMAIL_PROVIDER.resend.API_KEY",
    ],
    [
      "two selectors",
      {
        EMAIL_PROVIDER: Env.providers({ ses: { REGION: Env.string() } }),
        SMS_PROVIDER: Env.providers({ sns: { REGION: Env.string() } }),
      },
      "REGION",
      "EMAIL_PROVIDER.ses.REGION",
      "SMS_PROVIDER.sns.REGION",
    ],
  ] as const)(
    "refuses one setting name in %s at runtime",
    (_, fields, key, first, second) => {
      expect(() => Env.make("email", fields)).toThrowError(
        expect.objectContaining({
          _tag: "DuplicateEnvKey",
          key,
          first,
          second,
          message: `The env slot "${key}" is declared by ${first} and by ${second}; give each its own name.`,
        }),
      );
    },
  );
});

it.effect.each([
  "constructor",
  "toString",
  "hasOwnProperty",
  "__proto__",
  "valueOf",
])("reads the own provider group named %s", (name) =>
  Effect.gen(function* () {
    const example = Env.make("example", {
      CHOICE: Env.providers({ [name]: { REGION: Env.string() } }),
    });
    const configured = yield* read(example.CHOICE, {
      CHOICE: name,
      REGION: "fixture",
    });
    expect(configured.providers[name]).toEqual({ REGION: "fixture" });
    const result = yield* read(example.CHOICE, { CHOICE: "not-offered" }).pipe(
      Effect.result,
    );
    expect(result._tag).toBe("Failure");
  }),
);

it("refuses repeated literal values at compile time and runtime", () => {
  expect(() => {
    // @ts-expect-error Literal values must be distinct.
    Env.literals(["a", "a"]);
  }).toThrowError(
    expect.objectContaining({ _tag: "DuplicateEnvValue", value: "a" }),
  );
  const dynamic: readonly [string, ...string[]] = ["a", "a"];
  expect(() => Env.literals(dynamic)).toThrowError(
    expect.objectContaining({ _tag: "DuplicateEnvValue", value: "a" }),
  );
});

it("provider records have one own entry per name before declaration", () => {
  const groups = Rec.fromEntries([
    ["ses", {}],
    ["ses", {}],
  ]);
  expect(Env.providers(groups).descriptor).toEqual({
    kind: "providers",
    values: ["ses"],
    optional: false,
  });
});

it("accepts distinct values with a dynamic tuple member", () => {
  const values: readonly ["a", string] = ["a", "b"];
  expect(Env.literals(values).descriptor).toEqual({
    kind: "literals",
    values: ["a", "b"],
    optional: false,
  });
});
