import type * as GroupSpec from "@confect/core/GroupSpec";
import type * as MiddlewareSpec from "@confect/core/MiddlewareSpec";
import * as Registry from "./Registry.js";
import * as RegistryItems from "./RegistryItems.js";
import * as Array from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import type * as DatabaseSchema from "./DatabaseSchema.js";
import type * as FunctionImpl from "./FunctionImpl.js";
import type * as MiddlewareImpl from "./MiddlewareImpl.js";

export const TypeId = "~@confect/server/GroupImpl";
export type TypeId = typeof TypeId;

export type FinalizationStatus = "Unfinalized" | "Finalized";

export interface GroupImpl<
  FinalizationStatus_ extends FinalizationStatus = "Unfinalized",
> {
  readonly [TypeId]: TypeId;
  readonly finalizationStatus: FinalizationStatus_;
  /**
   * Names of every function registered into this group's layer scope by
   * `FunctionImpl.make`. Authoritative only when `finalizationStatus` is
   * `"Finalized"`; the `"Unfinalized"` value is set to `[]` at `make`-time
   * since the list is only known once `finalize` snapshots the registry.
   */
  readonly registeredFunctionNames: ReadonlyArray<string>;
  /**
   * Keys of every middleware whose implementation registered into this group's
   * layer scope via `MiddlewareImpl.make` (and friends). Same authoritativeness
   * caveat as `registeredFunctionNames`. Lets consumers (the CLI's
   * `validateImpl`) verify middleware-impl completeness against a `GroupSpec`'s
   * attached middleware without inspecting the `Registry`.
   */
  readonly registeredMiddlewareKeys: ReadonlyArray<string>;
}

export interface Any extends GroupImpl<FinalizationStatus> {}

export const isGroupImpl = (u: unknown): u is Any =>
  Predicate.hasProperty(u, TypeId);

export interface AnyFinalized extends GroupImpl<"Finalized"> {}
export interface AnyUnfinalized extends GroupImpl<"Unfinalized"> {}

export const isFinalizedGroupImpl = (u: unknown): u is AnyFinalized =>
  isGroupImpl(u) && u.finalizationStatus === "Finalized";

export const isUnfinalizedGroupImpl = (u: unknown): u is AnyUnfinalized =>
  isGroupImpl(u) && u.finalizationStatus === "Unfinalized";

/**
 * Build the runtime tag for a `GroupImpl` service. The finalization status is
 * embedded in the tag string so that `Unfinalized` and `Finalized` are distinct
 * services at runtime; consumers of a finalized layer (the server's
 * `RegisteredFunctions.buildForGroup` and the CLI's `validateImpl`) retrieve
 * the typed `Finalized` service directly rather than scanning the context.
 *
 * The tag is keyed only by finalization status—no group path—because each
 * group's impl layer is built in its own isolated scope
 * (`buildForGroup`/`validateImpl` each provide a fresh `Registry`), so at most
 * one `GroupImpl` service of each status exists per build.
 */
export const GroupImpl = <FinalizationStatus_ extends FinalizationStatus>({
  finalizationStatus,
}: {
  finalizationStatus: FinalizationStatus_;
}) =>
  Context.Service<GroupImpl<FinalizationStatus_>>(
    `@confect/server/GroupImpl/${finalizationStatus}`,
  );

/**
 * Begin a group's impl layer. `databaseSchema` and `group` are retained only as
 * type-level carriers (`group` drives the required `FunctionImpl` services via
 * `FromGroupSpec<Group>`; `databaseSchema` keeps the impl's dependency on
 * `_generated/schema` symmetric with `FunctionImpl.make`). Neither is read at
 * runtime.
 */
export const make = <
  DatabaseSchema_ extends DatabaseSchema.AnyWithProps,
  Group extends GroupSpec.AnyWithProps,
>(
  _databaseSchema: DatabaseSchema_,
  _group: Group &
    MiddlewareSpec.ValidateImplRequires<
      GroupSpec.Functions<Group>,
      GroupSpec.MiddlewareSpecs<Group>
    >,
): Layer.Layer<
  GroupImpl<"Unfinalized">,
  never,
  FunctionImpl.FromGroupSpec<Group> | MiddlewareImpl.FromGroupSpec<Group>
> =>
  Layer.succeed(
    GroupImpl<"Unfinalized">({ finalizationStatus: "Unfinalized" }),
    {
      [TypeId]: TypeId,
      finalizationStatus: "Unfinalized" as const,
      registeredFunctionNames: [],
      registeredMiddlewareKeys: [],
    },
  ) as Layer.Layer<
    GroupImpl<"Unfinalized">,
    never,
    FunctionImpl.FromGroupSpec<Group> | MiddlewareImpl.FromGroupSpec<Group>
  >;

const findGroupImpl = <S>(context: Context.Context<S>): Option.Option<Any> =>
  Array.findFirst(context.mapUnsafe.values(), isGroupImpl);

export class MissingRequiredMiddlewareError extends Data.TaggedError(
  "MissingRequiredMiddlewareError",
)<{
  readonly missing: ReadonlyArray<RegistryItems.MissingMiddleware>;
}> {
  override get message(): string {
    return `GroupImpl.finalize: ${this.missing.map(({ functionName, middlewareKey }) => `${functionName} requires middleware "${middlewareKey}"`).join("\n")}`;
  }
}

type Finalizable = Layer.Layer<AnyUnfinalized> | Layer.Layer<AnyFinalized>;

/**
 * Mark a `GroupImpl` layer as fully implemented. The parameter type defaults
 * `RIn = never`, so passing a layer that still requires any `FunctionImpl`
 * service produces a type error at the impl author's site. The codegen boundary
 * requires the resulting `"Finalized"` brand, so omitting this call is also
 * rejected downstream.
 *
 * As a side effect of finalization, the names of every `FunctionImpl` that
 * registered into this group's scope are snapshotted onto the produced service
 * value's `registeredFunctionNames` field, so consumers can verify impl
 * completeness against a `GroupSpec`'s expected functions without having to
 * inspect the `Registry` themselves. Pass `{ required }` to check every
 * registered function's middleware at layer build, including internal
 * functions. This form also accepts a finalized layer so generated registration
 * can enforce the backend declaration without changing authored impls. Pass
 * `groupPath` to qualify uncovered function names in the diagnostic.
 */
export function finalize(options: {
  readonly groupPath?: string;
  readonly required: ReadonlyArray<
    Pick<MiddlewareSpec.AnyMiddlewareSpec, "key">
  >;
}): (group: Finalizable) => Layer.Layer<GroupImpl<"Finalized">>;
export function finalize(
  group: Layer.Layer<GroupImpl<"Unfinalized">>,
): Layer.Layer<GroupImpl<"Finalized">>;
export function finalize(
  input:
    | Finalizable
    | {
        readonly groupPath?: string;
        readonly required: ReadonlyArray<
          Pick<MiddlewareSpec.AnyMiddlewareSpec, "key">
        >;
      },
):
  | Layer.Layer<GroupImpl<"Finalized">>
  | ((group: Finalizable) => Layer.Layer<GroupImpl<"Finalized">>) {
  return "required" in input
    ? (group) => finalizeWith(group, input.required, input.groupPath)
    : finalizeWith(input, []);
}

const finalizeWith = (
  group: Layer.Layer<never>,
  required: ReadonlyArray<Pick<MiddlewareSpec.AnyMiddlewareSpec, "key">>,
  groupPath = "",
): Layer.Layer<GroupImpl<"Finalized">> =>
  Layer.flatMap(group, (context): Layer.Layer<GroupImpl<"Finalized">> =>
    findGroupImpl(context).pipe(
      Option.match({
        onNone: () =>
          Layer.effect(
            GroupImpl<"Finalized">({ finalizationStatus: "Finalized" }),
            Effect.die(
              new Error(
                "GroupImpl.finalize: no GroupImpl service was found in the layer's context.",
              ),
            ),
          ),
        onSome: () =>
          Layer.effect(
            GroupImpl<"Finalized">({ finalizationStatus: "Finalized" }),
            Effect.gen(function* () {
              const registry = yield* Registry.Registry;
              const items = yield* Ref.get(registry);
              const missing = RegistryItems.missingRequired(
                items,
                required,
                groupPath,
              );
              if (missing.length > 0) {
                return yield* Effect.die(
                  new MissingRequiredMiddlewareError({ missing }),
                );
              }
              return {
                [TypeId]: TypeId,
                finalizationStatus: "Finalized" as const,
                registeredFunctionNames: RegistryItems.functionNames(items),
                registeredMiddlewareKeys: RegistryItems.middlewareKeys(items),
              };
            }),
          ),
      }),
    ),
  );

export type FromGroupSpec<Group extends GroupSpec.AnyWithProps> =
  | FunctionImpl.FromGroupSpec<Group>
  | MiddlewareImpl.FromGroupSpec<Group>;
