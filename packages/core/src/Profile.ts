/**
 * A type-level function from a function's name and args fields to the fields a
 * profile's builders require. Read `this["Name"]` and `this["Args"]` directly
 * in `Type`; inside a nested object type, `this` names that object instead.
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
