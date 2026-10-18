import * as Provider from "alchemy/Provider";
import type { ProviderMode } from "alchemy/ProviderMode";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { Providers } from "./Providers";
import { deploy } from "./internal/CodeDeployment";
import { CommandRunner, type PrepareCommand } from "./internal/CommandRunner";
import { PushLock } from "./internal/PushLock";

export interface CodeProps {
  readonly deployment: { readonly name: string; readonly url: string };
  readonly deployKey: Redacted.Redacted<string>;
  readonly cwd?: string;
  readonly prepare?: PrepareCommand;
}

export interface CodeAttributes {
  readonly name: string;
  readonly url: string;
}

export type Code = Resource<
  "Convex.Code",
  CodeProps,
  CodeAttributes,
  never,
  Providers
>;
export const Code = Resource<Code>("Convex.Code");

const make = (mode: ProviderMode) =>
  Effect.gen(function* () {
    const runner = yield* CommandRunner;
    const lock = yield* PushLock;
    return {
      read: ({ output }) => Effect.succeed(output),
      diff: () => Effect.succeed({ action: "update" }),
      reconcile: ({ news }) =>
        deploy(news, mode).pipe(
          Effect.provideService(CommandRunner, runner),
          Effect.provideService(PushLock, lock),
        ),
      delete: () => Effect.void,
    } satisfies Provider.ProviderServiceInput<Code>;
  });

export const provider = make("live");
/**
 * Under `alchemy dev`, pushes go to the local backend's self-hosted target.
 */
export const localProvider = make("local");

export const layer = Provider.effect(Code, provider);
export const localLayer = Provider.effect(Code, localProvider);
