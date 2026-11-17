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
  const apply = (choice: unknown) =>
    Effect.gen(function* () {
      const node = yield* Layer.build(NodeServices.layer);
      return yield* push(choice).pipe(Effect.provideContext(node));
    }).pipe(Effect.scoped);
  const push = (choice: unknown) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({
        prefix: "confect-backend-output-",
      });
      const pushes: string[] = [];
      const fixture = mockClient();
      const client = Layer.succeed(ConvexClient, {
        ...fixture.client,
        runFunction: () => Effect.succeed(manifest.digest),
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
              `export const digest = { handler: () => "${manifest.digest}" };\n`,
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
      const result = yield* engine
        .run(
          Effect.gen(function* () {
            const upstream = yield* UsageLimit.UsageLimit("Limit", limit);
            const backend = yield* Backend("Backend", {
              ...props,
              cwd,
              manifest,
              env: {
                // An output from untyped code reaches the boundary unchecked.
                EMAIL_PROVIDER: Output.map(upstream.id, () => choice) as never,
                SES_KEY: key,
              },
            });
            return backend.url;
          }),
        )
        .pipe(Effect.exit);
      return { result, fixture, pushes };
    }).pipe(Effect.scoped);

  it.effect(
    "encodes a choice output when it resolves, after the resource it depends on",
    () =>
      Effect.gen(function* () {
        const { result, fixture, pushes } = yield* apply({
          active: "ses",
          standby: ["resend"],
        });
        expect(result).toEqual(Exit.succeed(props.deployment.url));
        expect(fixture.client.createUsageLimit).toHaveBeenCalledTimes(1);
        expect(
          Record.map(fixture.state.variables, (value) => Redacted.value(value)),
        ).toEqual({
          EMAIL_PROVIDER: '{"active":"ses","standby":["resend"]}',
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
        const { result, fixture, pushes } = yield* apply(choice);
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
