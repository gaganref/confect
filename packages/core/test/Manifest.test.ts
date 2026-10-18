import { describe, expectTypeOf, it } from "@effect/vitest";
import type { Manifest } from "@confect/core";
import * as Redacted from "effect/Redacted";

const manifest = {
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
  http: { mounts: { email: "/email" } },
  digest: "sha256:0000",
} as const;

const required = {
  EMAIL_FROM: "sender@example.test",
  RESEND_API_KEY: Redacted.make("test-key"),
  EMAIL_TRANSPORT: "log",
} as const;

describe("Manifest", () => {
  it("accepts a generated manifest without a cast", () => {
    expectTypeOf(manifest).toExtend<Manifest.Manifest>();
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
