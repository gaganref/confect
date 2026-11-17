import type { Types } from "effect";
import * as Array from "effect/Array";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import type * as FunctionSpec from "./FunctionSpec.js";
import type * as GroupSpec from "./GroupSpec.js";
import type * as MiddlewareSpec from "./MiddlewareSpec.js";
import * as Ref from "./Ref.js";
import * as Spec from "./Spec.js";

export type Refs<
  Spec_ extends Spec.AnyWithProps,
  Predicate extends Ref.Any = Ref.Any,
> = Types.Simplify<OmitEmpty<Helper<Spec.Groups<Spec_>, Predicate>>>;

export interface FromSpec<Spec_ extends Spec.AnyWithProps> {
  public: Refs<Spec_, Ref.AnyPublic>;
  internal: Refs<Spec_, Ref.AnyInternal>;
}

type GroupRefs<
  Group extends GroupSpec.AnyWithProps,
  Predicate extends Ref.Any,
> = Types.Simplify<
  OmitEmpty<Helper<GroupSpec.Groups<Group>, Predicate>> &
    FilteredFunctions<
      GroupSpec.Functions<Group>,
      Predicate,
      MiddlewareSpec.Error<GroupSpec.MiddlewareSpecs<Group>>,
      MiddlewareSpec.EncodedError<GroupSpec.MiddlewareSpecs<Group>>
    >
>;

type OmitEmpty<T> = {
  [K in keyof T as keyof T[K] extends never ? never : K]: T[K];
};

type FunctionSpecMatchesPredicate<
  FunctionSpec_ extends FunctionSpec.AnyWithProps,
  Predicate extends Ref.Any,
> =
  Ref.Ref<
    FunctionSpec.GetRuntimeAndFunctionType<FunctionSpec_>,
    FunctionSpec.GetFunctionVisibility<FunctionSpec_>,
    any,
    any,
    any
  > extends Predicate
    ? true
    : false;

type FilteredFunctions<
  FunctionSpecs extends FunctionSpec.AnyWithProps,
  Predicate extends Ref.Any,
  MiddlewareError,
  MiddlewareEncodedError,
> = {
  [
    Name in FunctionSpec.Name<FunctionSpecs> as FunctionSpec.WithName<
      FunctionSpecs,
      Name
    > extends infer FunctionSpec_ extends FunctionSpec.AnyWithProps
      ? FunctionSpecMatchesPredicate<FunctionSpec_, Predicate> extends true
        ? Name
        : never
      : never
  ]: FunctionSpec.WithName<FunctionSpecs, Name> extends infer F extends
    FunctionSpec.AnyWithProps
    ? F extends { readonly functionProvenance: { readonly _tag: "Confect" } }
      ? Ref.FromFunctionSpec<F, MiddlewareError, MiddlewareEncodedError>
      : Ref.FromFunctionSpec<F>
    : never;
};

type Helper<
  Groups extends GroupSpec.AnyWithProps,
  Predicate extends Ref.Any,
> = {
  [GroupName in GroupSpec.Name<Groups>]: GroupSpec.WithName<
    Groups,
    GroupName
  > extends infer Group extends GroupSpec.AnyWithProps
    ? GroupRefs<Group, Predicate>
    : never;
};

type Any =
  | {
      readonly [key: string]: Any;
    }
  | Ref.Any;

export const make = <Spec_ extends Spec.AnyWithProps>(
  spec: Spec_,
): FromSpec<Spec_> => {
  const groups = Spec.groups(spec);
  return {
    public: makeHelper(groups, "public") as Refs<Spec_, Ref.AnyPublic>,
    internal: makeHelper(groups, "internal") as Refs<Spec_, Ref.AnyInternal>,
  };
};

const makeHelper = (
  groups: Record.ReadonlyRecord<string, GroupSpec.Any>,
  visibility: "public" | "internal",
  convexFunctionNamespace: Option.Option<string> = Option.none(),
): Any =>
  pipe(
    groups as Record.ReadonlyRecord<string, GroupSpec.AnyWithProps>,
    Record.map((group, name) => {
      const currentConvexFunctionNamespace = Option.match(
        convexFunctionNamespace,
        {
          onNone: () => name,
          onSome: (parentNamespace) => `${parentNamespace}/${name}`,
        },
      );

      // A clash is a mistake in the spec whatever the visibility, so it is
      // checked before functions are filtered out and groups are pruned.
      const clashingName = Array.findFirst(
        Record.keys(group.functions),
        (functionName) => Record.has(group.groups, functionName),
      );
      if (Option.isSome(clashingName)) {
        throw new Error(
          `Group and function at same level have same name ('${currentConvexFunctionNamespace}:${clashingName.value}')`,
        );
      }

      return {
        ...makeHelper(
          group.groups,
          visibility,
          Option.some(currentConvexFunctionNamespace),
        ),
        ...Record.map(
          Record.filter(
            group.functions,
            (function_) => function_.functionVisibility === visibility,
          ),
          (function_) =>
            Ref.make(
              currentConvexFunctionNamespace,
              function_,
              group.middlewareAttachments,
            ),
        ),
      };
    }),
    Record.filter((group) => !Record.isEmptyRecord(group)),
  );
