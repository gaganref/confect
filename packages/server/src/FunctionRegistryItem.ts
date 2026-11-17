import type * as MiddlewareAttachment from "@confect/core/MiddlewareAttachment";
import type * as FunctionSpec from "@confect/core/FunctionSpec";
import * as Lazy from "@confect/core/Lazy";
import type { FunctionType } from "convex/server";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import type * as Handler from "./Handler.js";

export const TypeId = "~@confect/server/FunctionRegistryItem";
export type TypeId = typeof TypeId;

export const isFunctionRegistryItem = (value: unknown): value is AnyWithProps =>
  Predicate.hasProperty(value, TypeId);

const FunctionRegistryItemProto = {
  [TypeId]: TypeId,
};

/**
 * A function registered by `FunctionImpl.make`, one of two shapes keyed by the
 * spec's provenance.
 */
export type AnyWithProps =
  | ConfectFunctionRegistryItem
  | ConvexFunctionRegistryItem;

export interface ConfectFunctionRegistryItem {
  readonly [TypeId]: TypeId;
  readonly _tag: "Confect";
  readonly name: string;
  readonly reservedArgument?: string;
  readonly functionVisibility: FunctionSpec.FunctionVisibility;
  readonly functionType: FunctionType;
  readonly args: Schema.Codec<any, any>;
  readonly returns: Schema.Codec<any, any>;
  readonly error?: Schema.Codec<any, any>;
  readonly middlewareAttachments: ReadonlyArray<MiddlewareAttachment.MiddlewareAttachment>;
  readonly handler: Handler.AnyConfectProvenance;
}

export interface ConvexFunctionRegistryItem {
  readonly [TypeId]: TypeId;
  readonly _tag: "Convex";
  readonly handler: Handler.AnyConvexProvenance;
}

export interface Items {
  readonly [key: string]: AnyWithProps | Items;
}

/**
 * The items Convex registers: all but routes, which are served over HTTP.
 */
export const convexFunctions = (items: Items): Items =>
  Record.filterMap(items, (value): Result.Result<AnyWithProps | Items, void> =>
    !isFunctionRegistryItem(value)
      ? Result.succeed(convexFunctions(value))
      : value._tag === "Confect" && value.functionVisibility === "http"
        ? Result.failVoid
        : Result.succeed(value),
  );

/**
 * The visibility Convex registers an item under. A route has none.
 */
export const convexVisibility = (
  item: ConfectFunctionRegistryItem,
): FunctionSpec.ConvexVisibility => {
  const visibility = item.functionVisibility;
  if (visibility === "http") {
    throw new Error(
      `Route "${item.name}" is served over HTTP and is not registered with Convex`,
    );
  }
  return visibility;
};

export const make = ({
  functionSpec,
  groupMiddlewareAttachments,
  handler,
}: {
  functionSpec: FunctionSpec.AnyWithProps;
  groupMiddlewareAttachments: ReadonlyArray<MiddlewareAttachment.MiddlewareAttachment>;
  handler: Handler.Any;
}): AnyWithProps =>
  Match.value(functionSpec.functionProvenance).pipe(
    Match.tag("Convex", (): AnyWithProps =>
      Object.assign(Object.create(FunctionRegistryItemProto), {
        _tag: "Convex" as const,
        handler: handler as Handler.AnyConvexProvenance,
      }),
    ),
    Match.tag("Confect", (provenance): AnyWithProps => {
      const item = Object.assign(Object.create(FunctionRegistryItemProto), {
        _tag: "Confect" as const,
        name: functionSpec.name,
        ...(functionSpec.reservedArgument === undefined
          ? {}
          : { reservedArgument: functionSpec.reservedArgument }),
        functionVisibility: functionSpec.functionVisibility,
        functionType: functionSpec.runtimeAndFunctionType.functionType,
        middlewareAttachments: [
          ...groupMiddlewareAttachments,
          ...functionSpec.middlewareAttachments,
        ],
        handler: handler as Handler.AnyConfectProvenance,
      });

      Lazy.defineProperty(item, "args", () => provenance.args);
      Lazy.defineProperty(item, "returns", () => provenance.returns);
      if ("error" in provenance) {
        Lazy.defineProperty(item, "error", () => provenance.error);
      }

      return item as AnyWithProps;
    }),
    Match.exhaustive,
  );
