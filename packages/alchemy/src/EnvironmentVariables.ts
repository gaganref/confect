import { OwnedBySomeoneElse, Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import { PushLock, PushLockError } from "./internal/PushLock.js";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as ConvexClient from "./ConvexClient.js";
import type { Providers } from "./Providers.js";
import { checkpointCreate, shouldAdopt } from "./internal/Lifecycle.js";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";

export interface EnvironmentVariablesProps {
  /**
   * Refuse changes to owned values since the last write. Defaults to
   * `overwrite`.
   */
  readonly driftPolicy?: "overwrite" | "error";
  /**
   * Adopt unowned desired names only when their live values match. Defaults to
   * false.
   */
  readonly adopt?: boolean;
  /**
   * Refuse live names that are neither owned nor desired. Defaults to `ignore`.
   */
  readonly unownedPolicy?: "ignore" | "error";
  /**
   * Share the deployment push lock for checks and writes. Absent by default.
   */
  readonly lock?: { readonly deploymentName: string };
  /**
   * Retry write conflicts only, with 1 to 10 attempts and a delay of 1 to 10000
   * ms. Absent means one attempt.
   */
  readonly retry?: {
    readonly maxAttempts: number;
    readonly delay: Duration.Input;
  };
  readonly url: string;
  readonly deployKey: Redacted.Redacted<string>;
  readonly variables: Readonly<
    Record<string, string | Redacted.Redacted<string>>
  >;
}

export interface EnvironmentVariablesAttributes {
  readonly url: string;
  readonly deployKey: Redacted.Redacted<string>;
  readonly ownedNames: ReadonlyArray<string>;
  readonly variables: Readonly<Record<string, Redacted.Redacted<string>>>;
  readonly originals: Readonly<Record<string, Redacted.Redacted<string>>>;
}

export type EnvironmentVariables = Resource<
  "Convex.EnvironmentVariables",
  EnvironmentVariablesProps,
  EnvironmentVariablesAttributes,
  never,
  Providers
>;
export const EnvironmentVariables = Resource<EnvironmentVariables>(
  "Convex.EnvironmentVariables",
);

export class EnvironmentTargetChange extends Schema.TaggedError<
  EnvironmentTargetChange,
  { readonly brand: unique symbol }
>()("EnvironmentTargetChange", { url: Schema.String }) {}

export class EnvironmentVariableDrift extends Schema.TaggedError<
  EnvironmentVariableDrift,
  { readonly brand: unique symbol }
>()("EnvironmentVariableDrift", { variableName: Schema.String }) {
  override get message() {
    return `Environment variable ${this.variableName} differs from its last managed value`;
  }
}

export class EnvironmentVariableUnowned extends Schema.TaggedError<
  EnvironmentVariableUnowned,
  { readonly brand: unique symbol }
>()("EnvironmentVariableUnowned", { variableName: Schema.String }) {
  override get message() {
    return `Environment variable ${this.variableName} is neither owned nor desired`;
  }
}

export class EnvironmentVariablesInvalidRetry extends Schema.TaggedError<
  EnvironmentVariablesInvalidRetry,
  { readonly brand: unique symbol }
>()("EnvironmentVariablesInvalidRetry", {
  option: Schema.Literals(["maxAttempts", "delay"]),
}) {
  override get message() {
    return this.option === "maxAttempts"
      ? "Environment retry maxAttempts must be an integer from 1 to 10"
      : "Environment retry delay must be from 1 to 10000 milliseconds";
  }
}

const ownershipConflict = (variableName: string) =>
  new OwnedBySomeoneElse({
    message:
      "An existing environment variable requires explicit adoption in a separate resource.",
    resourceType: EnvironmentVariables.Type,
    physicalName: variableName,
  });

const optionsForDiff = (
  olds: EnvironmentVariablesProps,
  news: Input<EnvironmentVariablesProps>,
) => {
  if (!("variables" in news))
    return { ...olds, desiredNames: undefined, desiredVariables: undefined };
  return {
    driftPolicy: isResolved(news.driftPolicy)
      ? news.driftPolicy
      : olds.driftPolicy,
    unownedPolicy: isResolved(news.unownedPolicy)
      ? news.unownedPolicy
      : olds.unownedPolicy,
    lock: isResolved(news.lock) ? news.lock : olds.lock,
    retry: isResolved(news.retry) ? news.retry : olds.retry,
    desiredVariables: news.variables,
    desiredNames:
      !Output.isExpr(news.variables) &&
      !Effect.isEffect(news.variables) &&
      Predicate.isReadonlyObject(news.variables)
        ? Rec.keys<string, unknown>(news.variables)
        : undefined,
  };
};

export const provider = Effect.gen(function* () {
  const client = yield* ConvexClient.ConvexClient;
  const lock = yield* Effect.serviceOption(PushLock);
  const withSafety = Effect.fn("EnvironmentVariables.withSafety")(function* <
    A,
    E,
    R,
  >(
    options: {
      readonly lock?: EnvironmentVariablesProps["lock"];
      readonly retry?: EnvironmentVariablesProps["retry"];
    },
    effect: Effect.Effect<A, E, R>,
  ) {
    let attempt = effect;
    if (options.retry !== undefined) {
      const { maxAttempts, delay } = options.retry;
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10)
        return yield* EnvironmentVariablesInvalidRetry.make({
          option: "maxAttempts",
        });
      const duration = Duration.fromInput(delay);
      if (
        Option.isNone(duration) ||
        Duration.toMillis(duration.value) < 1 ||
        Duration.toMillis(duration.value) > 10000
      )
        return yield* EnvironmentVariablesInvalidRetry.make({
          option: "delay",
        });
      attempt = effect.pipe(
        Effect.retry({
          times: maxAttempts - 1,
          schedule: Schedule.spaced(duration.value),
          while: (error) =>
            Schema.is(ConvexClient.ConvexApiError)(error) &&
            error.serverCode === "OptimisticConcurrencyControlFailure",
        }),
      );
    }
    if (options.lock === undefined) return yield* attempt;
    if (Option.isNone(lock))
      return yield* PushLockError.make({
        deploymentName: options.lock.deploymentName,
        reason: "configuration",
      });
    return yield* lock.value.withLock(options.lock.deploymentName, attempt);
  });
  const redacted = (value: string | Redacted.Redacted<string>) =>
    typeof value === "string" ? Redacted.make(value) : value;
  const valueAt = (
    variables: Readonly<Record<string, Redacted.Redacted<string>>>,
    name: string,
  ) => (Rec.has(variables, name) ? variables[name] : undefined);
  const select = (
    variables: Readonly<Record<string, Redacted.Redacted<string>>>,
    names: ReadonlyArray<string>,
  ) =>
    Rec.fromEntries(
      Arr.flatMap(names, (name) =>
        !Rec.has(variables, name) ? [] : [[name, variables[name]]],
      ),
    );
  const checkDrift = (
    policy: EnvironmentVariablesProps["driftPolicy"],
    output: EnvironmentVariablesAttributes | undefined,
    observed: ConvexClient.EnvironmentVariables,
    desired?: Input<EnvironmentVariablesProps["variables"]>,
  ) => {
    if (policy !== "error" || output === undefined) return Effect.void;
    for (const name of output.ownedNames) {
      const previous = valueAt(output.variables, name);
      const current = valueAt(observed, name);
      const wanted =
        Predicate.isReadonlyObject(desired) &&
        !Output.isExpr(desired) &&
        !Effect.isEffect(desired)
          ? desired[name]
          : undefined;
      if (
        current !== undefined &&
        (typeof wanted === "string" || Redacted.isRedacted(wanted)) &&
        Redacted.value(current) ===
          (typeof wanted === "string" ? wanted : Redacted.value(wanted))
      )
        continue;
      if (previous === undefined && current === undefined) continue;
      if (
        previous === undefined ||
        current === undefined ||
        Redacted.value(previous) !== Redacted.value(current)
      )
        return Effect.fail(
          EnvironmentVariableDrift.make({ variableName: name }),
        );
    }
    return Effect.void;
  };
  const checkUnowned = (
    policy: EnvironmentVariablesProps["unownedPolicy"],
    output: EnvironmentVariablesAttributes | undefined,
    desiredNames: ReadonlyArray<string> | undefined,
    observed: ConvexClient.EnvironmentVariables,
  ) => {
    if (policy !== "error" || desiredNames === undefined) return Effect.void;
    for (const name of Rec.keys(observed)) {
      if (
        output?.ownedNames.includes(name) !== true &&
        !desiredNames.includes(name)
      )
        return Effect.fail(
          EnvironmentVariableUnowned.make({ variableName: name }),
        );
    }
    return Effect.void;
  };
  const service = {
    diff: Effect.fn("EnvironmentVariables.diff")(function* ({
      olds,
      news,
      output,
    }) {
      const options = optionsForDiff(olds, news);
      if (
        output !== undefined &&
        (options.driftPolicy === "error" || options.unownedPolicy === "error")
      ) {
        const observed = yield* client.listEnvironmentVariables(
          output.url,
          output.deployKey,
        );
        yield* checkDrift(
          options.driftPolicy,
          output,
          observed,
          options.desiredVariables,
        );
        yield* checkUnowned(
          options.unownedPolicy,
          output,
          options.desiredNames,
          observed,
        );
      }
      if (!isResolved(news) || output === undefined) return;
      if (news.url !== output.url)
        return yield* EnvironmentTargetChange.make({
          url: output.url,
        });
      const names = Rec.keys(news.variables);
      if (
        names.length !== output.ownedNames.length ||
        Arr.some(names, (name) => !output.ownedNames.includes(name))
      )
        return { action: "update" };
      const variables = yield* client.listEnvironmentVariables(
        news.url,
        news.deployKey,
      );
      for (const [name, value] of Rec.toEntries(news.variables)) {
        const observed = valueAt(variables, name);
        if (
          observed === undefined ||
          Redacted.value(observed) !== Redacted.value(redacted(value))
        )
          return { action: "update" };
      }
    }),
    read: Effect.fn("EnvironmentVariables.read")(function* ({ olds, output }) {
      const url = output?.url ?? olds.url;
      if (url === undefined || olds.deployKey === undefined) return;
      const observed = yield* client.listEnvironmentVariables(
        url,
        olds.deployKey,
      );
      yield* checkDrift(olds.driftPolicy, output, observed, olds.variables);
      yield* checkUnowned(
        olds.unownedPolicy,
        output,
        Rec.keys(olds.variables),
        observed,
      );
      const ownedNames = output?.ownedNames ?? Rec.keys(olds.variables);
      const variables = select(observed, ownedNames);
      if (output !== undefined)
        return { ...output, deployKey: olds.deployKey, variables };
      if (Rec.keys(variables).length === 0) return undefined;
      if (olds.adopt === true) {
        for (const [name, value] of Rec.toEntries(variables)) {
          if (
            Redacted.value(value) !==
            Redacted.value(redacted(olds.variables[name]))
          )
            return yield* ownershipConflict(name);
        }
        return undefined;
      }
      return Unowned({
        url,
        deployKey: olds.deployKey,
        ownedNames,
        variables,
        originals: variables,
      });
    }),
    reconcile: Effect.fn("EnvironmentVariables.reconcile")(function* ({
      fqn,
      instanceId,
      news,
      output,
    }) {
      if (output === undefined) yield* checkpointCreate(fqn, instanceId, news);
      if (output !== undefined && output.url !== news.url)
        return yield* EnvironmentTargetChange.make({
          url: output.url,
        });
      const observed = yield* client.listEnvironmentVariables(
        news.url,
        news.deployKey,
      );
      yield* checkDrift(news.driftPolicy, output, observed, news.variables);
      yield* checkUnowned(
        news.unownedPolicy,
        output,
        Rec.keys(news.variables),
        observed,
      );
      const ownedNames = Rec.keys(news.variables);
      if (
        output === undefined &&
        news.adopt !== true &&
        (yield* shouldAdopt(fqn))
      ) {
        const variables = select(observed, ownedNames);
        output = {
          url: news.url,
          deployKey: news.deployKey,
          ownedNames,
          variables,
          originals: variables,
        };
        yield* checkpointCreate(fqn, instanceId, news, output);
      }
      const previousNames = output?.ownedNames ?? [];
      let originals = output?.originals ?? {};
      for (const name of ownedNames) {
        const current = valueAt(observed, name);
        if (previousNames.includes(name) || current === undefined) continue;
        if (
          news.adopt === true &&
          Redacted.value(current) ===
            Redacted.value(redacted(news.variables[name]))
        ) {
          originals = Rec.set(originals, name, current);
          yield* Effect.logInfo(`Adopted environment variable ${name}`);
        } else {
          return yield* ownershipConflict(name);
        }
      }
      if (output === undefined && news.adopt === true) {
        yield* checkpointCreate(fqn, instanceId, news, {
          url: news.url,
          deployKey: news.deployKey,
          ownedNames,
          variables: select(observed, ownedNames),
          originals,
        } satisfies EnvironmentVariablesAttributes);
      }
      const desired = Rec.fromEntries(
        Arr.map(Rec.toEntries(news.variables), ([name, value]) => [
          name,
          redacted(value),
        ]),
      );
      const changes: Array<{
        name: string;
        value?: Redacted.Redacted<string>;
      }> = [];
      for (const [name, value] of Rec.toEntries(desired)) {
        const current = valueAt(observed, name);
        if (
          current === undefined ||
          Redacted.value(current) !== Redacted.value(value)
        )
          changes.push({ name, value });
      }
      for (const name of previousNames) {
        if (Rec.has(desired, name)) continue;
        const original =
          output !== undefined ? valueAt(output.originals, name) : undefined;
        const current = valueAt(observed, name);
        if (original !== undefined) {
          if (
            current === undefined ||
            Redacted.value(current) !== Redacted.value(original)
          )
            changes.push({ name, value: original });
        } else if (current !== undefined) changes.push({ name });
      }
      if (changes.length > 0)
        yield* client.updateEnvironmentVariables(
          news.url,
          news.deployKey,
          changes,
        );
      return {
        url: news.url,
        deployKey: news.deployKey,
        ownedNames,
        variables: desired,
        originals: select(originals, ownedNames),
      };
    }),
    delete: Effect.fn("EnvironmentVariables.delete")(function* ({
      olds,
      output,
    }) {
      const observed = yield* client
        .listEnvironmentVariables(output.url, output.deployKey)
        .pipe(Effect.catchTag("ConvexNotFound", () => Effect.void));
      if (observed === undefined) return;
      yield* checkDrift(olds.driftPolicy, output, observed);
      yield* checkUnowned(
        olds.unownedPolicy,
        output,
        Rec.keys(olds.variables),
        observed,
      );
      const changes: Array<{
        name: string;
        value?: Redacted.Redacted<string>;
      }> = [];
      for (const name of output.ownedNames) {
        const original = valueAt(output.originals, name);
        const current = valueAt(observed, name);
        if (original !== undefined) {
          if (
            current === undefined ||
            Redacted.value(current) !== Redacted.value(original)
          )
            changes.push({ name, value: original });
        } else if (current !== undefined) changes.push({ name });
      }
      if (changes.length > 0)
        yield* client
          .updateEnvironmentVariables(output.url, output.deployKey, changes)
          .pipe(Effect.catchTag("ConvexNotFound", () => Effect.void));
    }),
  } satisfies Provider.ProviderServiceInput<EnvironmentVariables>;
  return {
    diff: (input) =>
      withSafety(optionsForDiff(input.olds, input.news), service.diff(input)),
    read: (input) => withSafety(input.olds, service.read(input)),
    reconcile: (input) => withSafety(input.news, service.reconcile(input)),
    delete: (input) => withSafety(input.olds, service.delete(input)),
  } satisfies Provider.ProviderServiceInput<EnvironmentVariables>;
});

/**
 * Under `alchemy dev` variables are managed on the local backend. A backend
 * that is not running keeps its variables in its retained data, so removing
 * them is skipped rather than failing the apply.
 */
export const localProvider = Effect.map(
  provider,
  (service) =>
    ({
      ...service,
      delete: (input) =>
        service.delete(input).pipe(
          Effect.catchIf(
            (error) =>
              error._tag === "ConvexApiError" &&
              error.code === "TransportError",
            () => Effect.void,
          ),
        ),
    }) satisfies Provider.ProviderServiceInput<EnvironmentVariables>,
);

export const layer = Provider.effect(EnvironmentVariables, provider);
export const localLayer = Provider.effect(
  EnvironmentVariables,
  localProvider,
).pipe(
  Layer.provide(
    ConvexClient.layer({ mode: "local" }).pipe(
      Layer.provide(FetchHttpClient.layer),
    ),
  ),
);
