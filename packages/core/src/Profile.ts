import type * as Schema from "effect/Schema";
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
 * What a profile callback sees. `args` stays a thunk.
 */
export interface Info<FieldsType> {
  readonly name: string;
  readonly description?: string;
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
 * A middleware without options has none to compute and is attached at most
 * once, so it joins a profile's list directly.
 */
type TakesOptions<MiddlewareSpec_ extends MiddlewareSpec.AnyMiddlewareSpec> = [
  MiddlewareSpec.WithoutOptions<MiddlewareSpec_>,
] extends [never]
  ? unknown
  : MiddlewareSpec.AttachmentError<`Middleware "${MiddlewareSpec.Key<MiddlewareSpec_>}" takes no options, so list it without Profile.attach`>;

/**
 * Attach a middleware that takes options to every function a profile builds,
 * with options computed from each function's fields.
 */
export const attach = <
  MiddlewareSpec_ extends MiddlewareSpec.AnyMiddlewareSpec,
  FieldsType,
>(
  spec: MiddlewareSpec_ & TakesOptions<MiddlewareSpec_>,
  options: (
    info: Info<FieldsType>,
  ) => MiddlewareSpec.Options<NoInfer<MiddlewareSpec_>>,
): Attachment<MiddlewareSpec_, FieldsType> => ({ spec, options });

/**
 * A type function for a schema wrapper, applied to each declared codec.
 */
export interface SchemaTransform {
  readonly Input: Schema.Codec<unknown, unknown>;
  readonly Type: Schema.Codec<any, any>;
}

/**
 * Args wrappers transform the declared field map, before Struct composition.
 */
export interface ArgsTransform {
  readonly Input: unknown;
  readonly Type: FunctionProvenance.ArgsFields;
}

export interface Transforms {
  readonly args?: ArgsTransform;
  readonly returns?: SchemaTransform;
  readonly item?: SchemaTransform;
  readonly error?: SchemaTransform;
}

export type Transform<T, Input> = (T & { readonly Input: Input })["Type" &
  keyof T];

/**
 * Error wrappers opt into Schema.Never when no error thunk was declared.
 */
export type Wrappers<T extends Transforms, FieldsType> = {
  readonly [K in keyof T]-?: K extends keyof Transforms
    ? <
        Input extends (K extends "args"
          ? FunctionProvenance.ArgsFields
          : Schema.Codec<any, any>),
      >(
        thunk: () => Input,
        info: Info<FieldsType>,
      ) => () => Transform<T[K], Input>
    : never;
} & { readonly [K in Exclude<keyof Transforms, keyof T>]?: never };

type NonemptyError<T extends Transforms> = T extends {
  readonly error: infer E extends SchemaTransform;
}
  ? [Transform<E, typeof Schema.Never>["Type"]] extends [never]
    ? MiddlewareSpec.AttachmentError<"Profile error wrapper must add an error to Schema.Never">
    : unknown
  : unknown;

export type SchemaConfig<T extends Transforms, FieldsType> = ([
  keyof T,
] extends [never]
  ? { readonly schemas?: never }
  : { readonly schemas: Wrappers<T, FieldsType> }) &
  NonemptyError<T>;
