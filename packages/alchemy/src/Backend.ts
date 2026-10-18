import type * as Manifest from "@confect/core/Manifest";
import type { Input } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { Code } from "./Code";
import { EnvironmentVariables } from "./EnvironmentVariables";

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

export type BackendProps<M extends Manifest.Manifest | undefined = undefined> =
  CommonProps &
    (M extends Manifest.Manifest
      ? { readonly manifest: M } & ({} extends Manifest.Values<M>
          ? { readonly env?: Environment<NoInfer<M>> }
          : { readonly env: Environment<NoInfer<M>> })
      : {
          readonly manifest?: never;
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
>(
  id: string,
  props: BackendProps<M> & {
    readonly env?: E &
      Readonly<Record<Exclude<keyof E, keyof M["env"]>, never>>;
  },
): ReturnType<typeof backend>;
export function Backend(
  id: string,
  props: BackendProps,
): ReturnType<typeof backend>;
export function Backend(
  id: string,
  props: CommonProps & {
    readonly env?: Readonly<
      Record<string, Input<string | Redacted.Redacted<string>>>
    >;
  },
): ReturnType<typeof backend> {
  return backend(id, props);
}

const backend = (
  id: string,
  props: CommonProps & {
    readonly env?: Readonly<
      Record<string, Input<string | Redacted.Redacted<string>>>
    >;
  },
) =>
  Namespace.push(
    id,
    Effect.gen(function* () {
      const environment =
        props.env === undefined
          ? undefined
          : yield* EnvironmentVariables("Environment", {
              url: props.deployment.url,
              deployKey: props.deployKey,
              variables: props.env,
            });
      const code = yield* Code("Code", {
        deployment: {
          name: props.deployment.name,
          url: environment
            ? Output.map(
                Output.all(environment.variables, environment.url),
                ([, url]) => url,
              )
            : props.deployment.url,
        },
        deployKey: props.deployKey,
        ...(props.cwd === undefined ? {} : { cwd: props.cwd }),
        prepare: { command: "confect", args: ["codegen"] },
      });
      return { code, environment, name: code.name, url: code.url };
    }),
  );
