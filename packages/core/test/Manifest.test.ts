import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Arr from "effect/Array";
import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Manifest } from "@confect/core";
import * as Redacted from "effect/Redacted";

const manifest = {
  format: 1,
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
          key: "ready",
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
          key: "resend",
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
  it("decodes without changing the imported value", () => {
    const decoded = Manifest.decode(manifest, "@tenant/backend/manifest");
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) expect(decoded.success).toBe(manifest);
  });

  it.each([
    ...Arr.map(
      ["format", "name", "env", "mounts", "http", "digest"] as const,
      (field) =>
        [
          `missing ${field}`,
          Rec.filter(manifest, (_, key) => key !== field),
        ] as const,
    ),
    ["extra root field", { ...manifest, extra: true }],
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
});
