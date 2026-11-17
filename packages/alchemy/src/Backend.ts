import * as Env from "@confect/core/Env";
import * as Manifest from "@confect/core/Manifest";
import type { Input } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Rec from "effect/Record";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import { Code } from "./Code.js";
import { EnvironmentVariables } from "./EnvironmentVariables.js";

interface CommonProps {
  readonly deployment: {
    readonly name: Input<string>;
    readonly url: Input<string>;
  };
  readonly deployKey: Input<Redacted.Redacted<string>>;
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
  reason: Schema.Literals(["NotAutomatic", "Missing"]),
}) {
  override get message(): string {
    return this.reason === "NotAutomatic"
      ? `${this.slot} is not declared automatic in manifest.env. Supply only automatic slots in Backend.automatic; put application values in Backend.env.`
      : `${this.slot} is declared automatic in manifest.env but has no value. Supply it in Backend.automatic.`;
  }
}

const automaticVariables = (
  manifest: Manifest.Manifest,
  supplied: Variables,
): Result.Result<Variables, InvalidAutomaticSetting> =>
  Result.gen(function* () {
    for (const slot of Rec.keys(supplied)) {
      if (
        !Rec.has(manifest.env, slot) ||
        manifest.env[slot]?.automatic !== true
      )
        return yield* Result.fail(
          InvalidAutomaticSetting.make({ slot, reason: "NotAutomatic" }),
        );
    }
    for (const [slot, descriptor] of Rec.toEntries(manifest.env)) {
      if (descriptor.automatic === true && supplied[slot] === undefined)
        return yield* Result.fail(
          InvalidAutomaticSetting.make({ slot, reason: "Missing" }),
        );
    }
    return supplied;
  });

/**
 * A provider choice validated and encoded with the schema the handler decodes
 * it with, after refusing a choice that names a provider whose required setting
 * is unset. A setting belongs to the selector its tag names.
 */
const settleChoice = (
  at: string,
  key: string,
  values: Env.Descriptor & { readonly kind: "providers" },
  slots: Readonly<Record<string, Env.Descriptor>>,
  supplied: Readonly<Record<string, unknown>>,
  value: unknown,
) =>
  Effect.gen(function* () {
    const invalid = InvalidMountSetting.make({
      mount: at,
      slot: key,
      reason: "InvalidChoice",
    });
    const schema = Env.providerChoice(values.values);
    const choice = yield* Schema.decodeUnknownEffect(Schema.toType(schema))(
      value,
    ).pipe(Effect.mapError(() => invalid));
    const named = Env.chosen(choice);
    for (const [slot, other] of Rec.toEntries(slots)) {
      if (
        other.provider?.selector === key &&
        other.provider.required &&
        named.includes(other.provider.name) &&
        supplied[slot] === undefined
      )
        return yield* InvalidMountSetting.make({
          mount: at,
          slot,
          reason: "Missing",
        });
    }
    return yield* Schema.encodeUnknownEffect(schema)(choice).pipe(
      Effect.mapError(() => invalid),
    );
  });

/**
 * Each provider choice in `values` as the string Convex stores. A choice given
 * as an output is settled when it resolves, so a refusal fails the apply before
 * the environment is written and the output keeps its upstream.
 */
const supplyProviders = (
  at: string,
  slots: Readonly<Record<string, Env.Descriptor>>,
  values: Readonly<Record<string, unknown>>,
) =>
  Effect.gen(function* () {
    const written: Record<string, unknown> = { ...values };
    for (const [key, descriptor] of Rec.toEntries(slots)) {
      const value = values[key];
      if (descriptor.kind !== "providers" || value === undefined) continue;
      const settle = (resolved: unknown) =>
        settleChoice(at, key, descriptor, slots, values, resolved);
      written[key] = Output.isOutput(value)
        ? value.pipe(
            Output.mapEffect((resolved) => settle(resolved).pipe(Effect.orDie)),
          )
        : yield* settle(value);
    }
    return written as Variables;
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
    for (const mount of Rec.keys(mounts)) {
      if (!Rec.has(manifest.mounts, mount))
        return yield* InvalidMountSetting.make({
          mount,
          reason: "UnknownMount",
        });
    }
    for (const [mount, entry] of Rec.toEntries(manifest.mounts)) {
      const supplied = mounts[mount] ?? {};
      for (const slot of Rec.keys(supplied)) {
        if (!Rec.has(entry.env, slot))
          return yield* InvalidMountSetting.make({
            mount,
            slot,
            reason: "NotOpen",
          });
      }
      const settings = yield* supplyProviders(mount, entry.env, supplied);
      for (const [slot, open] of Rec.toEntries(entry.env)) {
        const value = settings[slot];
        if (value === undefined) {
          if (!open.optional)
            return yield* InvalidMountSetting.make({
              mount,
              slot,
              reason: "Missing",
            });
          continue;
        }
        const plain = InvalidMountSetting.make({
          mount,
          slot,
          reason: "PlainSecret",
        });
        if (open.kind === "secret" && typeof value === "string")
          return yield* plain;
        variables[open.variable] =
          open.kind === "secret" && Output.isOutput(value)
            ? Output.mapEffect((resolved: string | Redacted.Redacted<string>) =>
                typeof resolved === "string"
                  ? Effect.die(plain)
                  : Effect.succeed(resolved),
              )(value as Output.Output<string | Redacted.Redacted<string>>)
            : value;
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
      const automatic =
        manifest === undefined
          ? undefined
          : yield* Effect.fromResult(
              automaticVariables(manifest, props.automatic ?? {}),
            ).pipe(Effect.orDie);
      const env =
        manifest === undefined || props.env === undefined
          ? props.env
          : yield* supplyProviders("app", manifest.env, props.env).pipe(
              Effect.orDie,
            );
      const variables =
        Rec.keys(promoted).length === 0 && props.automatic === undefined
          ? env
          : { ...env, ...automatic, ...promoted };
      const environment =
        variables === undefined
          ? undefined
          : yield* EnvironmentVariables("Environment", {
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
