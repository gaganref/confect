import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Arr from "effect/Array";
import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Manifest } from "@confect/core";
import * as Redacted from "effect/Redacted";

const manifest = {
  format: 1,
  sections: {},
  name: "tenant",
  env: {
    EMAIL_FROM: { kind: "string", optional: false },
    RESEND_API_KEY: { kind: "secret", optional: false },
    EMAIL_TRANSPORT: {
      kind: "literals",
      values: ["resend", "log"],
      optional: false,
    },
    PLATFORM_URL: { kind: "string", optional: true },
    WEBHOOK_SECRET: { kind: "secret", optional: true },
    STAGE: { kind: "string", optional: false, automatic: true },
    EMAIL_PROVIDER: {
      kind: "providers",
      values: ["ses", "resend"],
      optional: true,
    },
  },
  mounts: {
    email: {
      component: "email",
      httpPrefix: "/email",
      env: {
        RESEND_KEY: {
          kind: "secret",
          optional: false,
          variable: "EMAIL_RESEND_KEY",
        },
        LABEL: { kind: "string", optional: true, variable: "EMAIL_LABEL" },
      },
    },
    pool: { component: "workpool", env: {} },
  },
  http: {
    app: {
      health: {
        ready: {
          method: "GET",
          path: "/health/ready",
          owner: "app",
          group: "health",
          endpoint: "ready",
          digest: "sha256:0000",
        },
      },
    },
    email: {
      webhooks: {
        resend: {
          method: "POST",
          path: "/email/webhooks/resend",
          owner: "email",
          group: "webhooks",
          endpoint: "resend",
          digest: "sha256:0000",
        },
      },
    },
  },
  digest: "sha256:0000",
} as const;

const required = {
  EMAIL_FROM: "sender@example.test",
  RESEND_API_KEY: Redacted.make("test-key"),
  EMAIL_TRANSPORT: "log",
} as const;

describe("Manifest", () => {
  it.each(["env", "mount"] as const)(
    "refuses a tagged providers slot in %s",
    (at) => {
      const slots = {
        OUTER: { kind: "providers", values: ["outer"], optional: false },
        INNER: {
          kind: "providers",
          values: ["inner"],
          optional: true,
          provider: { selector: "OUTER", name: "outer", required: true },
        },
      } as const;
      const result = Manifest.decode(
        {
          ...manifest,
          ...(at === "env"
            ? { env: slots }
            : {
                mounts: {
                  relay: {
                    component: "relay",
                    env: Rec.map(slots, (slot, key) => ({
                      ...slot,
                      variable: `RELAY_${key}`,
                    })),
                  },
                },
              }),
        },
        "fixture",
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure.reason).toContain(
          "providers slot cannot be a provider setting",
        );
    },
  );

  it.each(["selector", "setting"] as const)(
    "refuses an automatic provider %s with an explicit reason",
    (kind) => {
      const selector = {
        kind: "providers",
        values: ["ses"],
        optional: false,
      } as const;
      const input = {
        ...manifest,
        env: {
          CHOICE: {
            ...selector,
            ...(kind === "selector" ? { automatic: true as const } : {}),
          },
          ...(kind === "setting"
            ? {
                KEY: {
                  kind: "secret",
                  optional: false,
                  automatic: true,
                  provider: { selector: "CHOICE", name: "ses", required: true },
                },
              }
            : {}),
        },
      };
      const result = Manifest.decode(input, "fixture");
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure.reason).toContain(
          kind === "selector"
            ? "providers slot cannot be automatic"
            : "provider setting cannot be automatic",
        );
    },
  );

  it.each(["literals", "providers"] as const)(
    "refuses repeated values in a %s slot",
    (kind) => {
      const result = Manifest.decode(
        {
          ...manifest,
          env: { CHOICE: { kind, optional: false, values: ["a", "a"] } },
        },
        "fixture",
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure.reason).toContain("repeated value");
    },
  );

  it.each(["constructor", "toString", "hasOwnProperty", "valueOf"])(
    "uses an own selector named %s",
    (name) => {
      const setting = {
        kind: "secret",
        optional: true,
        provider: { selector: name, name: "ses", required: true },
      };
      const absent = Manifest.decode(
        { ...manifest, env: { KEY: setting } },
        "fixture",
      );
      expect(Result.isFailure(absent)).toBe(true);
      const present = Manifest.decode(
        {
          ...manifest,
          env: {
            [name]: { kind: "providers", values: ["ses"], optional: false },
            KEY: setting,
          },
        },
        "fixture",
      );
      expect(Result.isSuccess(present)).toBe(true);
    },
  );

  it.each([
    ["bad-key", "letters, digits and underscores, starting with a letter"],
    ["__proto__", "letters, digits and underscores, starting with a letter"],
    ["CONVEX_SITE_URL", "reserved for a Convex built-in address"],
    ["CONVEX_CLOUD_URL", "reserved for a Convex built-in address"],
  ])("refuses the root env key %s, naming the variable rule", (key, rule) => {
    const decoded = Manifest.decode(
      {
        ...manifest,
        env: { [key]: { kind: "string", optional: false } },
      },
      "fixture",
    );
    expect(Result.isFailure(decoded)).toBe(true);
    if (Result.isFailure(decoded)) {
      expect(decoded.failure._tag).toBe("UnsupportedManifestFormat");
      expect(decoded.failure.reason).toContain(
        `env.${key} declares the variable "${key}"`,
      );
      expect(decoded.failure.reason).toContain(rule);
    }
  });

  it("decodes without changing the imported value", () => {
    const decoded = Manifest.decode(manifest, "@tenant/backend/manifest");
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) expect(decoded.success).toBe(manifest);
  });

  it.each([
    ...Arr.map(
      [
        "format",
        "name",
        "env",
        "mounts",
        "http",
        "digest",
        "sections",
      ] as const,
      (field) =>
        [
          `missing ${field}`,
          Rec.filter(manifest, (_, key) => key !== field),
        ] as const,
    ),
    ["extra root field", { ...manifest, extra: true }],
    [
      "extra field beside providers",
      {
        ...manifest,
        env: {
          CHOICE: {
            kind: "providers",
            values: ["ses"],
            optional: false,
            extra: true,
          },
        },
      },
    ],
    [
      "extra field beside provider tag",
      {
        ...manifest,
        env: {
          CHOICE: { kind: "providers", values: ["ses"], optional: false },
          KEY: {
            kind: "secret",
            optional: true,
            provider: { selector: "CHOICE", name: "ses", required: true },
            extra: true,
          },
        },
      },
    ],
    [
      "extra provider tag field",
      {
        ...manifest,
        env: {
          CHOICE: { kind: "providers", values: ["ses"], optional: false },
          KEY: {
            kind: "secret",
            optional: true,
            provider: {
              selector: "CHOICE",
              name: "ses",
              required: true,
              extra: true,
            },
          },
        },
      },
    ],
    [
      "extra field beside automatic",
      { ...manifest, env: { STAGE: { ...manifest.env.STAGE, extra: true } } },
    ],
    [
      "extra env field",
      {
        ...manifest,
        env: { KEY: { kind: "string", optional: false, extra: true } },
      },
    ],
    [
      "unknown kind",
      { ...manifest, env: { KEY: { kind: "new", optional: false } } },
    ],
    [
      "empty literals",
      {
        ...manifest,
        env: { KEY: { kind: "literals", optional: false, values: [] } },
      },
    ],
    [
      "extra mount field",
      {
        ...manifest,
        mounts: { pool: { component: "pool", env: {}, extra: true } },
      },
    ],
    [
      "extra open slot field",
      {
        ...manifest,
        mounts: {
          pool: {
            component: "pool",
            env: {
              KEY: {
                kind: "secret",
                optional: false,
                variable: "POOL_KEY",
                extra: true,
              },
            },
          },
        },
      },
    ],
    [
      "unknown open slot kind",
      {
        ...manifest,
        mounts: {
          pool: {
            component: "pool",
            env: {
              KEY: { kind: "new", optional: false, variable: "POOL_KEY" },
            },
          },
        },
      },
    ],
    [
      "extra route field",
      {
        ...manifest,
        http: {
          app: {
            health: {
              ready: { ...manifest.http.app.health.ready, extra: true },
            },
          },
        },
      },
    ],
    ["null", null],
  ] satisfies ReadonlyArray<readonly [string, unknown]>)(
    "refuses a closed-contract violation (%s)",
    (_, input) => {
      const decoded = Manifest.decode(input, "@tenant/backend/manifest");
      expect(Result.isFailure(decoded)).toBe(true);
      if (Result.isFailure(decoded)) {
        expect(decoded.failure).toBeInstanceOf(
          Manifest.UnsupportedManifestFormat,
        );
        expect(decoded.failure.source).toBe("@tenant/backend/manifest");
        expect(decoded.failure.message).toContain("confect codegen");
        expect(decoded.failure.message).toContain("same release");
      }
    },
  );

  it("accepts a generated manifest without a cast", () => {
    expectTypeOf(manifest).toExtend<Manifest.Manifest>();
  });

  it("refuses a manifest of another format", () => {
    expectTypeOf({
      ...manifest,
      format: 2,
    } as const).not.toExtend<Manifest.Manifest>();
  });

  it("types each mount's open slots, refusing a missing value, a plain secret and an unknown mount", () => {
    const mounts: Manifest.Mounts<typeof manifest> = {
      email: { RESEND_KEY: Redacted.make("key") },
    };
    // @ts-expect-error A mount with a required open slot must be supplied.
    const absent: Manifest.Mounts<typeof manifest> = {};
    const missing: Manifest.Mounts<typeof manifest> = {
      // @ts-expect-error The required open slot RESEND_KEY is missing.
      email: { LABEL: "x" },
    };
    const plain: Manifest.Mounts<typeof manifest> = {
      // @ts-expect-error An open secret slot takes Redacted, never a plain string.
      email: { RESEND_KEY: "plain-text" },
    };
    const unknown: Manifest.Mounts<typeof manifest> = {
      email: { RESEND_KEY: Redacted.make("key") },
      // @ts-expect-error The manifest lists no mount named "sms".
      sms: {},
    };
    void [mounts, absent, missing, plain, unknown];
  });

  it("types a provider choice as one provider, a failover or a pool", () => {
    const values = (EMAIL_PROVIDER: unknown) => ({
      ...required,
      EMAIL_PROVIDER,
    });
    const fixed: Manifest.Values<typeof manifest> = {
      ...required,
      EMAIL_PROVIDER: "ses",
    };
    const failover: Manifest.Values<typeof manifest> = {
      ...required,
      EMAIL_PROVIDER: { active: "ses", standby: ["resend"] },
    };
    const pool: Manifest.Values<typeof manifest> = {
      ...required,
      EMAIL_PROVIDER: { pool: ["ses", "resend"] },
    };
    const misspelled: Manifest.Values<typeof manifest> = {
      ...required,
      // @ts-expect-error The choice names only the providers the slot declares.
      EMAIL_PROVIDER: "sendgrid",
    };
    const empty: Manifest.Values<typeof manifest> = {
      ...required,
      // @ts-expect-error A standby list names at least one provider.
      EMAIL_PROVIDER: { active: "ses", standby: [] },
    };
    void [values, fixed, failover, pool, misspelled, empty];
  });

  it("leaves automatic slots to the framework that installed them", () => {
    const automatic: Manifest.Automatic<typeof manifest> = { STAGE: "staging" };
    const supplied: Manifest.Values<typeof manifest> = {
      ...required,
      // @ts-expect-error An automatic slot is not the product's to supply.
      STAGE: "staging",
    };
    void [automatic, supplied];
  });

  it("lists every route, and a route from another build is none of them", () => {
    const route: Manifest.RouteOf<typeof manifest> =
      manifest.http.email.webhooks.resend;
    const stale = {
      ...manifest.http.email.webhooks.resend,
      digest: "sha256:1111",
    } as const;
    // @ts-expect-error A route leaf from another build's digest is refused.
    const refused: Manifest.RouteOf<typeof manifest> = stale;
    void [route, refused];
  });

  it("types the values infra must supply", () => {
    const values: Manifest.Values<typeof manifest> = required;
    const withOptional: Manifest.Values<typeof manifest> = {
      ...required,
      PLATFORM_URL: "https://platform.example.test",
      WEBHOOK_SECRET: Redacted.make("webhook"),
    };
    const { RESEND_API_KEY: _, ...withoutKey } = required;
    // @ts-expect-error A required value cannot be omitted.
    const missing: Manifest.Values<typeof manifest> = withoutKey;
    const plain: Manifest.Values<typeof manifest> = {
      ...required,
      // @ts-expect-error A secret is supplied as Redacted, never a plain string.
      RESEND_API_KEY: "plain-text",
    };
    const literal: Manifest.Values<typeof manifest> = {
      ...required,
      // @ts-expect-error A literal value must be one the declaration lists.
      EMAIL_TRANSPORT: "smtp",
    };
    const optionalSecret: Manifest.Values<typeof manifest> = {
      ...required,
      // @ts-expect-error An optional secret is still Redacted when supplied.
      WEBHOOK_SECRET: "plain-text",
    };
    void [values, withOptional, missing, plain, literal, optionalSecret];
  });

  const refusal = (input: unknown) => {
    const decoded = Manifest.decode(input, "@tenant/backend/manifest");
    expect(Result.isFailure(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) throw new Error("decoded");
    expect(decoded.failure._tag).toBe("UnsupportedManifestFormat");
    return decoded.failure;
  };
  const choice = {
    kind: "providers",
    values: ["ses", "resend"],
    optional: false,
  } as const;
  const tagged = (selector: string, name = "ses") =>
    ({
      kind: "secret",
      optional: true,
      provider: { selector, name, required: true },
    }) as const;
  const opened = (variable: string) => ({ variable });

  it("accepts a provider tag whose selector is a providers slot of its own record", () => {
    const decoded = Manifest.decode(
      {
        ...manifest,
        env: { ...manifest.env, SES_KEY: tagged("EMAIL_PROVIDER") },
        mounts: {
          email: {
            component: "email",
            env: {
              CHOICE: { ...choice, ...opened("EMAIL_CHOICE") },
              KEY: { ...tagged("CHOICE", "resend"), ...opened("EMAIL_KEY") },
            },
          },
        },
      },
      "@tenant/backend/manifest",
    );
    expect(Result.isSuccess(decoded)).toBe(true);
  });

  const rules: ReadonlyArray<readonly [string, unknown, string]> = [
    [
      "a tag without its selector",
      {
        ...manifest,
        env: {
          ...manifest.env,
          SES_KEY: {
            kind: "secret",
            optional: true,
            provider: { name: "ses", required: true },
          },
        },
      },
      "selector",
    ],
    [
      "a selector that names no slot",
      { ...manifest, env: { ...manifest.env, SES_KEY: tagged("MISSING") } },
      "env.SES_KEY names the provider selector MISSING, which is not a providers slot of env",
    ],
    [
      "a selector that names a slot of another kind",
      {
        ...manifest,
        env: { ...manifest.env, SES_KEY: tagged("EMAIL_TRANSPORT") },
      },
      "env.SES_KEY names the provider selector EMAIL_TRANSPORT, which is not a providers slot of env",
    ],
    [
      "a selector that names a slot of another record",
      {
        ...manifest,
        mounts: {
          email: {
            component: "email",
            env: {
              KEY: { ...tagged("EMAIL_PROVIDER"), ...opened("EMAIL_KEY") },
            },
          },
        },
      },
      "mounts.email.env.KEY names the provider selector EMAIL_PROVIDER, which is not a providers slot of mounts.email.env",
    ],
    [
      "a provider its selector does not offer",
      {
        ...manifest,
        env: { ...manifest.env, SMS_KEY: tagged("EMAIL_PROVIDER", "sms") },
      },
      "env.SMS_KEY names the provider sms, which env.EMAIL_PROVIDER does not offer",
    ],
    [
      "an optional automatic slot",
      {
        ...manifest,
        env: {
          ...manifest.env,
          STAGE: { kind: "string", optional: true, automatic: true },
        },
      },
      "env.STAGE is automatic and optional; an automatic slot is required",
    ],
    ...Arr.map(
      ["1BAD", "HAS-DASH", "", "CONVEX_SITE_URL", "CONVEX_CLOUD_URL"],
      (variable) =>
        [
          `the variable "${variable}"`,
          {
            ...manifest,
            mounts: {
              email: {
                component: "email",
                env: {
                  KEY: {
                    kind: "string",
                    optional: false,
                    ...opened(variable),
                  },
                },
              },
            },
          },
          `mounts.email.env.KEY declares the variable "${variable}", which`,
        ] as const,
    ),
    ...Arr.map(
      ["owner", "group", "endpoint"] as const,
      (field) =>
        [
          `a route leaf whose ${field} differs from its key`,
          {
            ...manifest,
            http: {
              ...manifest.http,
              app: {
                health: {
                  ready: {
                    ...manifest.http.app.health.ready,
                    [field]: "other",
                  },
                },
              },
            },
          },
          `http.app.health.ready has ${field} "other", not the key it sits under`,
        ] as const,
    ),
    [
      "a route leaf from another build",
      {
        ...manifest,
        http: {
          ...manifest.http,
          app: {
            health: {
              ready: {
                ...manifest.http.app.health.ready,
                digest: "sha256:1111",
              },
            },
          },
        },
      },
      "http.app.health.ready carries digest sha256:1111, not the manifest's sha256:0000",
    ],
  ];
  it.each(rules)("refuses %s, naming the rule", (_, input, rule) => {
    const failure = refusal(input);
    expect(failure.reason).toContain(rule);
    expect(failure.remedy).toBe("Regenerate");
  });

  it("names the variable rule a reserved and a malformed variable break", () => {
    const at = (variable: string) =>
      refusal({
        ...manifest,
        mounts: {
          email: {
            component: "email",
            env: {
              KEY: { kind: "string", optional: false, variable },
            },
          },
        },
      }).reason;
    expect(at("CONVEX_SITE_URL")).toContain("reserved");
    expect(at("1BAD")).toContain(
      "letters, digits and underscores, starting with a letter",
    );
  });

  it.each([
    [2, "Upgrade"],
    [7, "Upgrade"],
    [0, "Regenerate"],
    ["1", "Regenerate"],
    [undefined, "Regenerate"],
  ] as const)("gives format %s the %s remedy", (format, remedy) => {
    const { format: _, ...rest } = manifest;
    const failure = refusal(
      format === undefined ? rest : { ...manifest, format },
    );
    expect(failure.remedy).toBe(remedy);
    if (remedy === "Upgrade") {
      expect(failure.message).toContain(
        "Upgrade the Confect packages that read it",
      );
      expect(failure.message).not.toContain("same release");
    } else {
      expect(failure.message).toContain("confect codegen");
      expect(failure.message).toContain("same release");
    }
  });

  it("tells a malformed shape at the current format to regenerate", () => {
    const failure = refusal({ ...manifest, env: { KEY: { kind: "new" } } });
    expect(failure.remedy).toBe("Regenerate");
    expect(failure.message).toContain("same release");
  });
});
