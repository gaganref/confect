import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Array from "effect/Array";
import { describe, expect, it } from "@effect/vitest";
import {
  Backend,
  InvalidMountSetting,
  mountVariables,
} from "@confect/alchemy/Backend";
import { Providers } from "@confect/alchemy/Providers";
import * as Output from "alchemy/Output";
import { Stack } from "alchemy/Stack";
import { inMemoryState } from "alchemy/State/InMemoryState";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { inspect } from "node:util";
import * as Record from "effect/Record";

const props = {
  deployment: {
    name: "happy-otter-123",
    url: "https://happy-otter-123.convex.cloud",
  },
  deployKey: Redacted.make("prod:happy-otter-123|test-secret"),
};
const stack = () =>
  Layer.succeed(Stack, {
    name: "test",
    stage: "test",
    resources: {},
    bindings: {},
    actions: {},
  });
const providers = Layer.succeed(Providers, {
  kind: "ProviderCollection",
  providers: {},
  get: () => undefined,
});

const formatOne = {
  format: 1,
  sections: {},
  name: "workpool",
  env: {},
  mounts: {},
  http: {},
  digest: "sha256:child",
} as const;
const invalidManifests: ReadonlyArray<readonly [string, unknown]> = [
  [
    "missing format",
    {
      name: "workpool",
      sections: {},
      env: {},
      mounts: {},
      http: {},
      digest: "sha256:child",
    },
  ],
  ...Array.map(
    [0, 2, "1"],
    (format) => [`format ${format}`, { ...formatOne, format }] as const,
  ),
  ["extra root field", { ...formatOne, extra: true }],
  [
    "extra field beside automatic",
    {
      ...formatOne,
      env: {
        STAGE: {
          kind: "string",
          optional: false,
          automatic: true,
          extra: true,
        },
      },
    },
  ],
  [
    "extra nested field",
    {
      ...formatOne,
      env: { KEY: { kind: "string", optional: false, extra: true } },
    },
  ],
  [
    "missing mounts",
    {
      format: 1,
      name: "workpool",
      sections: {},
      env: {},
      http: {},
      digest: "sha256:child",
    },
  ],
  [
    "missing digest",
    {
      format: 1,
      name: "workpool",
      sections: {},
      env: {},
      mounts: {},
      http: {},
    },
  ],
  ["null", null],
  [
    "unknown kind",
    { ...formatOne, env: { KEY: { kind: "future", optional: false } } },
  ],
  [
    "old http.mounts without mounts but with sections",
    {
      format: 1,
      sections: {},
      name: "workpool",
      env: {},
      http: { mounts: { pool: "/pool" } },
      digest: "sha256:child",
    },
  ],
  [
    "old http.mounts with current root fields",
    { ...formatOne, http: { mounts: { pool: "/pool" } } },
  ],
  [
    "PR 168 shape",
    {
      format: 1,
      name: "workpool",
      env: {},
      http: { mounts: { pool: "/pool" } },
      digest: "sha256:child",
    },
  ],
  [
    "PR 170 shape",
    {
      format: 1,
      name: "workpool",
      env: {},
      mounts: {},
      http: { mounts: { pool: "/pool" } },
      digest: "sha256:child",
    },
  ],
];

describe("Backend", () => {
  it.effect("writes automatic values separately from application env", () =>
    Effect.gen(function* () {
      const manifest = {
        ...formatOne,
        env: { STAGE: { kind: "string", optional: false, automatic: true } },
      } as const;
      const backend = yield* Backend("Backend", {
        ...props,
        manifest,
        automatic: { STAGE: "preview" },
      });
      expect(backend.environment?.Props.variables).toEqual({
        STAGE: "preview",
      });
    }).pipe(Effect.provide([stack(), providers])),
  );

  it.effect.each([
    ["undeclared", formatOne, { STAGE: "x" }, "STAGE", "NotAutomatic"],
    [
      "ordinary",
      { ...formatOne, env: { LABEL: { kind: "string", optional: true } } },
      { LABEL: "x" },
      "LABEL",
      "NotAutomatic",
    ],
    [
      "missing",
      {
        ...formatOne,
        env: { STAGE: { kind: "string", optional: false, automatic: true } },
      },
      {},
      "STAGE",
      "Missing",
    ],
  ] as const)(
    "refuses %s automatic values before writing resources",
    ([_, manifest, automatic, slot, reason]) =>
      Effect.gen(function* () {
        // The empty automatic type is {}, so an undeclared key also compiles without this boundary check.
        const input = {
          ...props,
          manifest: manifest as typeof formatOne,
          automatic,
        };
        const result = yield* Backend("Backend", input).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const defect = Cause.findDefect(result.cause);
          expect(Result.isSuccess(defect)).toBe(true);
          if (Result.isSuccess(defect)) {
            expect(defect.success).toMatchObject({
              _tag: "InvalidAutomaticSetting",
              slot,
              reason,
            });
            expect(String(defect.success)).toContain("Backend.automatic");
            expect(String(defect.success)).toContain("manifest.env");
          }
        }
      }).pipe(Effect.provide([stack(), providers])),
  );

  it.effect.each(invalidManifests)(
    "refuses a malformed manifest at Backend entry (%s)",
    ([_, manifest]) =>
      Effect.gen(function* () {
        const result = yield* Backend("Backend", {
          ...props,
          manifest: manifest as typeof formatOne,
        }).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const defect = Cause.findDefect(result.cause);
          expect(Result.isSuccess(defect)).toBe(true);
          if (Result.isFailure(defect)) return;
          expect(defect.success).toMatchObject({
            _tag: "UnsupportedManifestFormat",
            source: "confect/_generated/manifest.ts",
          });
          expect(String(defect.success)).toContain("confect codegen");
          expect(String(defect.success)).toContain("same release");
        }
      }).pipe(Effect.provide([stack(), providers])),
  );

  it.each([
    ["UnknownMount", "Use a mount name from manifest.mounts"],
    ["NotOpen", "Supply only slots listed in this mount's manifest env"],
    ["Missing", "Supply this required slot in Backend.mounts"],
    ["PlainSecret", "Wrap this secret with Redacted.make"],
  ] as const)("explains how to fix %s", (reason, remedy) => {
    const error = InvalidMountSetting.make({
      mount: "pool",
      slot: "KEY",
      reason,
    });
    expect(error.message).toContain("pool.KEY");
    expect(error.message).toContain(remedy);
  });

  it.effect(
    "namespaces Code and defaults to the locally installed Confect code generator",
    () =>
      Effect.gen(function* () {
        const first = yield* Backend("First", { ...props, cwd: "/app" });
        const second = yield* Backend("Second", props);
        expect(first.code.FQN).not.toBe(second.code.FQN);
        expect(first.code.LogicalId).toBe("Code");
        expect(first.code.Namespace?.Id).toBe("First");
        expect(first.code.Props).toEqual({
          ...props,
          cwd: "/app",
          prepare: { command: "confect", args: ["codegen"] },
        });
        expect(first.environment).toBeUndefined();
        expect(Record.keys(Output.resolveUpstream(first.url))).toEqual([
          first.code.FQN,
        ]);
        expect(Record.keys(Output.resolveUpstream(first.name))).toEqual([
          first.code.FQN,
        ]);
      }).pipe(Effect.provide([stack(), providers])),
  );

  it.effect("depends on environment values as well as its stable URL", () =>
    Effect.gen(function* () {
      const env = { TOKEN: Redacted.make("environment-secret") };
      const backend = yield* Backend("Backend", { ...props, env });
      const environment = backend.environment;
      expect(environment).toBeDefined();
      if (environment === undefined) return;
      expect(environment.LogicalId).toBe("Environment");
      expect(environment.Namespace?.Id).toBe("Backend");
      expect(environment.Props.variables).toBe(env);
      const url = backend.code.Props.deployment.url;
      expect(Record.keys(Output.resolveUpstream(url))).toEqual([
        environment.FQN,
      ]);
      const expression = inspect(url);
      expect(expression).toContain("variables");
      expect(expression).toContain("url");
      const evaluate2 = yield* Output.evaluate(url, {
        [environment.FQN]: { url: props.deployment.url, variables: {} },
      });
      expect(evaluate2).toBe(props.deployment.url);
      const unresolved = yield* Output.evaluate(url, {}).pipe(Effect.result);
      expect(Result.isFailure(unresolved)).toBe(true);
    }).pipe(Effect.provide([stack(), providers, inMemoryState()])),
  );

  it.effect(
    "registers an explicit empty environment rather than silently dropping ownership",
    () =>
      Effect.gen(function* () {
        const backend = yield* Backend("Backend", { ...props, env: {} });
        expect(backend.environment?.Props.variables).toEqual({});
      }).pipe(Effect.provide([stack(), providers])),
  );

  it.effect(
    "writes each mount's settings under the manifest's variable and refuses what it does not list",
    () =>
      Effect.gen(function* () {
        const manifest = {
          format: 1,
          sections: {},
          name: "host",
          env: {},
          mounts: {
            relay: {
              component: "relay",
              env: {
                TOKEN: {
                  kind: "secret",
                  optional: false,
                  variable: "RELAY_TOKEN",
                },
                CHILD_LABEL: {
                  kind: "string",
                  optional: true,
                  variable: "RELAY_CHILD_LABEL",
                },
              },
            },
          },
          http: {},
          digest: "sha256:0",
        } as const;
        const token = Redacted.make("token");
        const variables = yield* mountVariables(manifest, {
          relay: { TOKEN: token, CHILD_LABEL: "x" },
        });
        expect(variables).toEqual({
          RELAY_TOKEN: token,
          RELAY_CHILD_LABEL: "x",
        });
        const refused = (mounts: Parameters<typeof mountVariables>[1]) =>
          Effect.flip(mountVariables(manifest, mounts));
        const unknown = yield* refused({ relay: { TOKEN: token }, sms: {} });
        expect(unknown).toEqual(
          InvalidMountSetting.make({ mount: "sms", reason: "UnknownMount" }),
        );
        const missing = yield* refused({});
        expect(missing).toEqual(
          InvalidMountSetting.make({
            mount: "relay",
            slot: "TOKEN",
            reason: "Missing",
          }),
        );
        const plain = yield* refused({ relay: { TOKEN: "plain" } });
        expect(plain).toEqual(
          InvalidMountSetting.make({
            mount: "relay",
            slot: "TOKEN",
            reason: "PlainSecret",
          }),
        );
        const closed = yield* refused({
          relay: { TOKEN: token, REGION: "eu" },
        });
        expect(closed).toEqual(
          InvalidMountSetting.make({
            mount: "relay",
            slot: "REGION",
            reason: "NotOpen",
          }),
        );
        const backend = yield* Backend("Backend", {
          ...props,
          manifest,
          mounts: { relay: { TOKEN: token } },
        });
        expect(backend.environment?.Props.variables).toEqual({
          RELAY_TOKEN: token,
        });
        expect(backend.code.Props.manifestDigest).toBe(manifest.digest);
      }).pipe(Effect.provide([stack(), providers])),
  );
  it.effect(
    "writes a provider choice as the string Convex stores and refuses a named provider's missing slot",
    () =>
      Effect.gen(function* () {
        const manifest = {
          format: 1,
          sections: {},
          name: "host",
          env: {},
          mounts: {
            email: {
              component: "email",
              env: {
                EMAIL_PROVIDER: {
                  kind: "providers",
                  values: ["ses", "resend"],
                  optional: false,
                  variable: "EMAIL_EMAIL_PROVIDER",
                },
                RESEND_API_KEY: {
                  kind: "secret",
                  optional: true,
                  provider: { name: "resend", required: true },
                  variable: "EMAIL_RESEND_API_KEY",
                },
                SES_KEY: {
                  kind: "secret",
                  optional: true,
                  provider: { name: "ses", required: true },
                  variable: "EMAIL_SES_KEY",
                },
              },
            },
          },
          http: {},
          digest: "sha256:0",
        } as const;
        const key = Redacted.make("key");
        const variables = yield* mountVariables(manifest, {
          email: {
            EMAIL_PROVIDER: { active: "resend", standby: ["ses"] },
            RESEND_API_KEY: key,
            SES_KEY: key,
          },
        });
        expect(variables["EMAIL_EMAIL_PROVIDER"]).toBe(
          '{"active":"resend","standby":["ses"]}',
        );
        const missing = yield* Effect.flip(
          mountVariables(manifest, {
            email: {
              EMAIL_PROVIDER: { active: "resend", standby: ["ses"] },
              RESEND_API_KEY: key,
            },
          }),
        );
        expect(missing).toEqual(
          InvalidMountSetting.make({
            mount: "email",
            slot: "SES_KEY",
            reason: "Missing",
          }),
        );
      }).pipe(Effect.provide([stack(), providers])),
  );
});
