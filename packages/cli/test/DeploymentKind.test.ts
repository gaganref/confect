import * as DeploymentKind from "@confect/cli/DeploymentKind";
import { ProjectRoot } from "@confect/cli/ProjectRoot";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, layer } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Rec from "effect/Record";

// Expected kinds follow the Convex 1.49 CLI's deployment selection:
// `getDeploymentSelectionFromEnv` in `cli/lib/deploymentSelection.ts`, the key
// and prefix helpers in `cli/lib/deployment.ts` and `readDeployKeyFromEnv` in
// `cli/lib/utils/utils.ts`.
const cases: ReadonlyArray<
  readonly [string, Readonly<Record<string, string>>, string]
> = [
  ["no variables", {}, "unknown"],
  ["an empty CONVEX_DEPLOYMENT", { CONVEX_DEPLOYMENT: "" }, "unknown"],
  ["a local: deployment", { CONVEX_DEPLOYMENT: "local:my-app" }, "local"],
  [
    "an anonymous deployment",
    { CONVEX_DEPLOYMENT: "anonymous:anonymous-chess" },
    "local",
  ],
  [
    "an unprefixed anonymous deployment",
    { CONVEX_DEPLOYMENT: "anonymous-chess" },
    "local",
  ],
  [
    "an anonymous deployment with anonymous development off",
    { CONVEX_DEPLOYMENT: "anonymous-chess", CONVEX_ALLOW_ANONYMOUS: "false" },
    "unknown",
  ],
  ["a dev: deployment", { CONVEX_DEPLOYMENT: "dev:happy-otter-123" }, "cloud"],
  [
    "a prod: deployment",
    { CONVEX_DEPLOYMENT: "prod:happy-otter-123" },
    "cloud",
  ],
  [
    "a preview: deployment",
    { CONVEX_DEPLOYMENT: "preview:happy-otter-123" },
    "cloud",
  ],
  [
    "an unprefixed deployment name",
    { CONVEX_DEPLOYMENT: "happy-otter-123" },
    "unknown",
  ],
  [
    "a custom: deployment",
    { CONVEX_DEPLOYMENT: "custom:happy-otter-123" },
    "unknown",
  ],
  [
    "a deployment deploy key",
    { CONVEX_DEPLOY_KEY: "prod:happy-otter-123|fake" },
    "cloud",
  ],
  [
    "a preview deploy key",
    { CONVEX_DEPLOY_KEY: "preview:team:project|fake" },
    "cloud",
  ],
  [
    "a project deploy key",
    { CONVEX_DEPLOY_KEY: "project:team:project|fake" },
    "cloud",
  ],
  [
    "a legacy deploy key",
    { CONVEX_DEPLOY_KEY: "happy-otter-123|fake" },
    "cloud",
  ],
  [
    "a deployment token",
    { CONVEX_DEPLOYMENT_TOKEN: "dev:happy-otter-123|fake" },
    "cloud",
  ],
  [
    "an empty deploy key beside a deployment token",
    {
      CONVEX_DEPLOY_KEY: "",
      CONVEX_DEPLOYMENT_TOKEN: "dev:happy-otter-123|fake",
    },
    "cloud",
  ],
  ["a deploy key without a |", { CONVEX_DEPLOY_KEY: "fake" }, "unknown"],
  [
    "a missing deploy key sentinel",
    { CONVEX_DEPLOY_KEY: "<missing_deploy_key:Set CONVEX_DEPLOY_KEY>" },
    "unknown",
  ],
  [
    "an ignored deploy key beside a local: deployment",
    {
      CONVEX_DEPLOY_KEY: "<ignore_deploy_key>",
      CONVEX_DEPLOYMENT: "local:my-app",
    },
    "local",
  ],
  [
    "a self-hosted URL and admin key",
    {
      CONVEX_SELF_HOSTED_URL: "https://convex.example.test",
      CONVEX_SELF_HOSTED_ADMIN_KEY: "self-hosted|fake",
    },
    "self-hosted",
  ],
  [
    "a loopback self-hosted URL and admin key",
    {
      CONVEX_SELF_HOSTED_URL: "http://127.0.0.1:3210",
      CONVEX_SELF_HOSTED_ADMIN_KEY: "self-hosted|fake",
    },
    "self-hosted",
  ],
  [
    "a self-hosted URL alone",
    { CONVEX_SELF_HOSTED_URL: "https://convex.example.test" },
    "unknown",
  ],
  [
    "a self-hosted admin key alone",
    { CONVEX_SELF_HOSTED_ADMIN_KEY: "self-hosted|fake" },
    "unknown",
  ],
  [
    "a deploy key and a dev: deployment",
    {
      CONVEX_DEPLOY_KEY: "prod:happy-otter-123|fake",
      CONVEX_DEPLOYMENT: "dev:happy-otter-123",
    },
    "cloud",
  ],
  [
    "a deploy key and a local: deployment",
    {
      CONVEX_DEPLOY_KEY: "prod:happy-otter-123|fake",
      CONVEX_DEPLOYMENT: "local:my-app",
    },
    "unknown",
  ],
  [
    "a deployment token and an anonymous deployment",
    {
      CONVEX_DEPLOYMENT_TOKEN: "dev:happy-otter-123|fake",
      CONVEX_DEPLOYMENT: "anonymous-chess",
    },
    "unknown",
  ],
  [
    "a self-hosted pair and a local: deployment",
    {
      CONVEX_SELF_HOSTED_URL: "http://127.0.0.1:3210",
      CONVEX_SELF_HOSTED_ADMIN_KEY: "self-hosted|fake",
      CONVEX_DEPLOYMENT: "local:my-app",
    },
    "unknown",
  ],
  [
    "a self-hosted URL alone and a local: deployment",
    {
      CONVEX_SELF_HOSTED_URL: "http://127.0.0.1:3210",
      CONVEX_DEPLOYMENT: "local:my-app",
    },
    "unknown",
  ],
  [
    "a self-hosted pair and a deploy key",
    {
      CONVEX_SELF_HOSTED_URL: "https://convex.example.test",
      CONVEX_SELF_HOSTED_ADMIN_KEY: "self-hosted|fake",
      CONVEX_DEPLOY_KEY: "prod:happy-otter-123|fake",
    },
    "unknown",
  ],
];

describe("DeploymentKind.fromEnvironment", () => {
  it.each(cases)("reads %s", (_, env, kind) => {
    expect(DeploymentKind.fromEnvironment((name) => env[name])).toBe(kind);
  });
});

/**
 * The kind the command layer resolves in a project whose `.env.local` and
 * `.env` hold `files`, under the ambient variables `env`.
 */
const resolved = (
  files: Readonly<Record<string, string>>,
  env: Readonly<Record<string, string>>,
  deploymentKind: Option.Option<DeploymentKind.Declared>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "confect-deployment-kind-",
    });
    for (const [name, contents] of Rec.toEntries(files))
      yield* fs.writeFileString(path.join(root, name), contents);
    const context = yield* Layer.build(
      DeploymentKind.layer({ deploymentKind }),
    ).pipe(
      Effect.provideService(ProjectRoot, { get: Effect.succeed(root) }),
      Effect.provideService(DeploymentKind.Environment, env),
    );
    return Context.get(context, DeploymentKind.DeploymentKind);
  }).pipe(Effect.scoped);

const local = "CONVEX_DEPLOYMENT=local:my-app\n";
const projects: ReadonlyArray<
  readonly [
    string,
    Readonly<Record<string, string>>,
    Readonly<Record<string, string>>,
    Option.Option<DeploymentKind.Declared>,
    string,
  ]
> = [
  ["reads .env.local", { ".env.local": local }, {}, Option.none(), "local"],
  [
    "reads .env when .env.local does not set a variable",
    {
      ".env.local": "# no deployment\n",
      ".env": "CONVEX_DEPLOYMENT=dev:happy-otter-123\n",
    },
    {},
    Option.none(),
    "cloud",
  ],
  [
    "prefers .env.local to .env for one variable",
    { ".env.local": local, ".env": "CONVEX_DEPLOYMENT=dev:happy-otter-123\n" },
    {},
    Option.none(),
    "local",
  ],
  [
    "prefers the environment to .env.local for one variable",
    { ".env.local": local },
    { CONVEX_DEPLOYMENT: "dev:happy-otter-123" },
    Option.none(),
    "cloud",
  ],
  [
    "gives unknown when the environment and a file disagree",
    { ".env.local": local },
    { CONVEX_DEPLOY_KEY: "prod:happy-otter-123|fake" },
    Option.none(),
    "unknown",
  ],
  ["gives unknown with no variables", {}, {}, Option.none(), "unknown"],
  [
    "takes the kind the command was given over every variable",
    { ".env.local": local },
    { CONVEX_DEPLOYMENT: "local:my-app" },
    Option.some("cloud"),
    "cloud",
  ],
  [
    "lets an empty environment variable hide a file's value",
    { ".env.local": "CONVEX_DEPLOY_KEY=<ignore_deploy_key>\n" },
    {
      CONVEX_DEPLOY_KEY: "",
      CONVEX_DEPLOYMENT_TOKEN: "prod:happy-otter-123|fake",
      CONVEX_DEPLOYMENT: "local:my-app",
    },
    Option.none(),
    "unknown",
  ],
  [
    "lets an empty .env.local value hide .env",
    { ".env.local": "CONVEX_DEPLOYMENT=\n", ".env": local },
    {},
    Option.none(),
    "unknown",
  ],
  [
    "takes CONFECT_DEPLOYMENT_KIND over every Convex variable",
    { ".env.local": local },
    { CONFECT_DEPLOYMENT_KIND: "cloud", CONVEX_DEPLOYMENT: "local:my-app" },
    Option.none(),
    "cloud",
  ],
  [
    "ignores CONFECT_DEPLOYMENT_KIND in a file",
    {
      ".env.local": "CONFECT_DEPLOYMENT_KIND=local\n",
      ".env": "CONVEX_DEPLOYMENT=dev:happy-otter-123\n",
    },
    {},
    Option.none(),
    "cloud",
  ],
  [
    "reads the Convex variables under an empty CONFECT_DEPLOYMENT_KIND",
    { ".env.local": local },
    { CONFECT_DEPLOYMENT_KIND: "" },
    Option.none(),
    "local",
  ],
  [
    "gives unknown for a CONFECT_DEPLOYMENT_KIND it does not know",
    { ".env.local": local },
    { CONFECT_DEPLOYMENT_KIND: "hosted" },
    Option.none(),
    "unknown",
  ],
  [
    "gives unknown for CONFECT_DEPLOYMENT_KIND=unknown",
    { ".env.local": local },
    { CONFECT_DEPLOYMENT_KIND: "unknown" },
    Option.none(),
    "unknown",
  ],
  [
    "takes a flag that agrees with CONFECT_DEPLOYMENT_KIND",
    { ".env.local": local },
    { CONFECT_DEPLOYMENT_KIND: "cloud" },
    Option.some("cloud"),
    "cloud",
  ],
  [
    "gives unknown when the flag and CONFECT_DEPLOYMENT_KIND disagree",
    { ".env.local": local },
    { CONFECT_DEPLOYMENT_KIND: "cloud" },
    Option.some("local"),
    "unknown",
  ],
  [
    "gives unknown for an invalid CONFECT_DEPLOYMENT_KIND beside a flag",
    {},
    { CONFECT_DEPLOYMENT_KIND: "hosted" },
    Option.some("local"),
    "unknown",
  ],
];

layer(NodeServices.layer)("DeploymentKind.layer", (test) => {
  test.effect.each(projects)("%s", ([, files, env, given, expected]) =>
    Effect.gen(function* () {
      const kind = yield* resolved(files, env, given);
      expect(kind).toBe(expected);
    }),
  );
});

describe("DeploymentKind.Environment", () => {
  it.effect("is the process environment where no test set it", () =>
    Effect.gen(function* () {
      const environment = yield* DeploymentKind.Environment;
      expect(environment).toBe(process.env);
    }),
  );
});

describe("DeploymentKind.DeploymentKind", () => {
  it.effect("is unknown where no command set it", () =>
    Effect.gen(function* () {
      const kind = yield* DeploymentKind.DeploymentKind;
      expect(kind).toBe("unknown");
    }),
  );
});
