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
  name: "notes",
  env: {
    URL: { kind: "string", optional: false },
    TOKEN: { kind: "secret", optional: false },
    MODE: { kind: "literals", values: ["log", "send"], optional: false },
    LABEL: { kind: "string", optional: true },
  },
  http: { mounts: {} },
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
  const backend = Confect.Backend("Notes", {
    deployment,
    deployKey,
    manifest,
    env,
  });
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
  const optionalManifest = { ...manifest, env: { LABEL: manifest.env.LABEL } };
  expectTypeOf(
    Confect.Backend("Optional", {
      deployment,
      deployKey,
      manifest: optionalManifest,
    }),
  ).toExtend<Effect.Effect<unknown, unknown, unknown>>();
});

it("types all log stream kinds and rejects plain secrets and foreign fields", () => {
  const target = {
    deploymentUrl: "https://happy-otter-123.convex.cloud",
    deployKey: Redacted.make("made-up-deploy-key"),
  };
  const secret = Redacted.make("made-up-connector-key");
  const axiom = {
    ...target,
    kind: "axiom" as const,
    apiKey: secret,
    datasetName: "backend",
    attributes: [],
  };
  const sentry = { ...target, kind: "sentry" as const, dsn: secret };
  const webhook = {
    ...target,
    kind: "webhook" as const,
    url: "https://logs.example.test",
    format: "jsonl" as const,
  };
  const datadog = {
    ...target,
    kind: "datadog" as const,
    siteLocation: "US1" as const,
    ddApiKey: secret,
    ddTags: [],
  };
  const s3 = {
    ...target,
    kind: "s3Export" as const,
    bucket: "example",
    region: "us-east-1",
    accessKeyId: secret,
    secretAccessKey: secret,
    period: "hourly" as const,
  };
  for (const props of [
    axiom,
    sentry,
    webhook,
    datadog,
    s3,
    { ...target, kind: "postHogLogs" as const, apiKey: secret },
    { ...target, kind: "postHogErrorTracking" as const, apiKey: secret },
  ])
    expectTypeOf(props).toExtend<Convex.LogStreamProps>();
  const stream = Convex.LogStream("Logs", axiom);
  expectTypeOf<Effect.Success<typeof stream>["hmacSecret"]>().toExtend<
    Output.Output<Redacted.Redacted<string> | undefined>
  >();
  // @ts-expect-error Deploy keys must be Redacted at the constructor.
  void Convex.LogStream("PlainDeployKey", { ...axiom, deployKey: "plain" });
  // @ts-expect-error Axiom API keys must be Redacted.
  void Convex.LogStream("PlainAxiom", { ...axiom, apiKey: "plain" });
  // @ts-expect-error Sentry DSNs must be Redacted.
  void Convex.LogStream("PlainSentry", { ...sentry, dsn: "plain" });
  // @ts-expect-error Datadog API keys must be Redacted, even before the kind is enabled.
  void Convex.LogStream("PlainDatadog", { ...datadog, ddApiKey: "plain" });
  // @ts-expect-error S3 access key IDs must be Redacted.
  void Convex.LogStream("PlainS3Id", { ...s3, accessKeyId: "plain" });
  // @ts-expect-error S3 secret access keys must be Redacted.
  void Convex.LogStream("PlainS3Key", { ...s3, secretAccessKey: "plain" });
  const plainPostHog = {
    ...target,
    kind: "postHogLogs" as const,
    apiKey: "plain",
  };
  // @ts-expect-error PostHog tokens must be Redacted.
  void Convex.LogStream("PlainPostHog", plainPostHog);
  const plainPostHogErrors = {
    ...target,
    kind: "postHogErrorTracking" as const,
    apiKey: "plain",
  };
  // @ts-expect-error PostHog error tracking tokens must be Redacted.
  void Convex.LogStream("PlainPostHogErrors", plainPostHogErrors);
  const foreign = { ...axiom, dsn: secret };
  // @ts-expect-error Foreign fields fail even when passed through a variable.
  void Convex.LogStream("Foreign", foreign);
  // @ts-expect-error A webhook cannot take Axiom attributes.
  void Convex.LogStream("ForeignWebhook", { ...webhook, attributes: [] });
});
