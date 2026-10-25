import type * as MiddlewareAttachment from "./MiddlewareAttachment.js";
import type {
  DefaultFunctionArgs,
  FunctionType,
  FunctionVisibility,
  RegisteredAction,
  RegisteredMutation,
  RegisteredQuery,
} from "convex/server";
import type * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import * as FunctionProvenance from "./FunctionProvenance.js";
import { validateConfectFunctionIdentifier } from "./Identifier.js";
import type * as MiddlewareSpec from "./MiddlewareSpec.js";
import type * as Profile from "./Profile.js";
import * as RuntimeAndFunctionType from "./RuntimeAndFunctionType.js";

export const TypeId = "~@confect/core/FunctionSpec";
export type TypeId = typeof TypeId;

export const isFunctionSpec = (u: unknown): u is AnyWithProps =>
  Predicate.hasProperty(u, TypeId);

export interface FunctionSpec<
  RuntimeAndFunctionType_ extends RuntimeAndFunctionType.RuntimeAndFunctionType,
  FunctionVisibility_ extends FunctionVisibility,
  Name_ extends string,
  FunctionProvenance_ extends FunctionProvenance.FunctionProvenance,
  MiddlewareSpecs_ extends MiddlewareSpec.AnyMiddlewareSpec = never,
> {
  readonly [TypeId]: TypeId;
  readonly runtimeAndFunctionType: RuntimeAndFunctionType_;
  readonly functionVisibility: FunctionVisibility_;
  readonly name: Name_;
  readonly functionProvenance: FunctionProvenance_;
  readonly middlewareSpecs: ReadonlyArray<MiddlewareSpecs_>;
  readonly middlewareAttachments: ReadonlyArray<
    MiddlewareAttachment.MiddlewareAttachment<MiddlewareSpecs_>
  >;
}

export interface Builder<
  RuntimeAndFunctionType_ extends RuntimeAndFunctionType.RuntimeAndFunctionType,
  FunctionVisibility_ extends FunctionVisibility,
  Name_ extends string,
  FunctionProvenance_ extends FunctionProvenance.FunctionProvenance,
  MiddlewareSpecs_ extends MiddlewareSpec.AnyMiddlewareSpec = never,
> extends FunctionSpec<
  RuntimeAndFunctionType_,
  FunctionVisibility_,
  Name_,
  FunctionProvenance_,
  MiddlewareSpecs_
> {
  middleware<MiddlewareSpec_ extends MiddlewareSpec.AnyMiddlewareSpec>(
    middlewareSpec: MiddlewareSpec_ &
      MiddlewareSpec.ValidateFunctionAttach<
        MiddlewareSpec_,
        RuntimeAndFunctionType_,
        FunctionProvenance_,
        MiddlewareSpecs_
      >,
    ...options: MiddlewareAttachment.Args<NoInfer<MiddlewareSpec_>>
  ): Builder<
    RuntimeAndFunctionType_,
    FunctionVisibility_,
    Name_,
    FunctionProvenance_,
    MiddlewareSpecs_ | MiddlewareSpec_
  >;
}

export interface DescribedBuilder<
  RuntimeAndFunctionType_ extends RuntimeAndFunctionType.RuntimeAndFunctionType,
  FunctionVisibility_ extends FunctionVisibility,
  Name_ extends string,
  FunctionProvenance_ extends FunctionProvenance.FunctionProvenance,
  MiddlewareSpecs_ extends MiddlewareSpec.AnyMiddlewareSpec = never,
> extends Builder<
  RuntimeAndFunctionType_,
  FunctionVisibility_,
  Name_,
  FunctionProvenance_,
  MiddlewareSpecs_
> {
  readonly description?: string;

  middleware<MiddlewareSpec_ extends MiddlewareSpec.AnyMiddlewareSpec>(
    middlewareSpec: MiddlewareSpec_ &
      MiddlewareSpec.ValidateFunctionAttach<
        MiddlewareSpec_,
        RuntimeAndFunctionType_,
        FunctionProvenance_,
        MiddlewareSpecs_
      >,
    ...options: MiddlewareAttachment.Args<NoInfer<MiddlewareSpec_>>
  ): DescribedBuilder<
    RuntimeAndFunctionType_,
    FunctionVisibility_,
    Name_,
    FunctionProvenance_,
    MiddlewareSpecs_ | MiddlewareSpec_
  >;
}

/**
 * A spec built through {@link extend}, keeping its fields through middleware.
 */
export interface ExtendedBuilder<
  RuntimeAndFunctionType_ extends RuntimeAndFunctionType.RuntimeAndFunctionType,
  FunctionVisibility_ extends FunctionVisibility,
  Name_ extends string,
  FunctionProvenance_ extends FunctionProvenance.FunctionProvenance,
  MiddlewareSpecs_ extends MiddlewareSpec.AnyMiddlewareSpec,
  Fields_,
> extends Builder<
  RuntimeAndFunctionType_,
  FunctionVisibility_,
  Name_,
  FunctionProvenance_,
  MiddlewareSpecs_
> {
  readonly description?: string;
  readonly fields: Fields_;

  middleware<MiddlewareSpec_ extends MiddlewareSpec.AnyMiddlewareSpec>(
    middlewareSpec: MiddlewareSpec_ &
      MiddlewareSpec.ValidateFunctionAttach<
        MiddlewareSpec_,
        RuntimeAndFunctionType_,
        FunctionProvenance_,
        MiddlewareSpecs_
      >,
    ...options: MiddlewareAttachment.Args<NoInfer<MiddlewareSpec_>>
  ): ExtendedBuilder<
    RuntimeAndFunctionType_,
    FunctionVisibility_,
    Name_,
    FunctionProvenance_,
    MiddlewareSpecs_ | MiddlewareSpec_,
    Fields_
  >;
}

export interface Any {
  readonly [TypeId]: TypeId;
}

export interface AnyWithProps extends FunctionSpec<
  RuntimeAndFunctionType.RuntimeAndFunctionType,
  FunctionVisibility,
  string,
  FunctionProvenance.FunctionProvenance,
  MiddlewareSpec.AnyMiddlewareSpec
> {
  readonly description?: string;
  readonly fields?: object;
}

export interface AnyConfect extends FunctionSpec<
  RuntimeAndFunctionType.RuntimeAndFunctionType,
  FunctionVisibility,
  string,
  FunctionProvenance.AnyConfect,
  MiddlewareSpec.AnyMiddlewareSpec
> {}

export interface AnyConvex extends FunctionSpec<
  RuntimeAndFunctionType.RuntimeAndFunctionType,
  FunctionVisibility,
  string,
  FunctionProvenance.AnyConvex,
  MiddlewareSpec.AnyMiddlewareSpec
> {}

export interface AnyWithPropsWithRuntime<
  Runtime extends RuntimeAndFunctionType.Runtime,
> extends FunctionSpec<
  RuntimeAndFunctionType.WithRuntime<Runtime>,
  FunctionVisibility,
  string,
  FunctionProvenance.FunctionProvenance,
  MiddlewareSpec.AnyMiddlewareSpec
> {}

export interface AnyWithPropsWithFunctionType<
  RuntimeAndFunctionType_ extends RuntimeAndFunctionType.RuntimeAndFunctionType,
> extends FunctionSpec<
  RuntimeAndFunctionType_,
  FunctionVisibility,
  string,
  FunctionProvenance.FunctionProvenance,
  MiddlewareSpec.AnyMiddlewareSpec
> {}

export interface AnyWithPropsWithFunctionProvenance<
  FunctionProvenance_ extends FunctionProvenance.FunctionProvenance,
> extends FunctionSpec<
  RuntimeAndFunctionType.RuntimeAndFunctionType,
  FunctionVisibility,
  string,
  FunctionProvenance_,
  MiddlewareSpec.AnyMiddlewareSpec
> {}

export type GetRuntimeAndFunctionType<FunctionSpec_ extends AnyWithProps> =
  FunctionSpec_["runtimeAndFunctionType"];

export type GetFunctionVisibility<FunctionSpec_ extends AnyWithProps> =
  FunctionSpec_["functionVisibility"];

export type GetFunctionProvenance<FunctionSpec_ extends AnyWithProps> =
  FunctionSpec_["functionProvenance"];

export type Name<FunctionSpec_ extends AnyWithProps> = FunctionSpec_["name"];

export type MiddlewareSpecs<FunctionSpec_ extends AnyWithProps> =
  FunctionSpec_["middlewareSpecs"][number];

/**
 * The field map declared by a Confect-provenance spec.
 */
export type ArgsFields<FunctionSpec_ extends AnyWithProps> =
  FunctionSpec_ extends {
    readonly functionProvenance: {
      readonly _tag: "Confect";
      readonly "~ArgsFields": infer ArgsFields_ extends
        FunctionProvenance.ArgsFields;
    };
  }
    ? ArgsFields_
    : FunctionSpec_ extends {
          readonly functionProvenance: { readonly _tag: "Confect" };
        }
      ? FunctionProvenance.ArgsFields
      : never;

/**
 * The args schema assembled from a Confect-provenance spec's field map.
 */
export type ArgsSchema<FunctionSpec_ extends AnyWithProps> =
  FunctionSpec_ extends {
    readonly functionProvenance: {
      readonly _tag: "Confect";
      readonly "~ArgsFields": infer ArgsFields_ extends
        FunctionProvenance.ArgsFields;
    };
  }
    ? Schema.Struct<ArgsFields_>
    : FunctionSpec_ extends {
          readonly functionProvenance: {
            readonly _tag: "Confect";
            readonly args: infer ArgsSchema_ extends
              FunctionProvenance.AnyArgsSchema;
          };
        }
      ? ArgsSchema_
      : never;

export type ReturnsSchema<FunctionSpec_ extends AnyWithProps> =
  FunctionSpec_ extends {
    readonly functionProvenance: {
      readonly _tag: "Confect";
      readonly returns: infer ReturnsSchema_ extends Schema.Codec<any, any>;
    };
  }
    ? ReturnsSchema_
    : never;

export type ErrorSchema<FunctionSpec_ extends AnyWithProps> =
  FunctionSpec_ extends {
    readonly functionProvenance: {
      readonly _tag: "Confect";
      readonly error?: infer ErrorSchema_;
    };
  }
    ? Extract<ErrorSchema_, Schema.Codec<any, any>>
    : never;

export type Args<FunctionSpec_ extends AnyWithProps> = FunctionSpec_ extends {
  readonly functionProvenance: { readonly _tag: "Confect" };
}
  ? ArgsSchema<FunctionSpec_>["Type"]
  : GetFunctionProvenance<FunctionSpec_> extends FunctionProvenance.Convex<
        infer Args_,
        any
      >
    ? Args_
    : never;

export type Returns<FunctionSpec_ extends AnyWithProps> =
  FunctionSpec_ extends {
    readonly functionProvenance: { readonly _tag: "Confect" };
  }
    ? ReturnsSchema<FunctionSpec_>["Type"]
    : GetFunctionProvenance<FunctionSpec_> extends FunctionProvenance.Convex<
          any,
          infer Returns_
        >
      ? Awaited<Returns_>
      : never;

export type EncodedArgs<FunctionSpec_ extends AnyWithProps> =
  FunctionSpec_ extends {
    readonly functionProvenance: { readonly _tag: "Confect" };
  }
    ? ArgsSchema<FunctionSpec_>["Encoded"]
    : GetFunctionProvenance<FunctionSpec_> extends FunctionProvenance.Convex<
          infer Args_,
          any
        >
      ? Args_
      : never;

export type EncodedReturns<FunctionSpec_ extends AnyWithProps> =
  FunctionSpec_ extends {
    readonly functionProvenance: { readonly _tag: "Confect" };
  }
    ? ReturnsSchema<FunctionSpec_>["Encoded"]
    : GetFunctionProvenance<FunctionSpec_> extends FunctionProvenance.Convex<
          any,
          infer Returns_
        >
      ? Returns_
      : never;

export type Error<FunctionSpec_ extends AnyWithProps> =
  ErrorSchema<FunctionSpec_>["Type"];

export type EncodedError<FunctionSpec_ extends AnyWithProps> =
  ErrorSchema<FunctionSpec_>["Encoded"];

export type WithName<
  FunctionSpec_ extends AnyWithProps,
  Name_ extends string,
> = Extract<FunctionSpec_, { readonly name: Name_ }>;

export type WithRuntimeAndFunctionType<
  FunctionSpec_ extends AnyWithProps,
  RuntimeAndFunctionType_ extends RuntimeAndFunctionType.RuntimeAndFunctionType,
> = Extract<
  FunctionSpec_,
  { readonly runtimeAndFunctionType: RuntimeAndFunctionType_ }
>;

export type WithFunctionType<
  FunctionSpec_ extends AnyWithProps,
  FunctionType_ extends FunctionType,
> = Extract<
  FunctionSpec_,
  { readonly runtimeAndFunctionType: { readonly functionType: FunctionType_ } }
>;

export type WithFunctionProvenance<
  FunctionSpec_ extends AnyWithProps,
  FunctionProvenance_ extends FunctionProvenance.FunctionProvenance,
> = Extract<
  FunctionSpec_,
  { readonly functionProvenance: FunctionProvenance_ }
>;

export type WithoutName<
  FunctionSpec_ extends AnyWithProps,
  Name_ extends Name<FunctionSpec_>,
> = Exclude<FunctionSpec_, { readonly name: Name_ }>;

const Proto = {
  [TypeId]: TypeId,

  get middlewareSpecs() {
    return this.middlewareAttachments.map(({ spec }) => spec);
  },

  middleware(
    this: AnyWithProps,
    middlewareSpec: MiddlewareSpec.AnyMiddlewareSpec,
    ...options: ReadonlyArray<unknown>
  ) {
    if (this.functionProvenance._tag === "Convex") {
      throw new Error(
        `Plain Convex function "${this.name}" cannot have middleware`,
      );
    }
    const functionType = this.runtimeAndFunctionType.functionType;
    if (!middlewareSpec.functionTypes[functionType]) {
      throw new Error(
        `Middleware "${middlewareSpec.key}" does not declare function type "${functionType}" of function "${this.name}"`,
      );
    }
    if (
      !("options" in middlewareSpec) &&
      this.middlewareAttachments.some(
        ({ spec }) => spec.key === middlewareSpec.key,
      )
    ) {
      throw new Error(
        `Middleware "${middlewareSpec.key}" is already attached to function "${this.name}"`,
      );
    }

    return Object.assign(Object.create(Proto), {
      runtimeAndFunctionType: this.runtimeAndFunctionType,
      functionVisibility: this.functionVisibility,
      name: this.name,
      ...("description" in this ? { description: this.description } : {}),
      ...("fields" in this ? { fields: this.fields } : {}),
      functionProvenance: this.functionProvenance,
      middlewareAttachments: [
        ...this.middlewareAttachments,
        { spec: middlewareSpec, options: options[0] },
      ],
    });
  },
} satisfies ThisType<AnyWithProps>;

interface Options {
  readonly description?: string;
  readonly name: string;
  readonly args?: () => FunctionProvenance.ArgsFields;
  readonly returns: () => Schema.Codec<any, any>;
  readonly error?: () => Schema.Codec<any, any>;
}

const make = <
  RuntimeAndFunctionType_ extends RuntimeAndFunctionType.RuntimeAndFunctionType,
  FunctionVisibility_ extends FunctionVisibility,
>(
  runtimeAndFunctionType: RuntimeAndFunctionType_,
  functionVisibility: FunctionVisibility_,
) => {
  function makeSpec<
    const Name_ extends string,
    const ArgsFields_ extends FunctionProvenance.ArgsFields,
    Returns_ extends Schema.Codec<any, any>,
    Error_ extends Schema.Codec<any, any> = never,
  >(options: {
    name: Name_;
    description?: never;
    args: () => ArgsFields_;
    returns: () => Returns_;
    error?: () => Error_;
  }): Builder<
    RuntimeAndFunctionType_,
    FunctionVisibility_,
    Name_,
    FunctionProvenance.Confect<ArgsFields_, Returns_, Error_>
  >;
  function makeSpec<
    const Name_ extends string,
    Returns_ extends Schema.Codec<any, any>,
    Error_ extends Schema.Codec<any, any> = never,
  >(options: {
    name: Name_;
    description?: never;
    args?: never;
    returns: () => Returns_;
    error?: () => Error_;
  }): Builder<
    RuntimeAndFunctionType_,
    FunctionVisibility_,
    Name_,
    FunctionProvenance.Confect<{}, Returns_, Error_>
  >;
  function makeSpec<
    const Name_ extends string,
    const ArgsFields_ extends FunctionProvenance.ArgsFields,
    Returns_ extends Schema.Codec<any, any>,
    Error_ extends Schema.Codec<any, any> = never,
  >(options: {
    name: Name_;
    description?: FunctionVisibility_ extends "public" ? string : never;
    args: () => ArgsFields_;
    returns: () => Returns_;
    error?: () => Error_;
  }): DescribedBuilder<
    RuntimeAndFunctionType_,
    FunctionVisibility_,
    Name_,
    FunctionProvenance.Confect<ArgsFields_, Returns_, Error_>
  >;
  function makeSpec<
    const Name_ extends string,
    Returns_ extends Schema.Codec<any, any>,
    Error_ extends Schema.Codec<any, any> = never,
  >(options: {
    name: Name_;
    description?: FunctionVisibility_ extends "public" ? string : never;
    args?: never;
    returns: () => Returns_;
    error?: () => Error_;
  }): DescribedBuilder<
    RuntimeAndFunctionType_,
    FunctionVisibility_,
    Name_,
    FunctionProvenance.Confect<{}, Returns_, Error_>
  >;
  function makeSpec({ name, description, args, returns, error }: Options) {
    validateConfectFunctionIdentifier(name);

    return Object.assign(Object.create(Proto), {
      runtimeAndFunctionType,
      functionVisibility,
      name,
      ...(description === undefined ? {} : { description }),
      functionProvenance:
        args === undefined
          ? FunctionProvenance.Confect(() => ({}), returns, error)
          : FunctionProvenance.Confect(args, returns, error),
      middlewareAttachments: [],
    });
  }

  return makeSpec;
};

/**
 * `Schema.Struct` fields that must not declare `paginationOpts`. Used to reject
 * a user args schema that redeclares the field the paginated constructors add
 * themselves; the check reports at the `args` thunk with an unsatisfiable type
 * when violated.
 */
type ForbidPaginationOpts<
  UserArgsFields extends FunctionProvenance.ArgsFields,
> = "paginationOpts" extends keyof UserArgsFields
  ? { readonly paginationOpts: never }
  : unknown;

interface PaginatedOptions {
  readonly description?: string;
  readonly name: string;
  readonly args?: () => FunctionProvenance.ArgsFields;
  readonly item: () => Schema.Codec<any, any>;
  readonly error?: () => Schema.Codec<any, any>;
}

const makePaginated = <
  RuntimeAndFunctionType_ extends RuntimeAndFunctionType.RuntimeAndFunctionType,
  FunctionVisibility_ extends FunctionVisibility,
>(
  runtimeAndFunctionType: RuntimeAndFunctionType_,
  functionVisibility: FunctionVisibility_,
) => {
  function makeSpec<
    const Name_ extends string,
    const UserArgsFields_ extends FunctionProvenance.ArgsFields,
    Item_ extends Schema.Codec<any, any>,
    Error_ extends Schema.Codec<any, any> = never,
  >(options: {
    name: Name_;
    description?: never;
    args: () => UserArgsFields_ & ForbidPaginationOpts<UserArgsFields_>;
    item: () => Item_;
    error?: () => Error_;
  }): Builder<
    RuntimeAndFunctionType_,
    FunctionVisibility_,
    Name_,
    FunctionProvenance.ConfectPaginated<UserArgsFields_, Item_, Error_>
  >;
  function makeSpec<
    const Name_ extends string,
    Item_ extends Schema.Codec<any, any>,
    Error_ extends Schema.Codec<any, any> = never,
  >(options: {
    name: Name_;
    description?: never;
    args?: never;
    item: () => Item_;
    error?: () => Error_;
  }): Builder<
    RuntimeAndFunctionType_,
    FunctionVisibility_,
    Name_,
    FunctionProvenance.ConfectPaginated<{}, Item_, Error_>
  >;
  function makeSpec<
    const Name_ extends string,
    const UserArgsFields_ extends FunctionProvenance.ArgsFields,
    Item_ extends Schema.Codec<any, any>,
    Error_ extends Schema.Codec<any, any> = never,
  >(options: {
    name: Name_;
    description?: FunctionVisibility_ extends "public" ? string : never;
    args: () => UserArgsFields_ & ForbidPaginationOpts<UserArgsFields_>;
    item: () => Item_;
    error?: () => Error_;
  }): DescribedBuilder<
    RuntimeAndFunctionType_,
    FunctionVisibility_,
    Name_,
    FunctionProvenance.ConfectPaginated<UserArgsFields_, Item_, Error_>
  >;
  function makeSpec<
    const Name_ extends string,
    Item_ extends Schema.Codec<any, any>,
    Error_ extends Schema.Codec<any, any> = never,
  >(options: {
    name: Name_;
    description?: FunctionVisibility_ extends "public" ? string : never;
    args?: never;
    item: () => Item_;
    error?: () => Error_;
  }): DescribedBuilder<
    RuntimeAndFunctionType_,
    FunctionVisibility_,
    Name_,
    FunctionProvenance.ConfectPaginated<{}, Item_, Error_>
  >;
  function makeSpec({
    name,
    description,
    args,
    item,
    error,
  }: PaginatedOptions) {
    validateConfectFunctionIdentifier(name);

    return Object.assign(Object.create(Proto), {
      runtimeAndFunctionType,
      functionVisibility,
      name,
      ...(description === undefined ? {} : { description }),
      functionProvenance:
        args === undefined
          ? FunctionProvenance.ConfectPaginated(() => ({}), item, error)
          : FunctionProvenance.ConfectPaginated(args, item, error),
      middlewareAttachments: [],
    });
  }

  return makeSpec;
};

export const publicQuery = make(RuntimeAndFunctionType.ConvexQuery, "public");
export const internalQuery = make(
  RuntimeAndFunctionType.ConvexQuery,
  "internal",
);
export const publicPaginatedQuery = makePaginated(
  RuntimeAndFunctionType.ConvexQuery,
  "public",
);
export const internalPaginatedQuery = makePaginated(
  RuntimeAndFunctionType.ConvexQuery,
  "internal",
);
export const publicMutation = make(
  RuntimeAndFunctionType.ConvexMutation,
  "public",
);
export const internalMutation = make(
  RuntimeAndFunctionType.ConvexMutation,
  "internal",
);
export const publicAction = make(RuntimeAndFunctionType.ConvexAction, "public");
export const internalAction = make(
  RuntimeAndFunctionType.ConvexAction,
  "internal",
);

export const publicNodeAction = make(
  RuntimeAndFunctionType.NodeAction,
  "public",
);
export const internalNodeAction = make(
  RuntimeAndFunctionType.NodeAction,
  "internal",
);

type OptionlessMiddlewareSpec = MiddlewareSpec.AnyMiddlewareSpec & {
  readonly "~Options": never;
};

/**
 * `never` when a profile middleware does not declare the function type.
 */
type Declared<
  MiddlewareSpecs_ extends MiddlewareSpec.AnyMiddlewareSpec,
  FunctionType_ extends FunctionType,
  Make,
> = [
  MiddlewareSpecs_ extends unknown
    ? FunctionType_ extends MiddlewareSpec.FunctionTypes<MiddlewareSpecs_>
      ? never
      : MiddlewareSpecs_
    : never,
] extends [never]
  ? Make
  : never;

type ExtendedMake<
  RuntimeAndFunctionType_ extends RuntimeAndFunctionType.RuntimeAndFunctionType,
  Fields_ extends Profile.Fields,
  MiddlewareSpecs_ extends MiddlewareSpec.AnyMiddlewareSpec,
> = Declared<
  MiddlewareSpecs_,
  RuntimeAndFunctionType_["functionType"],
  <
    const Name_ extends string,
    const ArgsFields_ extends FunctionProvenance.ArgsFields = {},
    Returns_ extends Schema.Codec<any, any> = never,
    Error_ extends Schema.Codec<any, any> = never,
  >(
    options: {
      readonly name: Name_;
      readonly description?: string;
      readonly args?: () => ArgsFields_;
      readonly returns: () => Returns_;
      readonly error?: () => Error_;
    } & NoInfer<Profile.Apply<Fields_, Name_, ArgsFields_>>,
  ) => ExtendedBuilder<
    RuntimeAndFunctionType_,
    "public",
    Name_,
    FunctionProvenance.Confect<ArgsFields_, Returns_, Error_>,
    MiddlewareSpecs_,
    Profile.Apply<Fields_, Name_, ArgsFields_>
  >
>;

type ExtendedMakePaginated<
  Fields_ extends Profile.Fields,
  MiddlewareSpecs_ extends MiddlewareSpec.AnyMiddlewareSpec,
> = Declared<
  MiddlewareSpecs_,
  "query",
  <
    const Name_ extends string,
    const UserArgsFields_ extends FunctionProvenance.ArgsFields = {},
    Item_ extends Schema.Codec<any, any> = never,
    Error_ extends Schema.Codec<any, any> = never,
  >(
    options: {
      readonly name: Name_;
      readonly description?: string;
      readonly args?: () => UserArgsFields_ &
        ForbidPaginationOpts<UserArgsFields_>;
      readonly item: () => Item_;
      readonly error?: () => Error_;
    } & NoInfer<Profile.Apply<Fields_, Name_, UserArgsFields_>>,
  ) => ExtendedBuilder<
    RuntimeAndFunctionType.ConvexQuery,
    "public",
    Name_,
    FunctionProvenance.ConfectPaginated<UserArgsFields_, Item_, Error_>,
    MiddlewareSpecs_,
    Profile.Apply<Fields_, Name_, UserArgsFields_>
  >
>;

interface ExtendedRuntimes {
  readonly publicQuery: RuntimeAndFunctionType.ConvexQuery;
  readonly publicMutation: RuntimeAndFunctionType.ConvexMutation;
  readonly publicAction: RuntimeAndFunctionType.ConvexAction;
  readonly publicNodeAction: RuntimeAndFunctionType.NodeAction;
}

/**
 * A profile's five public builders and its own `extend`.
 */
export type Extended<
  Fields_ extends Profile.Fields,
  MiddlewareSpecs_ extends MiddlewareSpec.AnyMiddlewareSpec,
> = {
  readonly [Builder_ in keyof ExtendedRuntimes]: ExtendedMake<
    ExtendedRuntimes[Builder_],
    Fields_,
    MiddlewareSpecs_
  >;
} & {
  readonly publicPaginatedQuery: ExtendedMakePaginated<
    Fields_,
    MiddlewareSpecs_
  >;
  /**
   * Require more fields and attach more middleware after this profile's.
   */
  extend<Extension extends Profile.Fields = Profile.NoFields>(): <
    const Middleware_ extends ReadonlyArray<OptionlessMiddlewareSpec>,
  >(config: {
    readonly middleware: Middleware_;
  }) => Extended<
    Profile.Both<Fields_, Extension>,
    MiddlewareSpecs_ | Middleware_[number]
  >;
};

const makeExtended = (
  middleware: ReadonlyArray<MiddlewareSpec.AnyMiddlewareSpec>,
): Extended<any, any> => {
  const extended =
    (makeSpec: (options: never) => object): any =>
    ({
      name,
      description,
      args,
      returns,
      item,
      error,
      ...fields
    }: Record<string, unknown>) =>
      middleware.reduce(
        (spec: any, middlewareSpec) => spec.middleware(middlewareSpec),
        Object.assign(
          makeSpec({ name, description, args, returns, item, error } as never),
          { fields },
        ),
      );

  return {
    publicQuery: extended(publicQuery),
    publicMutation: extended(publicMutation),
    publicAction: extended(publicAction),
    publicNodeAction: extended(publicNodeAction),
    publicPaginatedQuery: extended(publicPaginatedQuery),
    extend: () => (config) =>
      makeExtended([...middleware, ...config.middleware]),
  };
};

/**
 * Public builders whose specs require and keep `Fields_`, with `middleware`.
 */
export const extend =
  <Fields_ extends Profile.Fields = Profile.NoFields>() =>
  <const Middleware_ extends ReadonlyArray<OptionlessMiddlewareSpec>>(config: {
    readonly middleware: Middleware_;
  }) =>
    makeExtended(config.middleware) as Extended<Fields_, Middleware_[number]>;

type MatchingRegisteredFunction<
  RuntimeAndFunctionType_ extends RuntimeAndFunctionType.RuntimeAndFunctionType,
  FunctionVisibility_ extends FunctionVisibility,
> =
  RuntimeAndFunctionType.GetFunctionType<RuntimeAndFunctionType_> extends "query"
    ? RegisteredQuery<FunctionVisibility_, any, any>
    : RuntimeAndFunctionType.GetFunctionType<RuntimeAndFunctionType_> extends "mutation"
      ? RegisteredMutation<FunctionVisibility_, any, any>
      : RuntimeAndFunctionType.GetFunctionType<RuntimeAndFunctionType_> extends "action"
        ? RegisteredAction<FunctionVisibility_, any, any>
        : never;

type ExtractArgs<F> =
  F extends RegisteredQuery<any, infer A extends DefaultFunctionArgs, any>
    ? A
    : F extends RegisteredMutation<
          any,
          infer A extends DefaultFunctionArgs,
          any
        >
      ? A
      : F extends RegisteredAction<
            any,
            infer A extends DefaultFunctionArgs,
            any
          >
        ? A
        : never;

type ExtractReturns<F> =
  F extends RegisteredQuery<any, any, infer R>
    ? R
    : F extends RegisteredMutation<any, any, infer R>
      ? R
      : F extends RegisteredAction<any, any, infer R>
        ? R
        : never;

const makeConvex =
  <
    RuntimeAndFunctionType_ extends
      RuntimeAndFunctionType.RuntimeAndFunctionType,
    FunctionVisibility_ extends FunctionVisibility,
  >(
    runtimeAndFunctionType: RuntimeAndFunctionType_,
    functionVisibility: FunctionVisibility_,
  ) =>
  <
    F extends MatchingRegisteredFunction<
      RuntimeAndFunctionType_,
      FunctionVisibility_
    >,
  >() =>
  <const Name_ extends string>(
    name: Name_,
  ): Builder<
    RuntimeAndFunctionType_,
    FunctionVisibility_,
    Name_,
    FunctionProvenance.Convex<ExtractArgs<F>, ExtractReturns<F>>
  > => {
    validateConfectFunctionIdentifier(name);

    return Object.assign(Object.create(Proto), {
      runtimeAndFunctionType,
      functionVisibility,
      name,
      functionProvenance: FunctionProvenance.Convex<
        ExtractArgs<F>,
        ExtractReturns<F>
      >(),
      middlewareAttachments: [],
    }) as any;
  };

export const convexPublicQuery = makeConvex(
  RuntimeAndFunctionType.ConvexQuery,
  "public",
);
export const convexInternalQuery = makeConvex(
  RuntimeAndFunctionType.ConvexQuery,
  "internal",
);
export const convexPublicMutation = makeConvex(
  RuntimeAndFunctionType.ConvexMutation,
  "public",
);
export const convexInternalMutation = makeConvex(
  RuntimeAndFunctionType.ConvexMutation,
  "internal",
);
export const convexPublicAction = makeConvex(
  RuntimeAndFunctionType.ConvexAction,
  "public",
);
export const convexInternalAction = makeConvex(
  RuntimeAndFunctionType.ConvexAction,
  "internal",
);
export const convexPublicNodeAction = makeConvex(
  RuntimeAndFunctionType.NodeAction,
  "public",
);
export const convexInternalNodeAction = makeConvex(
  RuntimeAndFunctionType.NodeAction,
  "internal",
);
