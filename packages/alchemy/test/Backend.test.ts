import * as Option from "effect/Option";
import * as Str from "effect/String";
import * as Config from "effect/Config";
import * as HealthModule from "@confect/core/HealthModule";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import * as Array from "effect/Array";
import { describe, expect, it } from "@effect/vitest";
import {
  Backend,
  InvalidMountSetting,
  mountVariables,
} from "@confect/alchemy/Backend";
import { Providers } from "@confect/alchemy/Providers";
import type * as Manifest from "@confect/core/Manifest";
import * as Output from "alchemy/Output";
import { Stack } from "alchemy/Stack";
import { inMemoryState } from "alchemy/State/InMemoryState";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { inspect } from "node:util";
import * as Record from "effect/Record";
import * as Code from "@confect/alchemy/Code";
import * as EnvironmentVariables from "@confect/alchemy/EnvironmentVariables";
import * as UsageLimit from "@confect/alchemy/UsageLimit";
import * as Provider from "alchemy/Provider";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { CommandRunner } from "../src/internal/CommandRunner";
import { PushLock } from "../src/internal/PushLock";
import { ConvexClient } from "@confect/alchemy/ConvexClient";
import { makeEngine } from "./fixtures/Engine";
import { mockClient } from "./fixtures/ConvexClient";
import * as NodeServices from "./fixtures/NodeTestServices";

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
    "extra field beside providers",
    {
      ...formatOne,
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
      ...formatOne,
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
      ...formatOne,
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
  it.effect.each([
    { driftPolicy: "error" },
    { adoptMatching: true },
    { unownedPolicy: "error" },
    { lock: { deploymentName: "happy-otter-123" } },
    { retry: { maxAttempts: 4, delay: "25 millis" } },
  ] as const)(
    "forwards environment safety options %j on each declaration",
    (environment) =>
      Effect.gen(function* () {
        const env = { LABEL: "preview" };
        const input = { ...props, env, environment };
        const plain = yield* Backend("Plain", input);
        expect(plain.environment?.Props).toEqual({
          url: props.deployment.url,
          deployKey: props.deployKey,
          variables: env,
          ...environment,
        });
        const declared = yield* Backend("Declared", {
          ...input,
          manifest: {
            ...formatOne,
            env: { LABEL: { kind: "string", optional: false } },
          },
        });
        expect(declared.environment?.Props).toEqual({
          url: props.deployment.url,
          deployKey: props.deployKey,
          variables: env,
          ...environment,
        });
      }).pipe(Effect.provide([stack(), providers])),
  );

  it.effect(
    "keeps environment defaults on each declaration when safety options are omitted",
    () =>
      Effect.gen(function* () {
        const env = { LABEL: "preview" };
        const plain = yield* Backend("Plain", { ...props, env });
        expect(plain.environment?.Props).toEqual({
          url: props.deployment.url,
          deployKey: props.deployKey,
          variables: env,
        });
        const declared = yield* Backend("Declared", {
          ...props,
          env,
          manifest: {
            ...formatOne,
            env: { LABEL: { kind: "string", optional: false } },
          },
        });
        expect(declared.environment?.Props).toEqual({
          url: props.deployment.url,
          deployKey: props.deployKey,
          variables: env,
        });
      }).pipe(Effect.provide([stack(), providers])),
  );

  it.effect(
    "does not declare environment ownership for safety options alone",
    () =>
      Effect.gen(function* () {
        const input = {
          ...props,
          environment: { driftPolicy: "error" as const },
        };
        const plain = yield* Backend("Plain", input);
        expect(plain.environment).toBeUndefined();
        const declared = yield* Backend("Declared", {
          ...input,
          manifest: formatOne,
        });
        expect(declared.environment).toBeUndefined();
      }).pipe(Effect.provide([stack(), providers])),
  );

  it.effect.each([false, true])(
    "does not declare environment ownership when env is omitted and no value is required, optional slot=%s",
    (withOptionalSlot) =>
      Effect.gen(function* () {
        const env: Readonly<
          Record<string, { readonly kind: "string"; readonly optional: true }>
        > = withOptionalSlot
          ? { TOKEN: { kind: "string", optional: true } }
          : {};
        const backend = yield* Backend("Backend", {
          ...props,
          manifest: { ...formatOne, env },
        });
        expect(backend.environment).toBeUndefined();
      }).pipe(Effect.provide([stack(), providers])),
  );

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
          const later =
            Predicate.hasProperty(manifest, "format") && manifest.format === 2;
          expect(String(defect.success)).toContain(
            later
              ? "Upgrade the Confect packages that read it"
              : "confect codegen",
          );
          if (!later) expect(String(defect.success)).toContain("same release");
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
    "writes root provider pools and checks the settings of every named provider",
    () =>
      Effect.gen(function* () {
        const manifest = {
          ...formatOne,
          env: {
            PROVIDER: {
              kind: "providers",
              values: ["ses", "resend"],
              optional: false,
            },
            SES_KEY: {
              kind: "secret",
              optional: true,
              provider: { selector: "PROVIDER", name: "ses", required: true },
            },
            RESEND_KEY: {
              kind: "secret",
              optional: true,
              provider: {
                selector: "PROVIDER",
                name: "resend",
                required: true,
              },
            },
          },
        } as const;
        const env = {
          PROVIDER: { pool: ["ses", "resend"] as const },
          SES_KEY: Redacted.make("ses"),
          RESEND_KEY: Redacted.make("resend"),
        };
        const backend = yield* Backend("Backend", { ...props, manifest, env });
        expect(backend.environment?.Props.variables).toEqual({
          ...env,
          PROVIDER: '{"pool":["ses","resend"]}',
        });
        const result = yield* Backend("Missing", {
          ...props,
          manifest,
          env: { PROVIDER: "ses" },
        }).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const defect = Cause.findDefect(result.cause);
          expect(Result.isSuccess(defect)).toBe(true);
          if (Result.isSuccess(defect)) {
            expect(defect.success).toMatchObject({
              _tag: "InvalidMountSetting",
              slot: "SES_KEY",
              reason: "Missing",
            });
            expect(String(defect.success)).toContain("Backend.env");
          }
        }
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
                  provider: {
                    selector: "EMAIL_PROVIDER",
                    name: "resend",
                    required: true,
                  },
                  variable: "EMAIL_RESEND_API_KEY",
                },
                SES_KEY: {
                  kind: "secret",
                  optional: true,
                  provider: {
                    selector: "EMAIL_PROVIDER",
                    name: "ses",
                    required: true,
                  },
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

const selector = (...values: readonly [string, ...Array<string>]) =>
  ({ kind: "providers", values, optional: false }) as const;
const setting = (chooser: string, name: string) =>
  ({
    kind: "secret",
    optional: true,
    provider: { selector: chooser, name, required: true },
  }) as const;
const variable = <D extends object>(descriptor: D, name: string) => ({
  ...descriptor,
  variable: name,
});
const defectOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) throw new Error("Backend succeeded");
  const defect = Cause.findDefect(exit.cause);
  if (Result.isFailure(defect))
    throw new Error("Backend failed without a defect");
  return defect.success;
};

const prototypeNames = [
  "constructor",
  "toString",
  "hasOwnProperty",
  "__proto__",
  "valueOf",
] as const;
const rootEnvNames = Array.filter(
  prototypeNames,
  (name) => name !== "__proto__",
);

describe("Backend own settings", () => {
  it.effect.each(rootEnvNames)(
    "does not inherit the required provider setting %s",
    (slot) =>
      Effect.gen(function* () {
        const manifest: Manifest.Manifest = {
          ...formatOne,
          env: { CHOICE: selector("ses"), [slot]: setting("CHOICE", "ses") },
        };
        const result = yield* Backend("Backend", {
          ...props,
          manifest,
          env: { CHOICE: "ses" },
        }).pipe(Effect.exit);
        expect(defectOf(result)).toMatchObject({
          _tag: "InvalidMountSetting",
          slot,
          reason: "Missing",
        });
      }).pipe(Effect.provide([stack(), providers])),
  );
  it.effect.each(prototypeNames)(
    "does not inherit the required mount slot %s",
    (slot) =>
      Effect.gen(function* () {
        const manifest: Manifest.Manifest = {
          ...formatOne,
          mounts: {
            relay: {
              component: "relay",
              env: {
                [slot]: {
                  kind: "string",
                  optional: false,
                  variable: "RELAY_SLOT",
                },
              },
            },
          },
        };
        const result = yield* mountVariables(manifest, { relay: {} }).pipe(
          Effect.result,
        );
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "InvalidMountSetting", slot, reason: "Missing" },
        });
      }),
  );
  it.effect.each(rootEnvNames)(
    "does not inherit the automatic slot %s",
    (slot) =>
      Effect.gen(function* () {
        const manifest: Manifest.Manifest = {
          ...formatOne,
          env: {
            [slot]: {
              kind: "string",
              optional: false,
              automatic: true as const,
            },
          },
        };
        const result = yield* Backend("Backend", {
          ...props,
          manifest,
          automatic: {},
        }).pipe(Effect.exit);
        expect(defectOf(result)).toMatchObject({
          _tag: "InvalidAutomaticSetting",
          slot,
          reason: "Missing",
        });
      }).pipe(Effect.provide([stack(), providers])),
  );
  it.effect.each(prototypeNames)("does not inherit the mount %s", (mount) =>
    Effect.gen(function* () {
      const manifest: Manifest.Manifest = {
        ...formatOne,
        mounts: {
          [mount]: {
            component: "relay",
            env: {
              TOKEN: {
                kind: "string",
                optional: false,
                variable: "RELAY_TOKEN",
              },
            },
          },
        },
      };
      const inherited = Object.create({
        [mount]: { TOKEN: "present" },
      }) as Record<string, Record<string, string>>;
      const result = yield* mountVariables(manifest, inherited).pipe(
        Effect.result,
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "InvalidMountSetting",
          mount,
          slot: "TOKEN",
          reason: "Missing",
        },
      });
    }),
  );
  it.effect.each([false, true])(
    "keeps the empty-record fallback for an undefined mount, optional=%s",
    (optional) =>
      Effect.gen(function* () {
        const manifest: Manifest.Manifest = {
          ...formatOne,
          mounts: {
            relay: {
              component: "relay",
              env: {
                TOKEN: { kind: "string", optional, variable: "RELAY_TOKEN" },
              },
            },
          },
        };
        const mounts = { relay: undefined } as unknown as Parameters<
          typeof mountVariables
        >[1];
        const result = yield* mountVariables(manifest, mounts).pipe(
          Effect.result,
        );
        if (optional) expect(result).toEqual(Result.succeed({}));
        else
          expect(result).toEqual(
            Result.fail(
              InvalidMountSetting.make({
                mount: "relay",
                slot: "TOKEN",
                reason: "Missing",
              }),
            ),
          );
      }),
  );
  it.effect.each(rootEnvNames)("preserves an own value for slot %s", (slot) =>
    Effect.gen(function* () {
      const manifest = {
        ...formatOne,
        env: { [slot]: { kind: "string", optional: false } },
      } as const;
      const env: Record<string, string> = { [slot]: "present" };
      const backend = yield* Backend("Backend", {
        ...props,
        manifest,
        env,
      });
      expect(Record.has(backend.environment!.Props.variables, slot)).toBe(true);
      expect(backend.environment!.Props.variables[slot]).toBe("present");
    }).pipe(Effect.provide([stack(), providers])),
  );
});

describe("Backend provider selectors", () => {
  const key = Redacted.make("key");

  it.effect(
    "matches root settings to the selector that tags them, not to a provider name another selector shares",
    () =>
      Effect.gen(function* () {
        const manifest = {
          ...formatOne,
          env: {
            EMAIL_PROVIDER: selector("ses", "resend"),
            EMAIL_SES_KEY: setting("EMAIL_PROVIDER", "ses"),
            RESEND_KEY: setting("EMAIL_PROVIDER", "resend"),
            SMS_PROVIDER: selector("ses", "twilio"),
            SMS_SES_KEY: setting("SMS_PROVIDER", "ses"),
            TWILIO_KEY: setting("SMS_PROVIDER", "twilio"),
          },
        } as const;
        const env = {
          EMAIL_PROVIDER: "resend",
          RESEND_KEY: key,
          SMS_PROVIDER: "ses",
          SMS_SES_KEY: key,
        } as const;
        const backend = yield* Backend("Backend", { ...props, manifest, env });
        expect(backend.environment?.Props.variables).toEqual(env);
        const { SMS_SES_KEY: _, ...withoutKey } = env;
        const exit = yield* Backend("Missing", {
          ...props,
          manifest,
          env: withoutKey,
        }).pipe(Effect.exit);
        const missing = defectOf(exit);
        expect(missing).toEqual(
          InvalidMountSetting.make({
            mount: "app",
            slot: "SMS_SES_KEY",
            reason: "Missing",
          }),
        );
      }).pipe(Effect.provide([stack(), providers])),
  );

  it.effect(
    "keeps the selectors of two components under one host and of three nested levels apart",
    () =>
      Effect.gen(function* () {
        const email = {
          EMAIL_PROVIDER: variable(
            selector("ses", "resend"),
            "A_EMAIL_PROVIDER",
          ),
          SES_KEY: variable(setting("EMAIL_PROVIDER", "ses"), "A_SES_KEY"),
        };
        const manifest = {
          ...formatOne,
          mounts: {
            a: { component: "email", env: email },
            b: {
              component: "email",
              env: {
                EMAIL_PROVIDER: variable(
                  selector("ses", "resend"),
                  "B_EMAIL_PROVIDER",
                ),
                SES_KEY: variable(
                  setting("EMAIL_PROVIDER", "ses"),
                  "B_SES_KEY",
                ),
              },
            },
            relay: {
              component: "relay",
              env: {
                EMAIL_PROVIDER: variable(
                  selector("ses", "resend"),
                  "RELAY_EMAIL_PROVIDER",
                ),
                SES_KEY: variable(
                  setting("EMAIL_PROVIDER", "ses"),
                  "RELAY_SES_KEY",
                ),
                INNER_EMAIL_PROVIDER: variable(
                  selector("ses", "resend"),
                  "RELAY_INNER_EMAIL_PROVIDER",
                ),
                INNER_SES_KEY: variable(
                  setting("INNER_EMAIL_PROVIDER", "ses"),
                  "RELAY_INNER_SES_KEY",
                ),
                INNER_DEEP_EMAIL_PROVIDER: variable(
                  selector("ses", "resend"),
                  "RELAY_INNER_DEEP_EMAIL_PROVIDER",
                ),
                INNER_DEEP_SES_KEY: variable(
                  setting("INNER_DEEP_EMAIL_PROVIDER", "ses"),
                  "RELAY_INNER_DEEP_SES_KEY",
                ),
              },
            },
          },
        } as const;
        const variables = yield* mountVariables(manifest, {
          a: { EMAIL_PROVIDER: "resend" },
          b: { EMAIL_PROVIDER: "ses", SES_KEY: key },
          relay: {
            EMAIL_PROVIDER: "resend",
            INNER_EMAIL_PROVIDER: "resend",
            INNER_DEEP_EMAIL_PROVIDER: "ses",
            INNER_DEEP_SES_KEY: key,
          },
        });
        expect(variables).toEqual({
          A_EMAIL_PROVIDER: "resend",
          B_EMAIL_PROVIDER: "ses",
          B_SES_KEY: key,
          RELAY_EMAIL_PROVIDER: "resend",
          RELAY_INNER_EMAIL_PROVIDER: "resend",
          RELAY_INNER_DEEP_EMAIL_PROVIDER: "ses",
          RELAY_INNER_DEEP_SES_KEY: key,
        });
        const missing = yield* Effect.flip(
          mountVariables(manifest, {
            a: { EMAIL_PROVIDER: "resend" },
            b: { EMAIL_PROVIDER: "resend" },
            relay: {
              EMAIL_PROVIDER: "resend",
              INNER_EMAIL_PROVIDER: "ses",
              INNER_DEEP_EMAIL_PROVIDER: "resend",
            },
          }),
        );
        expect(missing).toEqual(
          InvalidMountSetting.make({
            mount: "relay",
            slot: "INNER_SES_KEY",
            reason: "Missing",
          }),
        );
      }),
  );

  it.effect.each([
    ["an unknown provider", "sms"],
    ["an empty pool", { pool: [] }],
    [
      "an active provider repeated in standby",
      { active: "ses", standby: ["ses"] },
    ],
    ["an unknown standby", { active: "ses", standby: ["sms"] }],
    ["a raw object", { name: "ses" }],
    ["a choice already written as JSON", '{"pool":["ses"]}'],
  ] as const)(
    "refuses %s with the handler's schema before declaring any resource",
    ([_, choice]) =>
      Effect.gen(function* () {
        const manifest = {
          ...formatOne,
          env: {
            EMAIL_PROVIDER: selector("ses", "resend"),
            SES_KEY: setting("EMAIL_PROVIDER", "ses"),
          },
        } as const;
        const declared = {
          name: "test",
          stage: "test",
          resources: {},
          bindings: {},
          actions: {},
        };
        const exit = yield* Backend("Backend", {
          ...props,
          manifest,
          // A choice from untyped code reaches the boundary unchecked.
          env: { EMAIL_PROVIDER: choice as "ses", SES_KEY: key },
        }).pipe(Effect.provideService(Stack, declared), Effect.exit);
        expect(defectOf(exit)).toEqual(
          InvalidMountSetting.make({
            mount: "app",
            slot: "EMAIL_PROVIDER",
            reason: "InvalidChoice",
          }),
        );
        expect(Record.keys(declared.resources)).toEqual([]);
        const accepted = yield* Backend("Accepted", {
          ...props,
          manifest,
          env: { EMAIL_PROVIDER: "ses", SES_KEY: key },
        }).pipe(Effect.provideService(Stack, declared));
        expect(accepted.environment).toBeDefined();
        expect(Record.keys(declared.resources)).not.toEqual([]);
      }).pipe(Effect.provide([providers])),
  );

  it("explains how to fix InvalidChoice", () => {
    const error = InvalidMountSetting.make({
      mount: "email",
      slot: "EMAIL_PROVIDER",
      reason: "InvalidChoice",
    });
    expect(error.message).toContain("email.EMAIL_PROVIDER");
    expect(error.message).toContain(
      "Name one of the providers this selector offers, or a failover or pool of them",
    );
  });

  it.effect.each(invalidManifests)(
    "refuses a malformed manifest passed to mountVariables (%s)",
    ([_, manifest]) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          mountVariables(manifest as typeof formatOne, {}),
        );
        expect(failure).toMatchObject({
          _tag: "UnsupportedManifestFormat",
          source: "confect/_generated/manifest.ts",
        });
      }),
  );
});

describe("Backend choices from outputs", () => {
  const manifest = {
    ...formatOne,
    env: {
      EMAIL_PROVIDER: selector("ses", "resend"),
      SES_KEY: setting("EMAIL_PROVIDER", "ses"),
      RESEND_KEY: setting("EMAIL_PROVIDER", "resend"),
    },
  } as const;
  const key = Redacted.make("output-test-key");
  const limit: UsageLimit.UsageLimitProps = {
    deployment: props.deployment,
    metric: "functionCalls",
    window: "month",
    limit: 1,
  };

  /**
   * Plan and apply a stack whose provider choice is an output of another
   * resource. The fake prepare writes the health module codegen writes, the
   * fake push records itself, and the fake client answers the health query.
   */
  type Inputs = (upstream: Output.Output<string>) => {
    readonly manifest: Manifest.Manifest;
    readonly env?: Record<string, unknown>;
    readonly mounts?: Record<string, Record<string, unknown>>;
    readonly automatic?: Record<string, unknown>;
  };
  const choosing =
    (choice: unknown): Inputs =>
    (upstream) => ({
      manifest,
      env: {
        EMAIL_PROVIDER: Output.map(upstream, () => choice),
        SES_KEY: key,
      },
    });
  interface ApplyOptions {
    readonly preset?: Record<string, Redacted.Redacted<string>>;
    readonly repeat?: boolean;
    readonly nextInputs?: Inputs;
    readonly probe?: boolean;
    readonly probeSlot?: string;
  }
  const apply = (inputs: Inputs, options: ApplyOptions = {}) =>
    Effect.gen(function* () {
      const node = yield* Layer.build(NodeServices.layer);
      return yield* push(inputs, options).pipe(Effect.provideContext(node));
    }).pipe(Effect.scoped);
  const push = (inputs: Inputs, options: ApplyOptions) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({
        prefix: "confect-backend-output-",
      });
      const pushes: string[] = [];
      const fixture = mockClient();
      Object.assign(fixture.state.variables, options.preset);
      const client = Layer.succeed(ConvexClient, {
        ...fixture.client,
        runFunction: () => Effect.succeed(formatOne.digest),
      });
      const runner = Layer.succeed(CommandRunner, {
        prepare: () =>
          Effect.gen(function* () {
            pushes.push("prepare");
            yield* fs.makeDirectory(path.join(cwd, "convex"), {
              recursive: true,
            });
            yield* fs.writeFileString(
              path.join(cwd, "convex", "confectHealth.ts"),
              HealthModule.render(formatOne.digest),
            );
          }).pipe(Effect.orDie),
        deploy: () => Effect.sync(() => void pushes.push("deploy")),
      });
      const lock = Layer.succeed(PushLock, {
        withLock: (_name, effect) => effect,
      });
      const engine = yield* makeEngine(
        Layer.effect(
          Providers,
          Provider.collection([
            UsageLimit.UsageLimit,
            EnvironmentVariables.EnvironmentVariables,
            Code.Code,
          ]),
        ).pipe(
          Layer.provide(
            Layer.mergeAll(
              UsageLimit.layer,
              EnvironmentVariables.layer,
              Code.layer,
            ),
          ),
          Layer.provide(
            Layer.mergeAll(client, runner, lock, NodeServices.layer),
          ),
        ),
      );
      let activeInputs = inputs;
      const program = Effect.gen(function* () {
        const upstream = yield* UsageLimit.UsageLimit("Limit", limit);
        // Outputs from untyped code reach the boundary unchecked.
        const backend = yield* Backend("Backend", {
          ...props,
          cwd,
          ...(activeInputs(upstream.id) as {
            readonly manifest: typeof formatOne;
          }),
        });
        if (options.probe === true) {
          const plain =
            backend.environment?.Props.variables[options.probeSlot ?? "PLAIN"];
          yield* UsageLimit.UsageLimit("Probe", {
            ...limit,
            window: "day",
            limit: Output.map(Output.asOutput(plain), () => 2),
          });
        }
        return backend.url;
      });
      const result = yield* engine.run(program).pipe(Effect.exit);
      const callsAfterFirst = fixture.state.environmentUpdates.length;
      activeInputs = options.nextInputs ?? inputs;
      const repeated =
        options.repeat === true && Exit.isSuccess(result)
          ? yield* engine.run(program).pipe(Effect.exit)
          : undefined;
      const third =
        options.nextInputs !== undefined &&
        repeated !== undefined &&
        Exit.isSuccess(repeated)
          ? yield* engine.run(program).pipe(Effect.exit)
          : undefined;
      return {
        result,
        repeated,
        third,
        callsAfterFirst,
        fixture,
        pushes,
        plans: engine.plans,
        planDependencies: engine.planDependencies,
      };
    }).pipe(Effect.scoped);

  it.effect.each(["env", "mounts"] as const)(
    "accepts an omitted optional selector in %s without decoding a choice",
    (scope) =>
      Effect.gen(function* () {
        const slots = {
          CHOICE: { ...selector("ses"), optional: true },
          KEY: setting("CHOICE", "ses"),
        } as const;
        const { result, fixture } = yield* apply(() => ({
          manifest: {
            ...formatOne,
            ...(scope === "env"
              ? { env: slots }
              : {
                  mounts: {
                    relay: {
                      component: "relay",
                      env: {
                        CHOICE: variable(slots.CHOICE, "RELAY_CHOICE"),
                        KEY: variable(slots.KEY, "RELAY_KEY"),
                      },
                    },
                  },
                }),
          },
          [scope]: scope === "env" ? {} : { relay: {} },
        }));
        expect(result).toEqual(Exit.succeed(props.deployment.url));
        expect(fixture.state.environmentUpdates).toEqual([]);
      }),
  );
  it.effect(
    "declares no environment resource for an omitted optional selector",
    () =>
      Effect.gen(function* () {
        const { result, fixture, plans } = yield* apply(() => ({
          manifest: {
            ...formatOne,
            env: { CHOICE: { ...selector("ses"), optional: true } },
          },
        }));
        expect(result).toEqual(Exit.succeed(props.deployment.url));
        expect(
          Array.filter(plans[0]!, (node) =>
            Str.endsWith("Environment")(node.fqn),
          ),
        ).toEqual([]);
        expect(fixture.state.environmentUpdates).toEqual([]);
      }),
  );
  it.effect("keeps another selector's settings out of its plan edges", () =>
    Effect.gen(function* () {
      const { result, fixture, plans, planDependencies } = yield* apply(
        (upstream) => ({
          manifest: {
            ...formatOne,
            env: {
              FIRST_CHOICE: selector("ses"),
              FIRST_KEY: setting("FIRST_CHOICE", "ses"),
              SECOND_CHOICE: selector("ses"),
              SECOND_KEY: setting("SECOND_CHOICE", "ses"),
            },
          },
          env: {
            FIRST_CHOICE: "ses",
            FIRST_KEY: key,
            SECOND_CHOICE: "ses",
            SECOND_KEY: Output.map(upstream, () => key),
          },
        }),
        { probe: true, probeSlot: "FIRST_CHOICE" },
      );
      expect(result).toEqual(Exit.succeed(props.deployment.url));
      const plan = plans[0]!;
      const source = Option.getOrThrow(
        Array.findFirst(plan, (node) => Str.endsWith("Limit")(node.fqn)),
      );
      const probe = Option.getOrThrow(
        Array.findFirst(plan, (node) => Str.endsWith("Probe")(node.fqn)),
      );
      const environment = Option.getOrThrow(
        Array.findFirst(plan, (node) => Str.endsWith("Environment")(node.fqn)),
      );
      expect(planDependencies[0]?.[source.fqn]).toContain(environment.fqn);
      expect(planDependencies[0]?.[source.fqn]).not.toContain(probe.fqn);
      expect(fixture.state.environmentUpdates).toEqual([
        [
          { name: "FIRST_CHOICE", value: Redacted.make("ses") },
          { name: "FIRST_KEY", value: key },
          { name: "SECOND_CHOICE", value: Redacted.make("ses") },
          { name: "SECOND_KEY", value: key },
        ],
      ]);
    }),
  );

  const scopedManifest = {
    ...manifest,
    env: {
      ...manifest.env,
      PLAIN: { kind: "string", optional: false },
      OPT: { kind: "string", optional: true },
    },
  } as const;

  it.effect.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ] as const)(
    "writes only supplied slots, deferred=%s, preset=%s",
    ([deferred, preset]) =>
      Effect.gen(function* () {
        const { result, repeated, callsAfterFirst, fixture } = yield* apply(
          (upstream) => ({
            manifest: scopedManifest,
            env: {
              EMAIL_PROVIDER: deferred
                ? Output.map(upstream, () => "ses")
                : "ses",
              SES_KEY: key,
              PLAIN: "plain",
              OPT: undefined,
            },
          }),
          {
            repeat: true,
            ...(preset
              ? {
                  preset: {
                    OPT: Redacted.make("manual"),
                    RESEND_KEY: Redacted.make("manual-resend"),
                  },
                }
              : {}),
          },
        );
        expect(result).toEqual(Exit.succeed(props.deployment.url));
        expect(repeated).toEqual(Exit.succeed(props.deployment.url));
        expect(callsAfterFirst).toBe(1);
        expect(fixture.state.environmentUpdates).toEqual([
          [
            { name: "EMAIL_PROVIDER", value: Redacted.make("ses") },
            { name: "SES_KEY", value: key },
            { name: "PLAIN", value: Redacted.make("plain") },
          ],
        ]);
      }),
  );

  it.effect.each([1, 3, 6])(
    "bounds one Effect's evaluations independently of %s slots",
    (count) =>
      Effect.gen(function* () {
        let evaluations = 0;
        const env = Record.fromEntries(
          globalThis.Array.from({ length: count }, (_, i) => [
            `SLOT_${i}`,
            { kind: "string", optional: false } as const,
          ]),
        );
        const values = Record.fromEntries(
          globalThis.Array.from({ length: count }, (_, i) => [
            `SLOT_${i}`,
            i === 0
              ? Effect.sync(() => {
                  evaluations++;
                  return "counted";
                })
              : "plain",
          ]),
        );
        const { result, fixture } = yield* apply(() => ({
          manifest: { ...formatOne, env },
          env: values,
        }));
        expect(result).toEqual(Exit.succeed(props.deployment.url));
        expect(fixture.state.environmentUpdates).toEqual([
          Array.map(Record.toEntries(values), ([name], i) => ({
            name,
            value: Redacted.make(i === 0 ? "counted" : "plain"),
          })),
        ]);
        expect(evaluations).toBe(2);
      }),
  );

  it.effect.each(["shared", "tagged"] as const)(
    "evaluates an Effect at each use in plan and apply, %s",
    (use) =>
      Effect.gen(function* () {
        let evaluations = 0;
        const value = Effect.sync(() => {
          evaluations++;
          return "counted";
        });
        const { result, fixture } = yield* apply((): ReturnType<Inputs> =>
          use === "shared"
            ? {
                manifest: {
                  ...formatOne,
                  env: {
                    FIRST: { kind: "string", optional: false },
                    SECOND: { kind: "string", optional: false },
                  },
                },
                env: { FIRST: value, SECOND: value },
              }
            : {
                manifest: {
                  ...formatOne,
                  env: {
                    CHOICE: selector("ses"),
                    TOKEN: {
                      kind: "string",
                      optional: true,
                      provider: {
                        selector: "CHOICE",
                        name: "ses",
                        required: true,
                      },
                    },
                  },
                },
                env: { CHOICE: "ses", TOKEN: value },
              },
        );
        expect(result).toEqual(Exit.succeed(props.deployment.url));
        expect(evaluations).toBe(4);
        expect(fixture.state.environmentUpdates).toEqual([
          use === "shared"
            ? [
                { name: "FIRST", value: Redacted.make("counted") },
                { name: "SECOND", value: Redacted.make("counted") },
              ]
            : [
                { name: "CHOICE", value: Redacted.make("ses") },
                { name: "TOKEN", value: Redacted.make("counted") },
              ],
        ]);
      }),
  );
  it.effect.each(["Effect", "Config"] as const)(
    "evaluates a selector with two tagged settings in plan and apply, %s",
    (form) =>
      Effect.gen(function* () {
        let evaluations = 0;
        const value = Effect.sync(() => {
          evaluations++;
          return { pool: ["ses", "resend"] };
        });
        const input =
          form === "Config"
            ? Config.succeed(undefined).pipe(Config.mapEffect(() => value))
            : value;
        const { result, fixture } = yield* apply(() => ({
          manifest,
          env: { EMAIL_PROVIDER: input, SES_KEY: key, RESEND_KEY: key },
        }));
        expect(result).toEqual(Exit.succeed(props.deployment.url));
        expect(evaluations).toBe(10);
        expect(fixture.state.environmentUpdates).toEqual([
          [
            {
              name: "EMAIL_PROVIDER",
              value: Redacted.make('{"pool":["ses","resend"]}'),
            },
            { name: "SES_KEY", value: key },
            { name: "RESEND_KEY", value: key },
          ],
        ]);
      }),
  );

  for (const scope of ["env", "mounts"] as const) {
    it.effect.each(["Effect", "Config"] as const)(
      `checks a tagged setting's own evaluation before writing in ${scope}, %s`,
      (form) =>
        Effect.gen(function* () {
          let evaluations = 0;
          const value = Effect.sync(() =>
            ++evaluations % 2 === 1 ? "present" : undefined,
          );
          const input =
            form === "Config"
              ? Config.succeed(undefined).pipe(Config.mapEffect(() => value))
              : value;
          const slots = {
            CHOICE: selector("ses"),
            TOKEN: {
              kind: "string",
              optional: true,
              provider: { selector: "CHOICE", name: "ses", required: true },
            },
          } as const;
          const { result, fixture, pushes } = yield* apply(() => ({
            manifest: {
              ...formatOne,
              ...(scope === "env"
                ? { env: slots }
                : {
                    mounts: {
                      relay: {
                        component: "relay",
                        env: {
                          CHOICE: variable(slots.CHOICE, "RELAY_CHOICE"),
                          TOKEN: variable(slots.TOKEN, "RELAY_TOKEN"),
                        },
                      },
                    },
                  }),
            },
            [scope]:
              scope === "env"
                ? { CHOICE: "ses", TOKEN: input }
                : { relay: { CHOICE: "ses", TOKEN: input } },
          }));
          expect(defectOf(result)).toMatchObject({
            _tag: "InvalidMountSetting",
            mount: scope === "env" ? "app" : "relay",
            slot: "TOKEN",
            reason: "Missing",
          });
          expect(fixture.state.environmentUpdates).toEqual([]);
          expect(pushes).toEqual([]);
        }),
    );
  }

  it.effect(
    "keeps an unrelated slot out of the deferred slot's plan dependency edges",
    () =>
      Effect.gen(function* () {
        const { result, plans, planDependencies } = yield* apply(
          (upstream) => ({
            manifest: scopedManifest,
            env: {
              EMAIL_PROVIDER: Output.map(upstream, () => "ses"),
              SES_KEY: key,
              PLAIN: "plain",
            },
          }),
          { probe: true },
        );
        expect(result).toEqual(Exit.succeed(props.deployment.url));
        const plan = plans[0]!;
        const source = Option.getOrThrow(
          Array.findFirst(plan, (node) => Str.endsWith("Limit")(node.fqn)),
        );
        const probe = Option.getOrThrow(
          Array.findFirst(plan, (node) => Str.endsWith("Probe")(node.fqn)),
        );
        const environment = Option.getOrThrow(
          Array.findFirst(plan, (node) =>
            Str.endsWith("Environment")(node.fqn),
          ),
        );
        expect(planDependencies[0]?.[source.fqn]).toContain(environment.fqn);
        expect(planDependencies[0]?.[source.fqn]).not.toContain(probe.fqn);
      }),
  );

  for (const scope of ["env", "mounts", "automatic"] as const) {
    const located = (
      descriptor: {
        readonly kind: "string" | "secret" | "literals";
        readonly optional: boolean;
        readonly values?: readonly [string, ...string[]];
      },
      value: unknown,
    ): ReturnType<Inputs> => ({
      manifest: {
        ...formatOne,
        ...(scope === "mounts"
          ? {
              mounts: {
                relay: {
                  component: "relay",
                  env: { TOKEN: { ...descriptor, variable: "RELAY_TOKEN" } },
                },
              },
            }
          : {
              env: {
                TOKEN: {
                  ...descriptor,
                  ...(scope === "automatic"
                    ? { automatic: true as const }
                    : {}),
                },
              },
            }),
      } as Manifest.Manifest,
      [scope]:
        scope === "mounts" ? { relay: { TOKEN: value } } : { TOKEN: value },
    });
    it.effect.each([
      ["null", null, "string", "Missing"],
      ["number", 5, "string", "InvalidValue"],
      ["object", { a: 1 }, "string", "InvalidValue"],
      ["redacted string", key, "string", "InvalidValue"],
      ["unknown literal", "bogus", "literals", "InvalidValue"],
      ["numeric literal", 5, "literals", "InvalidValue"],
      ["non-string redacted", Redacted.make(5), "secret", "InvalidValue"],
    ] as const)(
      `refuses a wrong %s value in ${scope} before declaring resources`,
      ([_, value, kind, reason]) =>
        Effect.gen(function* () {
          const declared = {
            name: "test",
            stage: "test",
            resources: {},
            bindings: {},
            actions: {},
          };
          const services = yield* Layer.build(providers);
          const exit = yield* Backend("Backend", {
            ...props,
            ...(located(
              {
                kind,
                optional: false,
                ...(kind === "literals" ? { values: ["safe"] } : {}),
              },
              value,
            ) as { readonly manifest: typeof formatOne }),
          }).pipe(
            Effect.provideService(Stack, declared),
            Effect.provideContext(services),
            Effect.exit,
          );
          expect(defectOf(exit)).toMatchObject({
            _tag:
              scope === "automatic"
                ? "InvalidAutomaticSetting"
                : "InvalidMountSetting",
            slot: "TOKEN",
            reason,
          });
          expect(Record.keys(declared.resources)).toEqual([]);
        }).pipe(Effect.scoped),
    );
    it.effect.each([
      ["null", null, "string", "Missing"],
      ["number", 5, "string", "InvalidValue"],
      ["object", { a: 1 }, "string", "InvalidValue"],
      ["unknown literal", "bogus", "literals", "InvalidValue"],
      ["numeric literal", 5, "literals", "InvalidValue"],
      ["non-string redacted", Redacted.make(5), "secret", "InvalidValue"],
    ] as const)(
      `refuses a deferred wrong %s value in ${scope} before writes`,
      ([_, value, kind, reason]) =>
        Effect.gen(function* () {
          const { result, fixture, pushes } = yield* apply((upstream) =>
            located(
              {
                kind,
                optional: false,
                ...(kind === "literals" ? { values: ["safe"] } : {}),
              },
              Output.map(upstream, () => value),
            ),
          );
          expect(defectOf(result)).toMatchObject({
            _tag:
              scope === "automatic"
                ? "InvalidAutomaticSetting"
                : "InvalidMountSetting",
            slot: "TOKEN",
            reason,
          });
          expect(fixture.state.environmentUpdates).toEqual([]);
          expect(pushes).toEqual([]);
        }),
    );
    it.effect.each([scope])("accepts whitespace in a string slot in %s", () =>
      Effect.gen(function* () {
        const { result, fixture } = yield* apply(() =>
          located({ kind: "string", optional: false }, "   "),
        );
        expect(result).toEqual(Exit.succeed(props.deployment.url));
        expect(fixture.state.environmentUpdates).toEqual([
          [
            {
              name: scope === "mounts" ? "RELAY_TOKEN" : "TOKEN",
              value: Redacted.make("   "),
            },
          ],
        ]);
      }),
    );
    if (scope !== "automatic") {
      it.effect.each([undefined, null, ""])(
        `does not write a plain missing optional slot in ${scope}, case %s`,
        (value) =>
          Effect.gen(function* () {
            const { result, fixture } = yield* apply(() =>
              located({ kind: "string", optional: true }, value),
            );
            expect(result).toEqual(Exit.succeed(props.deployment.url));
            expect(fixture.state.environmentUpdates).toEqual([]);
          }),
      );
    }
  }

  it.effect(
    "keeps a mount named automatic distinct from Backend.automatic",
    () =>
      Effect.gen(function* () {
        const { result, fixture, pushes } = yield* apply(() => ({
          manifest: {
            ...formatOne,
            mounts: {
              automatic: {
                component: "relay",
                env: {
                  TOKEN: {
                    kind: "secret",
                    optional: false,
                    variable: "AUTOMATIC_TOKEN",
                  },
                },
              },
            },
          },
          mounts: { automatic: { TOKEN: "plain" } },
        }));
        expect(defectOf(result)).toMatchObject({
          _tag: "InvalidMountSetting",
          mount: "automatic",
          slot: "TOKEN",
          reason: "PlainSecret",
        });
        expect(String(defectOf(result))).toContain("Backend.mounts");
        expect(fixture.state.environmentUpdates).toEqual([]);
        expect(pushes).toEqual([]);
      }),
  );

  it.effect("directs a plain automatic secret to Backend.automatic", () =>
    Effect.gen(function* () {
      const { result, fixture, pushes } = yield* apply(() => ({
        manifest: {
          ...formatOne,
          env: { TOKEN: { kind: "secret", optional: false, automatic: true } },
        },
        automatic: { TOKEN: "plain" },
      }));
      expect(String(defectOf(result))).toContain("Backend.automatic");
      expect(fixture.state.environmentUpdates).toEqual([]);
      expect(pushes).toEqual([]);
    }),
  );

  it.effect.each([false, true])(
    "refuses a selected provider's null setting, deferred=%s",
    (deferred) =>
      Effect.gen(function* () {
        const { result, fixture, pushes } = yield* apply((upstream) => ({
          manifest,
          env: {
            EMAIL_PROVIDER: "ses",
            SES_KEY: deferred ? Output.map(upstream, () => null) : null,
          },
        }));
        expect(defectOf(result)).toMatchObject({
          _tag: "InvalidMountSetting",
          slot: "SES_KEY",
          reason: "Missing",
        });
        expect(fixture.state.environmentUpdates).toEqual([]);
        expect(pushes).toEqual([]);
      }),
  );

  for (const scope of ["provider", "env", "mounts", "automatic"] as const) {
    it.effect.each([
      ["undefined", undefined],
      ["empty string", ""],
      ["empty redacted", Redacted.make("")],
    ] as const)(
      `refuses a resolved missing %s setting in ${scope} before writes`,
      ([_, missing]) =>
        Effect.gen(function* () {
          const { result, fixture, pushes } = yield* apply((upstream) => {
            const deferred = Output.map(upstream, () => missing);
            if (scope === "provider")
              return {
                manifest,
                env: { EMAIL_PROVIDER: "ses", SES_KEY: deferred },
              };
            const slot = { kind: "secret", optional: false } as const;
            if (scope === "mounts")
              return {
                manifest: {
                  ...formatOne,
                  mounts: {
                    relay: {
                      component: "relay",
                      env: { TOKEN: { ...slot, variable: "RELAY_TOKEN" } },
                    },
                  },
                },
                mounts: { relay: { TOKEN: deferred } },
              };
            return {
              manifest: {
                ...formatOne,
                env: {
                  TOKEN: {
                    ...slot,
                    ...(scope === "automatic"
                      ? { automatic: true as const }
                      : {}),
                  },
                },
              },
              [scope === "automatic" ? "automatic" : "env"]: {
                TOKEN: deferred,
              },
            };
          });
          expect(defectOf(result)).toMatchObject({
            _tag:
              scope === "automatic"
                ? "InvalidAutomaticSetting"
                : "InvalidMountSetting",
            slot: scope === "provider" ? "SES_KEY" : "TOKEN",
            reason: "Missing",
          });
          expect(
            fixture.client.updateEnvironmentVariables,
          ).not.toHaveBeenCalled();
          expect(pushes).toEqual([]);
        }),
    );
  }

  it.effect(
    "refuses a sparse choice array without dropping its missing position",
    () =>
      Effect.gen(function* () {
        const pool = ["ses"];
        pool.length = 2;
        const { result, fixture, pushes } = yield* apply(() => ({
          manifest,
          env: { EMAIL_PROVIDER: { pool }, SES_KEY: key },
        }));
        expect(defectOf(result)).toMatchObject({
          _tag: "InvalidMountSetting",
          slot: "EMAIL_PROVIDER",
          reason: "InvalidChoice",
        });
        expect(
          fixture.client.updateEnvironmentVariables,
        ).not.toHaveBeenCalled();
        expect(pushes).toEqual([]);
        expect(pool).toHaveLength(2);
        expect(1 in pool).toBe(false);
      }),
  );

  for (const scope of ["env", "mounts", "automatic"] as const) {
    it.effect.each(
      Array.flatMap(
        ["constructor", "toString", "hasOwnProperty", "valueOf"],
        (slot) => Array.map([false, true], (supplied) => ({ slot, supplied })),
      ),
    )(
      `declares only own supplied settings in ${scope} ($slot, supplied=$supplied)`,
      ({ slot, supplied }) =>
        Effect.gen(function* () {
          const descriptor = {
            kind: "string",
            optional: scope !== "automatic",
          } as const;
          const { result, fixture } = yield* apply(() => ({
            manifest: {
              ...formatOne,
              ...(scope === "mounts"
                ? {
                    mounts: {
                      relay: {
                        component: "relay",
                        env: {
                          [slot]: { ...descriptor, variable: "RELAY_SLOT" },
                        },
                      },
                    },
                  }
                : {
                    env: {
                      [slot]: {
                        ...descriptor,
                        ...(scope === "automatic"
                          ? { automatic: true as const }
                          : {}),
                      },
                    },
                  }),
            },
            [scope]:
              scope === "mounts"
                ? { relay: supplied ? { [slot]: "present" } : {} }
                : supplied
                  ? { [slot]: "present" }
                  : {},
          }));
          if (scope === "automatic" && !supplied)
            expect(defectOf(result)).toMatchObject({
              _tag: "InvalidAutomaticSetting",
              slot,
              reason: "Missing",
            });
          else expect(result).toEqual(Exit.succeed(props.deployment.url));
          expect(fixture.state.environmentUpdates).toEqual(
            supplied
              ? [
                  [
                    {
                      name: scope === "mounts" ? "RELAY_SLOT" : slot,
                      value: Redacted.make("present"),
                    },
                  ],
                ]
              : [],
          );
        }),
    );
  }

  const forms = [
    "plain",
    "Output",
    "Effect",
    "Config",
    "nested Output",
    "nested Effect",
    "nested Config",
  ] as const;
  const input = (
    form: (typeof forms)[number],
    value: unknown,
    upstream: Output.Output<string>,
  ): unknown => {
    switch (form) {
      case "Output":
        return Output.map(upstream, () => value);
      case "Effect":
        return Effect.succeed(value);
      case "Config":
        return Config.succeed(value);
      case "nested Output":
        return { pool: [Output.map(upstream, () => "ses")] };
      case "nested Effect":
        return { pool: [Effect.succeed("ses")] };
      case "nested Config":
        return { pool: [Config.succeed("ses")] };
      default:
        return value;
    }
  };

  for (const scope of ["env", "mounts"] as const) {
    const optionalInputs = (
      value: unknown,
      kind: "string" | "secret" = "string",
    ): ReturnType<Inputs> => ({
      manifest: {
        ...formatOne,
        env: {
          PLAIN: { kind: "string", optional: false },
          ...(scope === "env" ? { OPT: { kind, optional: true } } : {}),
        },
        ...(scope === "mounts"
          ? {
              mounts: {
                relay: {
                  component: "relay",
                  env: { OPT: { kind, optional: true, variable: "RELAY_OPT" } },
                },
              },
            }
          : {}),
      },
      env: { PLAIN: "plain", ...(scope === "env" ? { OPT: value } : {}) },
      ...(scope === "mounts" ? { mounts: { relay: { OPT: value } } } : {}),
    });
    const cases = Array.flatMap(
      ["Output", "Effect", "Config"] as const,
      (form) =>
        Array.flatMap([undefined, null, ""] as const, (value) =>
          Array.map(["written", "manual", "fresh"] as const, (scenario) => ({
            form,
            value,
            scenario,
          })),
        ),
    );
    it.effect.each(cases)(
      `releases missing deferred optional values in ${scope} ($form, $value, $scenario)`,
      ({ form, value, scenario }) =>
        Effect.gen(function* () {
          const name = scope === "env" ? "OPT" : "RELAY_OPT";
          const empty: Inputs = (upstream) =>
            optionalInputs(input(form, value, upstream));
          const { result, repeated, third, fixture } = yield* apply(
            scenario === "written"
              ? (upstream) => optionalInputs(input(form, "x", upstream))
              : empty,
            {
              repeat: true,
              ...(scenario === "written" ? { nextInputs: empty } : {}),
              ...(scenario === "manual"
                ? { preset: { [name]: Redacted.make("manual") } }
                : {}),
            },
          );
          expect(result).toEqual(Exit.succeed(props.deployment.url));
          expect(repeated).toEqual(Exit.succeed(props.deployment.url));
          if (scenario === "written")
            expect(third).toEqual(Exit.succeed(props.deployment.url));
          expect(fixture.state.environmentUpdates).toEqual(
            scenario === "written"
              ? [
                  [
                    { name: "PLAIN", value: Redacted.make("plain") },
                    { name, value: Redacted.make("x") },
                  ],
                  [{ name }],
                ]
              : [[{ name: "PLAIN", value: Redacted.make("plain") }]],
          );
        }),
    );
    it.effect.each(["Output", "Effect", "Config"] as const)(
      `omits an empty deferred Redacted optional value in ${scope}, %s`,
      (form) =>
        Effect.gen(function* () {
          const { result, repeated, fixture } = yield* apply(
            (upstream) =>
              optionalInputs(
                input(form, Redacted.make(""), upstream),
                "secret",
              ),
            { repeat: true },
          );
          expect(result).toEqual(Exit.succeed(props.deployment.url));
          expect(repeated).toEqual(Exit.succeed(props.deployment.url));
          expect(fixture.state.environmentUpdates).toEqual([
            [{ name: "PLAIN", value: Redacted.make("plain") }],
          ]);
        }),
    );
    it.effect.each(
      Array.flatMap(["Output", "Effect", "Config"] as const, (form) =>
        Array.map([undefined, null, "", Redacted.make("")], (value) => ({
          form,
          value,
        })),
      ),
    )(
      `omits a missing optional selector in ${scope} ($form, $value)`,
      ({ form, value }) =>
        Effect.gen(function* () {
          const slots = {
            CHOICE: { ...selector("ses"), optional: true },
            KEY: setting("CHOICE", "ses"),
          } as const;
          const { result, repeated, fixture } = yield* apply(
            (upstream) => ({
              manifest: {
                ...formatOne,
                ...(scope === "env"
                  ? { env: slots }
                  : {
                      mounts: {
                        relay: {
                          component: "relay",
                          env: {
                            CHOICE: variable(slots.CHOICE, "RELAY_CHOICE"),
                            KEY: variable(slots.KEY, "RELAY_KEY"),
                          },
                        },
                      },
                    }),
              },
              [scope]:
                scope === "env"
                  ? { CHOICE: input(form, value, upstream) }
                  : { relay: { CHOICE: input(form, value, upstream) } },
            }),
            { repeat: true },
          );
          expect(result).toEqual(Exit.succeed(props.deployment.url));
          expect(repeated).toEqual(Exit.succeed(props.deployment.url));
          expect(fixture.state.environmentUpdates).toEqual([]);
        }),
    );
    it.effect.each(
      Array.flatMap(["Output", "Effect", "Config"] as const, (form) =>
        Array.map([undefined, null, ""], (value) => ({ form, value })),
      ),
    )(
      `refuses a missing required deferred value in ${scope} ($form, $value)`,
      ({ form, value }) =>
        Effect.gen(function* () {
          const { result, fixture, pushes } = yield* apply((upstream) => {
            const options = optionalInputs(input(form, value, upstream));
            return {
              ...options,
              manifest: {
                ...options.manifest,
                ...(scope === "env"
                  ? {
                      env: {
                        PLAIN: { kind: "string", optional: false },
                        OPT: { kind: "string", optional: false },
                      },
                    }
                  : {
                      mounts: {
                        relay: {
                          component: "relay",
                          env: {
                            OPT: {
                              kind: "string",
                              optional: false,
                              variable: "RELAY_OPT",
                            },
                          },
                        },
                      },
                    }),
              },
            };
          });
          expect(defectOf(result)).toMatchObject({
            _tag: "InvalidMountSetting",
            slot: "OPT",
            reason: "Missing",
          });
          expect(fixture.state.environmentUpdates).toEqual([]);
          expect(pushes).toEqual([]);
        }),
    );
  }

  it.effect.each(forms)(
    "normalizes a %s choice through plan and apply",
    (form) =>
      Effect.gen(function* () {
        const { result, fixture, pushes } = yield* apply((upstream) => ({
          manifest,
          env: {
            EMAIL_PROVIDER: input(form, { pool: ["ses"] }, upstream),
            SES_KEY: key,
          },
        }));
        expect(result).toEqual(Exit.succeed(props.deployment.url));
        expect(fixture.state.variables.EMAIL_PROVIDER).toEqual(
          Redacted.make('{"pool":["ses"]}'),
        );
        expect(fixture.state.variables.SES_KEY).toEqual(key);
        expect(pushes).toEqual(["prepare", "deploy"]);
      }),
  );

  for (const location of ["mount", "automatic"] as const) {
    it.effect.each(["plain", "Output", "Effect", "Config"] as const)(
      `normalizes a %s ${location} secret through plan and apply`,
      (form) =>
        Effect.gen(function* () {
          const { result, fixture, pushes } = yield* apply((upstream) => ({
            manifest: {
              ...formatOne,
              ...(location === "mount"
                ? {
                    mounts: {
                      relay: {
                        component: "relay",
                        env: {
                          TOKEN: {
                            kind: "secret",
                            optional: false,
                            variable: "RELAY_TOKEN",
                          },
                        },
                      },
                    },
                  }
                : {
                    env: {
                      TOKEN: {
                        kind: "secret",
                        optional: false,
                        automatic: true,
                      },
                    },
                  }),
            },
            ...(location === "mount"
              ? { mounts: { relay: { TOKEN: input(form, key, upstream) } } }
              : { automatic: { TOKEN: input(form, key, upstream) } }),
          }));
          expect(result).toEqual(Exit.succeed(props.deployment.url));
          expect(
            fixture.state.variables[
              location === "mount" ? "RELAY_TOKEN" : "TOKEN"
            ],
          ).toEqual(key);
          expect(pushes).toEqual(["prepare", "deploy"]);
        }),
    );
    it.effect.each(["Output", "Effect", "Config"] as const)(
      `refuses a resolved plain %s ${location} secret before writes`,
      (form) =>
        Effect.gen(function* () {
          const { result, fixture, pushes } = yield* apply((upstream) => ({
            manifest: {
              ...formatOne,
              ...(location === "mount"
                ? {
                    mounts: {
                      relay: {
                        component: "relay",
                        env: {
                          TOKEN: {
                            kind: "secret",
                            optional: false,
                            variable: "RELAY_TOKEN",
                          },
                        },
                      },
                    },
                  }
                : {
                    env: {
                      TOKEN: {
                        kind: "secret",
                        optional: false,
                        automatic: true,
                      },
                    },
                  }),
            },
            ...(location === "mount"
              ? { mounts: { relay: { TOKEN: input(form, "plain", upstream) } } }
              : { automatic: { TOKEN: input(form, "plain", upstream) } }),
          }));
          expect(defectOf(result)).toMatchObject({
            _tag:
              location === "automatic"
                ? "InvalidAutomaticSetting"
                : "InvalidMountSetting",
            slot: "TOKEN",
            reason: "PlainSecret",
          });
          expect(
            fixture.client.updateEnvironmentVariables,
          ).not.toHaveBeenCalled();
          expect(pushes).toEqual([]);
        }),
    );
  }

  it.effect(
    "encodes a choice output when it resolves, after the resource it depends on",
    () =>
      Effect.gen(function* () {
        const { result, fixture, pushes } = yield* apply(
          choosing({ pool: ["ses"] }),
        );
        expect(result).toEqual(Exit.succeed(props.deployment.url));
        expect(fixture.client.createUsageLimit).toHaveBeenCalledTimes(1);
        expect(
          Record.map(fixture.state.variables, (value) => Redacted.value(value)),
        ).toEqual({
          EMAIL_PROVIDER: '{"pool":["ses"]}',
          SES_KEY: "output-test-key",
        });
        expect(pushes).toEqual(["prepare", "deploy"]);
      }),
  );

  it.effect.each([
    ["an unknown provider", "sms", "EMAIL_PROVIDER", "InvalidChoice"],
    ["a raw object", { name: "ses" }, "EMAIL_PROVIDER", "InvalidChoice"],
    [
      "a provider whose required setting is missing",
      "resend",
      "RESEND_KEY",
      "Missing",
    ],
  ] as const)(
    "fails the apply before the environment write when a choice output resolves to %s",
    ([_, choice, slot, reason]) =>
      Effect.gen(function* () {
        const { result, fixture, pushes } = yield* apply(choosing(choice));
        expect(defectOf(result)).toEqual(
          InvalidMountSetting.make({ mount: "app", slot, reason }),
        );
        expect(
          fixture.client.updateEnvironmentVariables,
        ).not.toHaveBeenCalled();
        expect(fixture.state.variables).toEqual({});
        expect(pushes).toEqual([]);
      }),
  );

  it.effect(
    "fails the apply before the environment write when a mount's secret output resolves to a plain string",
    () =>
      Effect.gen(function* () {
        const { result, fixture, pushes } = yield* apply((upstream) => ({
          manifest: {
            ...formatOne,
            mounts: {
              relay: {
                component: "relay",
                env: {
                  TOKEN: {
                    kind: "secret",
                    optional: false,
                    variable: "RELAY_TOKEN",
                  },
                },
              },
            },
          },
          mounts: { relay: { TOKEN: Output.map(upstream, () => "plain") } },
        }));
        expect(defectOf(result)).toEqual(
          InvalidMountSetting.make({
            mount: "relay",
            slot: "TOKEN",
            reason: "PlainSecret",
          }),
        );
        expect(
          fixture.client.updateEnvironmentVariables,
        ).not.toHaveBeenCalled();
        expect(pushes).toEqual([]);
      }),
  );

  it.effect("keeps a choice output's dependency on its upstream resource", () =>
    Effect.gen(function* () {
      const upstream = yield* UsageLimit.UsageLimit("Limit", limit);
      const backend = yield* Backend("Backend", {
        ...props,
        manifest,
        env: {
          EMAIL_PROVIDER: Output.map(upstream.id, () => "ses" as const),
          SES_KEY: key,
        },
      });
      const choice = backend.environment?.Props.variables["EMAIL_PROVIDER"];
      expect(Output.isOutput(choice)).toBe(true);
      expect(Record.keys(Output.resolveUpstream(choice))).toEqual([
        upstream.FQN,
      ]);
    }).pipe(Effect.provide([stack(), providers])),
  );
});
