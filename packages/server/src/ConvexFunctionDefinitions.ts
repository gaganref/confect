import type * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Arr from "effect/Array";
import * as Record from "effect/Record";
import type * as GroupSpec from "@confect/core/GroupSpec";
import type * as FunctionSpec from "@confect/core/FunctionSpec";
import type * as DatabaseSchema from "./DatabaseSchema.js";
import type * as GroupImpl from "./GroupImpl.js";
import * as GroupRegistry from "./GroupRegistry.js";
import * as FunctionRegistryItem from "./FunctionRegistryItem.js";
import * as PushCheck from "./PushCheck.js";
import * as RegisteredConvexFunction from "./RegisteredConvexFunction.js";
import type * as RegisteredFunctions from "./RegisteredFunctions.js";
import * as ResolvedMiddleware from "./ResolvedMiddleware.js";
import { mapLeaves } from "./internal/utils.js";

export interface Definitions {
  readonly [name: string]: RegisteredConvexFunction.Definition | Definitions;
}

type DefinitionTag<
  Function extends FunctionSpec.AnyWithProps,
  Provenance = Function["functionProvenance"],
> = Provenance extends { readonly _tag: "Convex" }
  ? "Registered"
  : `${Capitalize<Function["functionVisibility"]>}${Capitalize<Function["runtimeAndFunctionType"]["functionType"]>}`;

export type ForGroup<Group extends GroupSpec.AnyWithProps> = {
  readonly [
    Name in FunctionSpec.Name<
      Exclude<
        GroupSpec.Functions<Group>,
        { readonly functionVisibility: "http" }
      >
    >
  ]: Extract<
    RegisteredConvexFunction.Definition,
    {
      readonly _tag: DefinitionTag<
        FunctionSpec.WithName<GroupSpec.Functions<Group>, Name>
      >;
    }
  >;
} & {
  readonly [Name in GroupSpec.Name<GroupSpec.Groups<Group>>]: ForGroup<
    GroupSpec.WithName<GroupSpec.Groups<Group>, Name>
  >;
};

export const isDefinition = (
  value: RegisteredConvexFunction.Definition | Definitions,
): value is RegisteredConvexFunction.Definition =>
  typeof value._tag === "string";

const registerDefinitions = (
  definitions: Definitions,
): RegisteredFunctions.AnyWithProps =>
  Record.map(definitions, (value) =>
    isDefinition(value)
      ? RegisteredConvexFunction.register(value)
      : registerDefinitions(value),
  );

export const register = <Group extends GroupSpec.AnyWithProps>(
  definitions: Definitions,
): RegisteredFunctions.RegisteredFunctionsForGroupSpec<Group> =>
  registerDefinitions(
    definitions,
  ) as RegisteredFunctions.RegisteredFunctionsForGroupSpec<Group>;

export const buildForGroup = <Group extends GroupSpec.AnyWithProps>(
  databaseSchema: DatabaseSchema.AnyWithProps,
  groupLayer: Layer.Layer<GroupImpl.GroupImpl<"Finalized">>,
): ForGroup<Group> => {
  const { functionRegistryItems, middlewareRegistryItems, observability } =
    GroupRegistry.make(groupLayer);
  return mapLeaves<
    FunctionRegistryItem.AnyWithProps,
    RegisteredConvexFunction.Definition
  >(
    FunctionRegistryItem.convexFunctions(
      functionRegistryItems as FunctionRegistryItem.Items,
    ),
    FunctionRegistryItem.isFunctionRegistryItem,
    (item, path) =>
      Match.value(item).pipe(
        // A generated registration returns a raw Convex function's handler as
        // it is, so the handler runs the backend's push checks itself.
        Match.tag("Convex", ({ handler }) =>
          RegisteredConvexFunction.Definition.Registered({
            handler: PushCheck.guardCopy(
              handler,
              databaseSchema,
              Arr.join(path, "."),
            ),
          }),
        ),
        Match.tag("Confect", (confect) =>
          RegisteredConvexFunction.prepare(
            databaseSchema,
            confect,
            ResolvedMiddleware.resolve(confect, middlewareRegistryItems),
            observability,
          ),
        ),
        Match.exhaustive,
      ),
  ) as ForGroup<Group>;
};
