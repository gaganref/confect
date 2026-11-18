import * as Arr from "effect/Array";
import type * as Env from "@confect/core/Env";
import * as Manifest from "@confect/core/Manifest";
import type { Input, InputProps } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { absurd } from "effect/Function";
import * as Rec from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import { Code } from "./Code.js";
import {
  EnvironmentVariables,
  type EnvironmentVariablesProps,
} from "./EnvironmentVariables.js";

interface CommonProps {
  readonly deployment: {
    readonly name: Input<string>;
    readonly url: Input<string>;
  };
  readonly deployKey: Input<Redacted.Redacted<string>>;
  /**
   * Safety options for managed environment values. Defaults to the resource
   * defaults.
   */
  readonly environment?: InputProps<
    Omit<EnvironmentVariablesProps, "url" | "deployKey" | "variables">
  >;
  readonly cwd?: string;
}

type Environment<M extends Manifest.Manifest> = {
  readonly [K in keyof Manifest.Values<M>]: Input<
    Exclude<Manifest.Values<M>[K], undefined>
  >;
};

type MountSettings<M extends Manifest.Manifest> = {
  readonly [K in keyof Manifest.Mounts<M>]: {
    readonly [S in keyof NonNullable<Manifest.Mounts<M>[K]>]: Input<
      Exclude<NonNullable<Manifest.Mounts<M>[K]>[S], undefined>
    >;
  };
};

type AutomaticValues<M extends Manifest.Manifest> = {
  readonly [K in keyof Manifest.Automatic<M>]: Input<Manifest.Automatic<M>[K]>;
};

/**
 * Inputs for a backend deployment. An input Effect or Config may be evaluated
 * several times in plan and again in apply, more often for a provider selector
 * and its settings. It must be free of side effects and return the same value
 * every time. Otherwise, a choice can be written without a setting it
 * requires.
 */
export type BackendProps<M extends Manifest.Manifest | undefined = undefined> =
  CommonProps &
    (M extends Manifest.Manifest
      ? { readonly manifest: M } & ({} extends Manifest.Values<M>
          ? { readonly env?: Environment<NoInfer<M>> }
          : { readonly env: Environment<NoInfer<M>> }) &
          ({} extends Manifest.Mounts<M>
            ? { readonly mounts?: MountSettings<NoInfer<M>> }
            : { readonly mounts: MountSettings<NoInfer<M>> }) &
          ({} extends Manifest.Automatic<M>
            ? { readonly automatic?: AutomaticValues<NoInfer<M>> }
            : { readonly automatic: AutomaticValues<NoInfer<M>> })
      : {
          readonly manifest?: never;
          readonly mounts?: never;
          readonly automatic?: never;
          readonly env?: Readonly<
            Record<string, Input<string | Redacted.Redacted<string>>>
          >;
        });

/**
 * Deploy a declared backend with env typed by its generated manifest.
 */
export function Backend<
  const M extends Manifest.Manifest,
  const E extends Environment<NoInfer<M>> = Environment<NoInfer<M>>,
  const S extends MountSettings<NoInfer<M>> = MountSettings<NoInfer<M>>,
>(
  id: string,
  props: BackendProps<M> & {
    readonly env?: E &
      Readonly<Record<Exclude<keyof E, keyof Environment<M>>, never>>;
    readonly mounts?: S &
      Readonly<Record<Exclude<keyof S, keyof M["mounts"]>, never>>;
  },
): ReturnType<typeof backend>;
export function Backend(
  id: string,
  props: BackendProps,
): ReturnType<typeof backend>;
export function Backend(
  id: string,
  props: CommonProps & {
    readonly manifest?: Manifest.Manifest;
    readonly env?: Settings;
    readonly automatic?: Variables;
    readonly mounts?: Readonly<Record<string, Settings>>;
  },
): ReturnType<typeof backend> {
  return backend(id, props);
}

type Settings = Readonly<
  Record<string, Input<string | Redacted.Redacted<string> | Env.ProviderChoice>>
>;

type Variables = Readonly<
  Record<string, Input<string | Redacted.Redacted<string>>>
>;

export class InvalidAutomaticSetting extends Schema.TaggedError<
  InvalidAutomaticSetting,
  { readonly brand: unique symbol }
>()("InvalidAutomaticSetting", {
  slot: Schema.String,
  reason: Schema.Literals([
    "NotAutomatic",
    "Missing",
    "InvalidValue",
    "PlainSecret",
  ]),
}) {
  override get message(): string {
    const { reason } = this;
    switch (reason) {
      case "PlainSecret":
        return `${this.slot} is a plain string. Wrap this secret with Redacted.make before passing it in Backend.automatic.`;
      case "InvalidValue":
        return `${this.slot} has a value that does not match its manifest slot. Supply a string of the declared kind in Backend.automatic; secret slots require a Redacted string and literals slots require one of their values.`;
      case "NotAutomatic":
        return `${this.slot} is not declared automatic in manifest.env. Supply only automatic slots in Backend.automatic; put application values in Backend.env.`;
      case "Missing":
        return `${this.slot} is declared automatic in manifest.env but has no value. Supply it in Backend.automatic.`;
      default:
        return absurd(reason);
    }
  }
}

const automaticVariables = (
  manifest: Manifest.Manifest,
  supplied: Variables,
): Result.Result<Variables, InvalidAutomaticSetting> =>
  Manifest.checkAutomatic(manifest, supplied).pipe(
    Result.map(() => supplied),
    Result.mapError(automaticRefusal),
  );

/**
 * `Manifest.checkAutomatic`'s refusal as `Backend.automatic` reports it, case
 * by case, so a reason core adds stops compilation here.
 */
const automaticRefusal = (
  refusal: RefusalOf<typeof Manifest.checkAutomatic>,
): InvalidAutomaticSetting => {
  const { reason } = refusal;
  switch (reason) {
    case "NotAutomatic":
      return InvalidAutomaticSetting.make({
        slot: refusal.slot,
        reason: "NotAutomatic",
      });
    case "Missing":
      return InvalidAutomaticSetting.make({
        slot: refusal.slot,
        reason: "Missing",
      });
    default:
      return absurd(reason);
  }
};

type ValueReason = "Missing" | "InvalidValue" | "PlainSecret";

/**
 * What a core check refuses with, read from its own return type, so each mapper
 * below handles exactly what that check returns.
 */
type RefusalOf<F extends (...args: never) => Result.Result<unknown, unknown>> =
  Result.Result.Failure<ReturnType<F>>;

/**
 * `Manifest.settleSlot`'s and `Manifest.settleChoice`'s refusal of one slot's
 * value, as the caller's error, case by case, so a reason core adds stops
 * compilation here. A provider choice's refusal is a mount setting's, wherever
 * the choice was supplied.
 */
const valueRefusal =
  <E>(at: string, invalid: (slot: string, reason: ValueReason) => E) =>
  (
    refusal:
      | RefusalOf<typeof Manifest.settleSlot>
      | RefusalOf<typeof Manifest.settleChoice>,
  ): E | InvalidMountSetting => {
    const { reason } = refusal;
    switch (reason) {
      case "Missing":
      case "InvalidValue":
      case "PlainSecret":
        return invalid(refusal.slot, reason);
      case "InvalidChoice":
        return InvalidMountSetting.make({
          mount: at,
          slot: refusal.slot,
          reason: "InvalidChoice",
        });
      default:
        return absurd(reason);
    }
  };

/**
 * `Manifest.checkMounts`'s refusal as `Backend.mounts` reports it, case by
 * case, so a reason core adds stops compilation here.
 */
const mountRefusal = (
  refusal: RefusalOf<typeof Manifest.checkMounts>,
): InvalidMountSetting => {
  const { reason } = refusal;
  switch (reason) {
    case "UnknownMount":
      return InvalidMountSetting.make({
        mount: refusal.mount,
        reason: "UnknownMount",
      });
    default:
      return absurd(reason);
  }
};

/**
 * `Manifest.checkOpen`'s refusal as `Backend.mounts` reports it, case by case,
 * so a reason core adds stops compilation here.
 */
const openRefusal = (
  refusal: RefusalOf<typeof Manifest.checkOpen>,
): InvalidMountSetting => {
  const { reason } = refusal;
  switch (reason) {
    case "NotOpen":
      return InvalidMountSetting.make({
        mount: refusal.mount,
        slot: refusal.slot,
        reason: "NotOpen",
      });
    default:
      return absurd(reason);
  }
};

/**
 * Normalize all accepted Input forms without resolving resource dependencies.
 * Redacted values remain opaque; arrays and choice records retain their shape.
 */
const normalize = (value: unknown): unknown => {
  if (Output.isOutput(value)) return value;
  if (Effect.isEffect(value)) {
    // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- Input admits Effects with arbitrary errors and requirements; this boundary preserves requirements on the Output and converts failures to defects.
    return value.pipe(Effect.orDie, Output.fromEffect);
  }
  if (value === null || typeof value !== "object" || Redacted.isRedacted(value))
    return value;
  if (Arr.isArray(value)) {
    const inputs = Arr.map(value, normalize);
    return Arr.some(inputs, Output.isOutput)
      ? Output.all(...Arr.map(inputs, (input) => Output.asOutput(input)))
      : inputs;
  }
  const entries = Arr.map(
    Rec.toEntries(value),
    ([key, input]) => [key, normalize(input)] as const,
  );
  const assemble = (resolved: ReadonlyArray<unknown>) =>
    Rec.fromEntries(Arr.map(entries, ([key], index) => [key, resolved[index]]));
  const inputs = Arr.map(entries, ([, input]) => input);
  return Arr.some(inputs, Output.isOutput)
    ? Output.map(
        Output.all(...Arr.map(inputs, (input) => Output.asOutput(input))),
        assemble,
      )
    : assemble(inputs);
};

/**
 * Each supplied slot keeps its input edges. A tagged setting also reads its
 * selector's input, and a selector reads only its own tagged settings.
 */
const supplySettings = <E>(
  at: string,
  slots: Readonly<Record<string, Env.Descriptor>>,
  supplied: Readonly<Record<string, unknown>>,
  invalid: (
    slot: string,
    reason: "Missing" | "InvalidValue" | "PlainSecret",
  ) => E,
) =>
  Effect.gen(function* () {
    const normalized = Rec.map(supplied, normalize);
    const entries: Array<[string, unknown]> = [];
    const refused = valueRefusal(at, invalid);
    const settle = (key: string, value: unknown, choice?: unknown) =>
      Effect.fromResult(Manifest.settleSlot(slots, key, value, choice)).pipe(
        Effect.mapError(refused),
      );
    for (const [key, descriptor] of Rec.toEntries(slots)) {
      const value = Rec.has(normalized, key) ? normalized[key] : undefined;
      const choice =
        descriptor.provider === undefined ||
        !Rec.has(normalized, descriptor.provider.selector)
          ? undefined
          : normalized[descriptor.provider.selector];
      const checked =
        Output.isOutput(value) || Output.isOutput(choice)
          ? Output.all(Output.asOutput(value), Output.asOutput(choice)).pipe(
              Output.mapEffect(([resolved, selected]) =>
                settle(key, resolved, selected).pipe(Effect.orDie),
              ),
            )
          : yield* settle(key, value, choice);
      if (checked !== undefined) entries.push([key, checked]);
    }
    const settings = Rec.fromEntries(entries);
    for (const [key, descriptor] of Rec.toEntries(slots)) {
      if (descriptor.kind !== "providers" || !Rec.has(settings, key)) continue;
      const value = settings[key];
      const tagged = Rec.filter(
        settings,
        (_, slot) => slots[slot]?.provider?.selector === key,
      );
      const check = (
        choice: unknown,
        resolved: Readonly<Record<string, unknown>>,
      ) =>
        Effect.fromResult(
          Manifest.settleChoice(key, descriptor, slots, resolved, choice),
        ).pipe(Effect.mapError(refused));
      const inputs = normalize({ value, tagged });
      settings[key] = Output.isOutput(inputs)
        ? inputs.pipe(
            Output.mapEffect(
              (resolved: {
                readonly value: unknown;
                readonly tagged: Readonly<Record<string, unknown>>;
              }) => check(resolved.value, resolved.tagged).pipe(Effect.orDie),
            ),
          )
        : yield* check(value, tagged);
    }
    return settings as Record<string, Variables[string]>;
  });

export class InvalidMountSetting extends Schema.TaggedError<
  InvalidMountSetting,
  { readonly brand: unique symbol }
>()("InvalidMountSetting", {
  mount: Schema.String,
  slot: Schema.optional(Schema.String),
  reason: Schema.Literals([
    "UnknownMount",
    "NotOpen",
    "Missing",
    "PlainSecret",
    "InvalidChoice",
    "InvalidValue",
  ]),
}) {
  override get message() {
    const at =
      this.slot === undefined ? this.mount : `${this.mount}.${this.slot}`;
    const location = this.mount === "app" ? "Backend.env" : "Backend.mounts";
    const remedy = {
      UnknownMount:
        "This mount is not listed. Use a mount name from manifest.mounts.",
      NotOpen:
        "This slot is not open. Supply only slots listed in this mount's manifest env.",
      Missing: `This required slot is missing. Supply this required slot in ${location}.`,
      PlainSecret: `This secret is a plain string. Wrap this secret with Redacted.make before passing it in ${location}.`,
      InvalidValue:
        "This value does not match its manifest slot. Supply a string of the declared kind; secret slots require a Redacted string and literals slots require one of their values.",
      InvalidChoice:
        "This provider choice is one the component would refuse. Name one of the providers this selector offers, or a failover or pool of them.",
    };
    return `${at}: ${remedy[this.reason]}`;
  }
}

/**
 * Each mount's settings under the deployment variable the manifest names for
 * it, refusing a manifest that does not decode, a mount or slot the manifest
 * does not list as open, a missing required slot, a plain string for a secret
 * and a provider choice the component would refuse.
 */
export const mountVariables = (
  input: Manifest.Manifest,
  mounts: Readonly<Record<string, Settings>>,
): Effect.Effect<
  Record<string, Variables[string]>,
  InvalidMountSetting | Manifest.UnsupportedManifestFormat
> =>
  Effect.gen(function* () {
    const manifest = yield* Effect.fromResult(
      Manifest.decode(input, "confect/_generated/manifest.ts"),
    );
    const variables: Record<string, Variables[string]> = {};
    yield* Effect.fromResult(Manifest.checkMounts(manifest, mounts)).pipe(
      Effect.mapError(mountRefusal),
    );
    for (const [mount, entry] of Rec.toEntries(manifest.mounts)) {
      const supplied =
        (Rec.has(mounts, mount) ? mounts[mount] : undefined) ?? {};
      yield* Effect.fromResult(
        Manifest.checkOpen(manifest, mount, supplied),
      ).pipe(Effect.mapError(openRefusal));
      const settings = yield* supplySettings(
        mount,
        entry.env,
        supplied,
        (slot, reason) => InvalidMountSetting.make({ mount, slot, reason }),
      );
      for (const [slot, value] of Rec.toEntries(settings)) {
        variables[entry.env[slot]!.variable] = value;
      }
    }
    return variables;
  });

const backend = (
  id: string,
  props: CommonProps & {
    readonly manifest?: Manifest.Manifest;
    readonly env?: Settings;
    readonly automatic?: Variables;
    readonly mounts?: Readonly<Record<string, Settings>>;
  },
) =>
  Namespace.push(
    id,
    Effect.gen(function* () {
      const manifest =
        props.manifest === undefined
          ? undefined
          : yield* Effect.fromResult(
              Manifest.decode(props.manifest, "confect/_generated/manifest.ts"),
            ).pipe(Effect.orDie);
      const promoted =
        manifest === undefined
          ? {}
          : yield* mountVariables(manifest, props.mounts ?? {}).pipe(
              Effect.orDie,
            );
      const automaticInput =
        manifest === undefined
          ? undefined
          : yield* Effect.fromResult(
              automaticVariables(manifest, props.automatic ?? {}),
            ).pipe(Effect.orDie);
      const automatic =
        manifest === undefined || automaticInput === undefined
          ? undefined
          : yield* supplySettings(
              "app",
              Rec.filter(manifest.env, (slot) => slot.automatic === true),
              automaticInput,
              (slot, reason) => InvalidAutomaticSetting.make({ slot, reason }),
            ).pipe(Effect.orDie);
      const env =
        manifest === undefined
          ? props.env
          : yield* supplySettings(
              "app",
              Rec.filter(manifest.env, (slot) => slot.automatic !== true),
              props.env ?? {},
              (slot, reason) =>
                InvalidMountSetting.make({
                  mount: "app",
                  slot,
                  reason,
                }),
            ).pipe(Effect.orDie);
      const variables =
        Rec.keys(promoted).length === 0 && props.automatic === undefined
          ? env
          : { ...env, ...automatic, ...promoted };
      const environment =
        variables === undefined ||
        (props.env === undefined &&
          props.automatic === undefined &&
          Rec.keys(variables).length === 0)
          ? undefined
          : yield* EnvironmentVariables("Environment", {
              ...props.environment,
              url: props.deployment.url,
              deployKey: props.deployKey,
              variables: variables as Variables,
            });
      const code = yield* Code("Code", {
        deployment: {
          name: props.deployment.name,
          url:
            environment !== undefined
              ? Output.map(
                  Output.all(environment.variables, environment.url),
                  ([, url]) => url,
                )
              : props.deployment.url,
        },
        deployKey: props.deployKey,
        ...(props.cwd === undefined ? {} : { cwd: props.cwd }),
        ...(manifest === undefined ? {} : { manifestDigest: manifest.digest }),
        prepare: { command: "confect", args: ["codegen"] },
      });
      return { code, environment, name: code.name, url: code.url };
    }),
  );
