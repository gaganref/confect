import * as HealthModule from "@confect/core/HealthModule";
import type { ProviderMode } from "alchemy/ProviderMode";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { CodeProps } from "../Code.js";
import { ConvexClient } from "../ConvexClient.js";
import {
  CommandRunner,
  type DeploymentKind,
  type PushTarget,
} from "./CommandRunner.js";
import * as Loopback from "./Loopback.js";
import { functionsDirectory } from "./FunctionsDirectory.js";
import * as MountInit from "./MountInit.js";
import { PushLock } from "./PushLock.js";
import * as Redaction from "./Redaction.js";

export class InvalidDeploymentTarget extends Schema.TaggedError<
  InvalidDeploymentTarget,
  { readonly brand: unique symbol }
>()("InvalidDeploymentTarget", {
  reason: Schema.Literals(["deployment", "deployKey"]),
}) {}

export class HealthCheckFailed extends Schema.TaggedError<
  HealthCheckFailed,
  { readonly brand: unique symbol }
>()("HealthCheckFailed", {
  expected: Schema.String,
  answered: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
}) {
  override get message() {
    return this.answered === undefined
      ? `health: the pushed code gave no manifest digest (${this.detail ?? "no answer"}); expected ${this.expected}`
      : `health: the pushed code was generated with ${this.answered}, not ${this.expected}`;
  }
}

/**
 * Prepare's health module is edited, missing, or generated for another
 * manifest. Nothing was pushed.
 */
export class StaleManifest extends Schema.TaggedError<
  StaleManifest,
  { readonly brand: unique symbol }
>()("StaleManifest", {
  expected: Schema.String,
  reason: Schema.Literals(["DifferentDigest", "NotGenerated"]),
  generated: Schema.optionalKey(Schema.String),
  healthModulePath: Schema.optionalKey(Schema.String),
}) {
  override get message() {
    return this.reason === "NotGenerated"
      ? `The health module ${this.healthModulePath ?? "at the configured functions directory"} is not as codegen writes it, so nothing was pushed. Do not edit or format the file; regenerate it with confect codegen. The CLI that generates it and the Alchemy package that reads it must be on the same Confect release.`
      : `prepare generated manifest ${this.generated}, but the stack imported manifest ${this.expected}, so nothing was pushed. Run confect codegen, commit the generated files and deploy again.`;
  }
}

const HEALTH = "confectHealth:digest";

/**
 * The digest prepare wrote into the health module, which is what the push would
 * deploy; none when the module is missing or unreadable.
 */
const generatedDigest = Effect.fn("Code.generatedDigest")(
  function* (cwd: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const functions = yield* functionsDirectory(cwd);
    const file = path.join(cwd, functions, "confectHealth.ts");
    const digest = yield* fs
      .readFileString(file)
      .pipe(
        Effect.map(HealthModule.read),
        Effect.orElseSucceed(Option.none<string>),
      );
    return { path: file, digest };
  },
  Effect.orElseSucceed(() => ({
    path: undefined,
    digest: Option.none<string>(),
  })),
);

/**
 * Ask the pushed code which manifest digest codegen wrote into it, and fail
 * unless it is `expected`.
 */
const checkHealth = Effect.fn("Code.checkHealth")(function* (
  url: string,
  key: Redacted.Redacted<string>,
  expected: string,
) {
  const client = yield* ConvexClient;
  const answer = yield* client.runFunction(url, key, HEALTH, {}).pipe(
    Effect.mapError((error) =>
      HealthCheckFailed.make({ expected, detail: error._tag }),
    ),
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () =>
        Effect.fail(HealthCheckFailed.make({ expected, detail: "timeout" })),
    }),
  );
  if (typeof answer !== "string")
    return yield* HealthCheckFailed.make({ expected, detail: "not a string" });
  if (answer !== expected)
    return yield* HealthCheckFailed.make({
      expected,
      // The answer is the deployment's text and may echo the key.
      answered: Redaction.redact(answer, [Redacted.value(key)]),
    });
});

const deploymentName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const cloudTarget = (
  props: CodeProps,
): Result.Result<PushTarget, InvalidDeploymentTarget> => {
  const { name, url } = props.deployment;
  if (
    !deploymentName.test(name) ||
    !new RegExp(
      `^https://${name}(?:\\.[a-z]{2}-[a-z]+-[0-9]+)?\\.convex\\.cloud$`,
    ).test(url)
  )
    return Result.fail(InvalidDeploymentTarget.make({ reason: "deployment" }));
  const key =
    /^(?:dev|prod|preview|custom):([a-z0-9]+(?:-[a-z0-9]+)*)\|[a-zA-Z0-9+/=_-]+$/.exec(
      Redacted.value(props.deployKey),
    );
  if (key === null || key[1] !== name)
    return Result.fail(InvalidDeploymentTarget.make({ reason: "deployKey" }));
  return Result.succeed({
    _tag: "Cloud",
    deploymentName: name,
    deployKey: props.deployKey,
  });
};

const localTarget = (
  props: CodeProps,
): Result.Result<PushTarget, InvalidDeploymentTarget> => {
  const { name, url } = props.deployment;
  if (!deploymentName.test(name) || !Loopback.isOrigin(url))
    return Result.fail(InvalidDeploymentTarget.make({ reason: "deployment" }));
  const key = /^([a-z0-9]+(?:-[a-z0-9]+)*)\|[0-9a-f]+$/.exec(
    Redacted.value(props.deployKey),
  );
  if (key === null || key[1] !== name)
    return Result.fail(InvalidDeploymentTarget.make({ reason: "deployKey" }));
  return Result.succeed({
    _tag: "SelfHosted",
    deploymentName: name,
    url,
    adminKey: props.deployKey,
  });
};

const targets = { live: cloudTarget, local: localTarget } satisfies Record<
  ProviderMode,
  (props: CodeProps) => Result.Result<PushTarget, InvalidDeploymentTarget>
>;

// The local provider pushes to a backend it runs on a loopback origin.
const kinds = { live: "cloud", local: "local" } as const satisfies Record<
  ProviderMode,
  DeploymentKind
>;

/**
 * @internal
 */
export const deploy = Effect.fn("Code.deploy")(function* (
  props: CodeProps,
  mode: ProviderMode = "live",
) {
  const target = yield* Effect.fromResult(targets[mode](props));
  const runner = yield* CommandRunner;
  const lock = yield* PushLock;
  const path = yield* Path.Path;
  yield* lock.withLock(
    target.deploymentName,
    Effect.gen(function* () {
      if (props.prepare !== undefined)
        yield* runner.prepare(props.prepare, kinds[mode], props.cwd);
      if (props.manifestDigest !== undefined) {
        const { path: file, digest: generated } = yield* generatedDigest(
          path.resolve(props.cwd ?? "."),
        );
        if (Option.getOrUndefined(generated) !== props.manifestDigest)
          return yield* StaleManifest.make({
            expected: props.manifestDigest,
            ...(file === undefined ? {} : { healthModulePath: file }),
            reason: Option.isNone(generated)
              ? "NotGenerated"
              : "DifferentDigest",
            ...Option.match(generated, {
              onNone: () => ({}),
              onSome: (digest) => ({ generated: digest }),
            }),
          });
      }
      yield* runner.deploy(target, props.cwd);
      // WORKAROUND: Convex has no component `init` or install `args` in a
      // stable release, so each push runs every mount's `init` itself, inside
      // the lock so no other push lands between this code and its `init`.
      // Delete this step at gaganref/confect#18's trigger: a stable `convex`
      // release with `init` and `args`, and an open-source backend that
      // accepts them. CHANGES.md lists what else goes with it.
      yield* MountInit.run(
        props.deployment.url,
        props.deployKey,
        path.resolve(props.cwd ?? "."),
      );
      if (props.manifestDigest !== undefined)
        yield* checkHealth(
          props.deployment.url,
          props.deployKey,
          props.manifestDigest,
        );
    }),
  );
  return { name: props.deployment.name, url: props.deployment.url };
});
