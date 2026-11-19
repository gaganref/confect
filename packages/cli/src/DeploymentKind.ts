import type * as ManifestSection from "@confect/core/ManifestSection";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as Flag from "effect/cli/Flag";
import * as ProjectRoot from "./ProjectRoot.js";

/**
 * The kind of deployment codegen hands each section. Unset, it is `"unknown"`,
 * so a codegen path that never learns the kind fails closed.
 *
 * @internal
 */
export const DeploymentKind = Context.Reference<ManifestSection.DeploymentKind>(
  "@confect/cli/DeploymentKind",
  { defaultValue: () => "unknown" },
);

/**
 * @internal
 */
export const schema: Schema.Codec<ManifestSection.DeploymentKind> =
  Schema.Literals(["local", "cloud", "self-hosted", "unknown"]);

/**
 * A kind a command can be told.
 *
 * @internal
 */
export type Declared = Exclude<ManifestSection.DeploymentKind, "unknown">;

const names = [
  "CONVEX_DEPLOY_KEY",
  "CONVEX_DEPLOYMENT_TOKEN",
  "CONVEX_DEPLOYMENT",
  "CONVEX_SELF_HOSTED_URL",
  "CONVEX_SELF_HOSTED_ADMIN_KEY",
  "CONVEX_ALLOW_ANONYMOUS",
] as const;

type Name = (typeof names)[number];

/**
 * What one group of variables says, or `undefined` when it says nothing.
 */
type Signal = ManifestSection.DeploymentKind | undefined;

// Convex reads `CONVEX_DEPLOY_KEY || CONVEX_DEPLOYMENT_TOKEN`. A preview, project
// or deployment key all name Convex cloud. A key without `|` makes it crash.
const deployKey = (value: string | undefined): Signal =>
  value === undefined || value === "<ignore_deploy_key>"
    ? undefined
    : /^<missing_deploy_key:.+>$/.test(value) || !Str.includes("|")(value)
      ? "unknown"
      : "cloud";

// Convex needs both variables. With one, it either crashes or selects nothing.
const selfHosted = (
  url: string | undefined,
  adminKey: string | undefined,
): Signal =>
  url === undefined && adminKey === undefined
    ? undefined
    : url !== undefined && adminKey !== undefined
      ? "self-hosted"
      : "unknown";

// An `anonymous-` name is a local backend unless anonymous development is
// switched off. Otherwise the type prefix decides, and Convex resolves an
// unprefixed or `custom:` name through its servers.
const deployment = (
  value: string | undefined,
  allowAnonymous: string | undefined,
): Signal => {
  if (value === undefined) return undefined;
  const segments = Str.split(":")(value);
  if (Str.startsWith("anonymous-")(Arr.lastNonEmpty(segments)))
    return allowAnonymous === "false" ? "unknown" : "local";
  const type = Arr.headNonEmpty(segments);
  return type === "local"
    ? "local"
    : type === "dev" || type === "prod" || type === "preview"
      ? "cloud"
      : "unknown";
};

/**
 * The kind of deployment the Convex CLI selects from these variables, by its
 * 1.49 rules. An empty value counts as unset. Missing signals, a signal the CLI
 * would refuse, and signals that disagree on the kind give `"unknown"`.
 *
 * @internal
 */
export const fromEnvironment = (
  env: (name: Name) => string | undefined,
): ManifestSection.DeploymentKind => {
  const read = (name: Name) => {
    const value = env(name);
    return value === "" ? undefined : value;
  };
  const signals = Arr.filter(
    [
      deployKey(read("CONVEX_DEPLOY_KEY") ?? read("CONVEX_DEPLOYMENT_TOKEN")),
      selfHosted(
        read("CONVEX_SELF_HOSTED_URL"),
        read("CONVEX_SELF_HOSTED_ADMIN_KEY"),
      ),
      deployment(read("CONVEX_DEPLOYMENT"), read("CONVEX_ALLOW_ANONYMOUS")),
    ],
    (signal) => signal !== undefined,
  );
  const [first, ...rest] = signals;
  return first !== undefined && Arr.every(rest, (signal) => signal === first)
    ? first
    : "unknown";
};

/**
 * Read the variables as the Convex CLI does: the environment first, then
 * `.env.local`, then `.env` in the project root. A file that cannot be read
 * adds nothing.
 */
const fromProject = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* ProjectRoot.ProjectRoot.get;
  const file = (name: string) =>
    fs.readFileString(path.join(root, name)).pipe(
      Effect.map((contents) => ConfigProvider.fromDotEnvContents(contents)),
      Effect.orElseSucceed(() => ConfigProvider.fromUnknown({})),
    );
  const ambient = yield* ConfigProvider.ConfigProvider;
  const local = yield* file(".env.local");
  const shared = yield* file(".env");
  const provider = ambient.pipe(
    ConfigProvider.orElse(local),
    ConfigProvider.orElse(shared),
  );
  const values = yield* Effect.forEach(names, (name) =>
    Config.option(Config.String(name))
      .parse(provider)
      .pipe(
        Effect.map((value) => [name, Option.getOrUndefined(value)] as const),
        Effect.orElseSucceed(() => [name, undefined] as const),
      ),
  );
  const env = new Map(values);
  return fromEnvironment((name) => env.get(name));
});

/**
 * @internal
 */
export const flags = {
  deploymentKind: Flag.Literals("deployment-kind", [
    "local",
    "cloud",
    "self-hosted",
  ] satisfies ReadonlyArray<Declared>).pipe(
    Flag.withDescription(
      "The kind of deployment to generate for. Without it, codegen reads the Convex deployment variables.",
    ),
    Flag.optional,
  ),
};

/**
 * The kind the command was given, or else the one the Convex deployment
 * variables select, resolved once when the command starts.
 *
 * @internal
 */
export const layer = ({
  deploymentKind,
}: {
  deploymentKind: Option.Option<Declared>;
}) =>
  Layer.effect(
    DeploymentKind,
    Option.match(deploymentKind, {
      onSome: Effect.succeed,
      onNone: () => fromProject,
    }),
  );
