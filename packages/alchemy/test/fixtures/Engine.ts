import type { Providers } from "@confect/alchemy/Providers";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { apply } from "alchemy/Apply";
import { provideFreshArtifactStore } from "alchemy/Artifacts";
import { AuthProviders } from "alchemy/Auth/AuthProvider";
import { CredentialsStore } from "alchemy/Auth/Credentials";
import { ProfileStore } from "alchemy/Auth/Profile";
import { layerNonInteractive } from "alchemy/Interaction";
import * as Plan from "alchemy/Plan";
import * as Stack from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { State, type StateService } from "alchemy/State/State";
import * as Effect from "effect/Effect";
import type * as Context from "effect/Context";
import * as Array from "effect/Array";
import * as Record from "effect/Record";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as HttpClient from "effect/http/HttpClient";
import { inspect } from "node:util";
import * as NodeTestServices from "./NodeTestServices";

/**
 * @stability unstable
 */
export const makeEngine = Effect.fn("Test.makeEngine")(function* (
  providers: Layer.Layer<Providers, never, Stack.StackServices>,
  wrapStore: (store: StateService) => StateService = (store) => store,
  engineOptions: { readonly dotAlchemy?: string } = {},
) {
  const memory = yield* InMemoryService();
  const store = wrapStore(memory);
  const credentials: Context.Service.Shape<typeof CredentialsStore> = {
    read: () => Effect.undefined,
    write: () => Effect.void,
    delete: () => Effect.void,
    deleteProfile: () => Effect.void,
    scoped: () => credentials,
  };
  const state = Layer.succeed(State, Effect.succeed(store));
  const logs: string[] = [];
  const planOutputs: string[] = [];
  const plans: { fqn: string; action: string; deleteFirst: boolean }[][] = [];
  const planDependencies: Record<string, string[]>[] = [];
  const context = Layer.mergeAll(
    NodeTestServices.layer,
    state,
    Layer.succeed(CredentialsStore, credentials),
    Layer.mock(ProfileStore, {}),
    Layer.succeed(AuthProviders, {}),
    layerNonInteractive(),
    Layer.succeed(Stage, "test"),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Unexpected network request")),
    ),
    Logger.layer(
      [
        Logger.make((entry) => {
          logs.push(inspect(entry.message));
        }),
      ],
      { mergeWithExisting: false },
    ),
  );
  const run = <A, E, R extends Providers | Stack.StackServices>(
    program: Effect.Effect<A, E, R>,
    options: { adopt?: boolean; apply?: boolean } = {},
  ) =>
    Effect.gen(function* () {
      const services = yield* Layer.build(context);
      return yield* program.pipe(
        Stack.make({ name: "lifecycle", providers, state }),
        Effect.flatMap((compiled) =>
          Plan.make(compiled).pipe(
            Effect.tap((plan) =>
              Effect.sync(() => {
                planOutputs.push(
                  inspect(
                    {
                      resources: Record.map(plan.resources, (node) => ({
                        action: node.action,
                        props: "props" in node ? node.props : undefined,
                        state: node.state,
                      })),
                      output: plan.output,
                    },
                    { depth: null },
                  ),
                );
                planDependencies.push(
                  Record.map(plan.resources, (node) => node.downstream),
                );
                plans.push(
                  Array.map(
                    Record.toEntries(plan.resources),
                    ([fqn, node]) => ({
                      fqn,
                      action: node.action,
                      deleteFirst: "deleteFirst" in node && node.deleteFirst,
                    }),
                  ),
                );
              }),
            ),
            Effect.flatMap((plan) =>
              options.apply === false ? Effect.undefined : apply(plan),
            ),
            Effect.provideContext(compiled.services),
          ),
        ),
        provideFreshArtifactStore,
        Effect.provideContext(services),
        Effect.provideService(AlchemyContext, {
          dotAlchemy: engineOptions.dotAlchemy ?? ".alchemy",
          dev: false,
          adopt: options.adopt ?? false,
        }),
      );
    }).pipe(Effect.scoped);
  const rows = () =>
    Effect.gen(function* () {
      const fqns = yield* store.list({ stack: "lifecycle", stage: "test" });
      return yield* Effect.forEach(fqns, (fqn) =>
        store.get({ stack: "lifecycle", stage: "test", fqn }),
      );
    });
  return { run, rows, store, logs, plans, planOutputs, planDependencies };
});
