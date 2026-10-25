import type * as FunctionProvenance from "./FunctionProvenance.js";
import type * as MiddlewareSpec from "./MiddlewareSpec.js";

/**
 * A type-level function from a function's name and args fields to the fields a
 * profile's builders require. Read `this["Name"]` and `this["Args"]` directly
 * in `Type`, passing them to a type alias; a nested object type cannot name
 * `this`.
 */
export interface Fields {
  readonly Name: string;
  // `unknown`, not `ArgsFields`: an index signature here would leak into
  // `keyof this["Args"]`.
  readonly Args: unknown;
  readonly Type: object;
}

export interface NoFields extends Fields {
  readonly Type: {};
}

export type Apply<
  Fields_ extends Fields,
  Name_ extends string,
  Args_,
> = (Fields_ & { readonly Name: Name_; readonly Args: Args_ })["Type"];

/**
 * A base profile's fields and its extension's, for one function.
 */
export interface Both<
  Base extends Fields,
  Extension extends Fields,
> extends Fields {
  readonly Type: Apply<Base, this["Name"], this["Args"]> &
    Apply<Extension, this["Name"], this["Args"]>;
}

/**
 * What an attachment's options factory sees. `args` stays a thunk.
 */
export interface Info<FieldsType> {
  readonly name: string;
  readonly args: () => FunctionProvenance.ArgsFields;
  readonly fields: FieldsType;
}

export interface Attachment<
  MiddlewareSpec_ extends MiddlewareSpec.AnyMiddlewareSpec,
  FieldsType,
> {
  readonly spec: MiddlewareSpec_;
  readonly options: (
    info: Info<FieldsType>,
  ) => MiddlewareSpec.Options<MiddlewareSpec_>;
}

/**
 * Attach a middleware that takes options to every function a profile builds,
 * with options computed from each function's fields.
 */
export const attach = <
  MiddlewareSpec_ extends MiddlewareSpec.AnyMiddlewareSpec,
  FieldsType,
>(
  spec: MiddlewareSpec_,
  options: (
    info: Info<FieldsType>,
  ) => MiddlewareSpec.Options<NoInfer<MiddlewareSpec_>>,
): Attachment<MiddlewareSpec_, FieldsType> => ({ spec, options });
