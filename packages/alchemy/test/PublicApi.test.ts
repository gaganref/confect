import type { Input } from "alchemy/Input";
import type * as Output from "alchemy/Output";
import { Confect, Convex } from "@confect/alchemy";
import { describe, expectTypeOf, it } from "@effect/vitest";
import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

describe("public API", () => {
  it("accepts the documented managed-backend stack without executing it", () => {
    const stack = Alchemy.Stack(
      "Notes",
      { providers: Convex.providers(), state: Alchemy.localState() },
      Effect.gen(function* () {
        const project = yield* Convex.Project("Project", {
          teamId: yield* Config.Number("CONVEX_TEAM_ID"),
          name: "notes-production",
        });
        const deployment = yield* Convex.Deployment("Deployment", {
          projectId: project.projectId,
          type: "prod",
          reference: "notes-production",
        });
        const key = yield* Convex.DeployKey("DeployKey", {
          deploymentName: deployment.name,
          allowedActions: [
            "deployment:deploy",
            "deployment:env:view",
            "deployment:env:write",
          ],
        });
        const backend = yield* Confect.Backend("Backend", {
          deployment,
          deployKey: key.deployKey,
          cwd: "apps/backend",
          env: { SERVICE_TOKEN: yield* Config.Redacted("SERVICE_TOKEN") },
        });
        return { url: backend.url };
      }),
    );
    expectTypeOf<Effect.Success<typeof stack>["output"]>().toExtend<{
      url: Output.Output<string>;
    }>();
    expectTypeOf<
      Effect.Error<typeof stack>
    >().toEqualTypeOf<Config.ConfigError>();
  });

  it("accepts a supplied deployment key without a management token", () => {
    const stack = Alchemy.Stack(
      "Notes",
      { providers: Convex.providers(), state: Alchemy.localState() },
      Effect.gen(function* () {
        const backend = yield* Confect.Backend("Backend", {
          deployment: {
            name: "happy-animal-123",
            url: "https://happy-animal-123.convex.cloud",
          },
          deployKey: yield* Config.Redacted("CONVEX_DEPLOY_KEY"),
        });
        return { url: backend.url };
      }),
    );
    expectTypeOf<Effect.Success<typeof stack>["output"]>().toExtend<{
      url: Output.Output<string>;
    }>();
    expectTypeOf<
      Effect.Error<typeof stack>
    >().toEqualTypeOf<Config.ConfigError>();
  });
});

const manifest = {
  format: 1,
  sections: {},
  name: "notes",
  env: {
    URL: { kind: "string", optional: false },
    TOKEN: { kind: "secret", optional: false },
    MODE: { kind: "literals", values: ["log", "send"], optional: false },
    LABEL: { kind: "string", optional: true },
  },
  mounts: {
    email: {
      component: "email",
      env: {
        KEY: { kind: "secret", optional: false, variable: "EMAIL_KEY" },
      },
    },
  },
  http: {},
  digest: "type-test",
} as const;

it("types Backend env from the manifest without executing resources", () => {
  type Props = Confect.BackendProps<typeof manifest>;
  expectTypeOf<Props["env"]>().toEqualTypeOf<{
    readonly URL: Input<string>;
    readonly TOKEN: Input<Redacted.Redacted<string>>;
    readonly MODE: Input<"log" | "send">;
    readonly LABEL?: Input<string>;
  }>();
  const deployment = { name: "notes", url: "https://example.convex.cloud" };
  const deployKey = Redacted.make("type-test-placeholder");
  const env = {
    URL: "https://example.edu",
    TOKEN: Redacted.make("fixture-token"),
    MODE: "log" as const,
  };
  const mounts = { email: { KEY: Redacted.make("fixture-key") } };
  const backend = Confect.Backend("Notes", {
    deployment,
    deployKey,
    manifest,
    env,
    mounts,
  });
  expectTypeOf({ deployment, deployKey, manifest, env }).not.toExtend<Props>();
  expectTypeOf({
    deployment,
    deployKey,
    manifest,
    env,
    mounts: { email: { KEY: "plain" } },
  }).not.toExtend<Props>();
  const unknownMount = {
    deployment,
    deployKey,
    manifest,
    env,
    mounts: { ...mounts, sms: {} },
  };
  // @ts-expect-error The manifest lists no mount named "sms".
  void Confect.Backend("Notes", unknownMount);
  expectTypeOf<Effect.Success<typeof backend>["url"]>().toExtend<
    Output.Output<string>
  >();
  expectTypeOf({ deployment, deployKey, manifest }).not.toExtend<Props>();
  expectTypeOf({
    deployment,
    deployKey,
    manifest,
    env: { URL: env.URL, MODE: "log" as const },
  }).not.toExtend<Props>();
  expectTypeOf({
    deployment,
    deployKey,
    manifest,
    env: { ...env, TOKEN: "plain" },
  }).not.toExtend<Props>();
  expectTypeOf({
    deployment,
    deployKey,
    manifest,
    env: { ...env, MODE: "smtp" as const },
  }).not.toExtend<Props>();
  const unknown = {
    deployment,
    deployKey,
    manifest,
    env: { ...env, TYPO: "unknown" },
  };
  // @ts-expect-error Unknown keys fail even when env is passed through a variable.
  void Confect.Backend("Notes", unknown);
  const missing = { deployment, deployKey, manifest };
  // @ts-expect-error Required env cannot be omitted at the public constructor.
  void Confect.Backend("Notes", missing);
  const missingToken = {
    deployment,
    deployKey,
    manifest,
    env: { URL: env.URL, MODE: "log" as const },
  };
  // @ts-expect-error Required env keys cannot be omitted at the public constructor.
  void Confect.Backend("Notes", missingToken);
  const optionalManifest = {
    ...manifest,
    env: { LABEL: manifest.env.LABEL },
    mounts: {},
  };
  expectTypeOf(
    Confect.Backend("Optional", {
      deployment,
      deployKey,
      manifest: optionalManifest,
    }),
  ).toExtend<Effect.Effect<unknown, unknown, unknown>>();
});

it("checks secret types on a mount whose open slots are all optional", () => {
  const optional = {
    ...manifest,
    env: {},
    mounts: {
      email: {
        component: "email",
        env: { KEY: { kind: "secret", optional: true, variable: "EMAIL_KEY" } },
      },
    },
  } as const;
  type Props = Confect.BackendProps<typeof optional>;
  const deployment = { name: "notes", url: "https://example.convex.cloud" };
  const deployKey = Redacted.make("type-test-placeholder");
  expectTypeOf({ deployment, deployKey, manifest: optional }).toExtend<Props>();
  expectTypeOf({
    deployment,
    deployKey,
    manifest: optional,
    mounts: { email: { KEY: "plain" } },
  }).not.toExtend<Props>();
  expectTypeOf({
    deployment,
    deployKey,
    manifest: optional,
    mounts: { email: { KEY: Redacted.make("fixture-key") } },
  }).toExtend<Props>();
});

it("keeps automatic values out of Backend env", () => {
  const staged = {
    ...manifest,
    env: {
      ...manifest.env,
      STAGE: { kind: "string", optional: false, automatic: true },
    },
  } as const;
  const input = {
    deployment: { name: "notes", url: "https://example.convex.cloud" },
    deployKey: Redacted.make("fixture"),
    manifest: staged,
    env: {
      URL: "https://example.edu",
      TOKEN: Redacted.make("fixture"),
      MODE: "log" as const,
    },
    mounts: { email: { KEY: Redacted.make("fixture") } },
    automatic: { STAGE: "preview" },
  };
  void Confect.Backend("Notes", input);
  const wrong = { ...input, env: { ...input.env, STAGE: "preview" } };
  // @ts-expect-error Automatic slots belong in automatic, even through a variable.
  void Confect.Backend("Notes", wrong);
});
