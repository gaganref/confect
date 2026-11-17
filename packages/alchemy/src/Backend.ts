import * as Manifest from "@confect/core/Manifest";
import type { Input } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Rec from "effect/Record";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
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

export type BackendProps<M extends Manifest.Manifest | undefined = undefined> =
  CommonProps &
    (M extends Manifest.Manifest
      ? { readonly manifest: M } & ({} extends Manifest.Values<M>
          ? { readonly env?: Environment<NoInfer<M>> }
          : { readonly env: Environment<NoInfer<M>> }) &
          ({} extends Manifest.Mounts<M>
            ? { readonly mounts?: MountSettings<NoInfer<M>> }
            : { readonly mounts: MountSettings<NoInfer<M>> })
      : {
          readonly manifest?: never;
          readonly mounts?: never;
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
      Readonly<Record<Exclude<keyof E, keyof M["env"]>, never>>;
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
    readonly env?: Variables;
    readonly mounts?: Readonly<Record<string, Variables>>;
  },
): ReturnType<typeof backend> {
  return backend(id, props);
}

type Variables = Readonly<
  Record<string, Input<string | Redacted.Redacted<string>>>
>;

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
  ]),
}) {
  override get message() {
    const at =
      this.slot === undefined ? this.mount : `${this.mount}.${this.slot}`;
    return `${at}: ${this.reason}`;
  }
}

/**
 * Each mount's settings under the deployment variable the manifest names for
 * it, refusing a mount or slot the manifest does not list as open, a missing
 * required slot, and a plain string for a secret.
 */
export const mountVariables = (
  manifest: Manifest.Manifest,
  mounts: Readonly<Record<string, Variables>>,
): Effect.Effect<Record<string, Variables[string]>, InvalidMountSetting> =>
  Effect.gen(function* () {
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
      for (const [slot, open] of Rec.toEntries(entry.env)) {
        const value = supplied[slot];
        if (value === undefined) {
          if (!open.optional)
            return yield* InvalidMountSetting.make({
              mount,
              slot,
              reason: "Missing",
            });
          continue;
        }
        if (open.kind === "secret" && typeof value === "string")
          return yield* InvalidMountSetting.make({
            mount,
            slot,
            reason: "PlainSecret",
          });
        variables[open.variable] = value;
      }
    }
    return variables;
  });

const backend = (
  id: string,
  props: CommonProps & {
    readonly manifest?: Manifest.Manifest;
    readonly env?: Variables;
    readonly mounts?: Readonly<Record<string, Variables>>;
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
          : // The types refuse every setting this refuses, so reaching it means
            // they were bypassed: a defect, not a stack error.
            yield* mountVariables(manifest, props.mounts ?? {}).pipe(
              Effect.orDie,
            );
      const variables =
        Rec.keys(promoted).length === 0
          ? props.env
          : { ...props.env, ...promoted };
      const environment =
        variables === undefined
          ? undefined
          : yield* EnvironmentVariables("Environment", {
              url: props.deployment.url,
              deployKey: props.deployKey,
              variables,
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
        ...(manifest === undefined ? {} : { digest: manifest.digest }),
        prepare: { command: "confect", args: ["codegen"] },
      });
      return { code, environment, name: code.name, url: code.url };
    }),
  );
