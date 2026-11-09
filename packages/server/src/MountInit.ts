import * as Mount from "@confect/core/Mount";
import { internalMutationGeneric } from "convex/server";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Callback from "./Callback.js";

/**
 * A mount the push visits: its `init`, if its component declares one, and
 * whether its component lists mounts of its own.
 */
export interface Entry {
  readonly mount: Mount.Any;
  readonly nested: boolean;
}

/**
 * What the push does at one mount, in order. A mount whose callback handles
 * cannot be made ends the list with its failure, so no later mount runs.
 */
export type Step =
  | {
      readonly componentPath: string;
      readonly nested: boolean;
      readonly init: {
        readonly functionName: string;
        readonly args: unknown;
      } | null;
    }
  | { readonly componentPath: string; readonly failure: string };

const failure = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

const step = (entry: Entry) =>
  Mount.initCall(entry.mount, (contract, ref) =>
    Callback.create(contract, ref as never),
  ).pipe(
    Effect.exit,
    Effect.map((exit): Step =>
      Exit.isSuccess(exit)
        ? {
            componentPath: Mount.data(entry.mount).name,
            nested: entry.nested,
            init: Option.match(exit.value, {
              onNone: () => null,
              onSome: ({ functionName, args }) => ({ functionName, args }),
            }),
          }
        : {
            componentPath: Mount.data(entry.mount).name,
            failure: failure(exit.cause),
          },
    ),
  );

/**
 * The internal mutation codegen writes to `convex/confectDeploy.ts`. It makes
 * each mount's callback handles and returns the steps a push runs, in
 * declaration order.
 */
export const mutation = (entries: ReadonlyArray<Entry>) =>
  internalMutationGeneric({
    args: {},
    handler: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const steps: Array<Step> = [];
          for (const entry of entries) {
            const next = yield* step(entry);
            steps.push(next);
            if ("failure" in next) break;
          }
          return steps;
        }),
      ),
  });
