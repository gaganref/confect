import type * as FunctionSpec from "./FunctionSpec.js";
import type * as MiddlewareSpec from "./MiddlewareSpec.js";

export interface Data<Value = unknown> {
  readonly format: number;
  readonly functions: Readonly<Record<string, Value>>;
}

/**
 * What codegen hands a section's `render`: the exports of each `confect/` file
 * it matched, every registered function with the spec file declaring it, and
 * each mounted component with the specifier of its definition.
 */
export interface GenerateInput {
  readonly modules: ReadonlyArray<{
    readonly relativePath: string;
    readonly exports: Readonly<Record<string, unknown>>;
  }>;
  readonly functions: ReadonlyArray<{
    readonly path: string;
    readonly source: string;
  }>;
  readonly mounts: ReadonlyArray<{
    readonly name: string;
    readonly definition: string;
  }>;
}

export interface Generate {
  readonly file: string;
  match(relativePath: string): boolean;
  render(input: GenerateInput): {
    readonly contents: string;
    readonly errors: ReadonlyArray<string>;
  };
}

/**
 * What codegen hands a section's `summarize`: the `confect/` files its
 * `generate` matched, and each function's description by path.
 */
export interface SummarizeInput<Value = unknown> {
  readonly modules: GenerateInput["modules"];
  readonly functions: Readonly<Record<string, Value>>;
}

export interface ManifestSection<
  Value = unknown,
  Data_ extends { readonly format: number } = Data<Value>,
> {
  readonly owner: string;
  readonly format: number;
  describe(input: {
    readonly path: string;
    readonly spec: FunctionSpec.AnyWithProps;
    readonly middleware: ReadonlyArray<MiddlewareSpec.AnyMiddlewareSpec>;
  }): Value;
  summarize?(input: SummarizeInput<Value>): Data_;
  check?(
    next: Data_,
    previous: unknown,
  ): {
    readonly errors: ReadonlyArray<string>;
    readonly notes: ReadonlyArray<string>;
  };
  readonly generate?: Generate;
}

export type Any = ManifestSection<unknown, { readonly format: number }>;

export interface Entry {
  readonly key: string;
  readonly section: Any;
}
