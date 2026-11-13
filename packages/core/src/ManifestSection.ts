import type * as FunctionSpec from "./FunctionSpec.js";
import type * as MiddlewareSpec from "./MiddlewareSpec.js";

export interface Data<Value = unknown> {
  readonly format: number;
  readonly functions: Readonly<Record<string, Value>>;
}

/**
 * The backend codegen generates: the app, or a component under the name its
 * `defineComponent` gives it.
 */
export type Target =
  | { readonly kind: "app" }
  | { readonly kind: "component"; readonly name: string };

/**
 * What codegen hands a section's `render`: the exports of each `confect/` file
 * it matched, every registered function with the spec file declaring it, each
 * mounted component with the specifier of its definition, every file `match`
 * was offered, the backend it generates and the absolute path of `confect/`.
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
  readonly files: ReadonlyArray<string>;
  readonly target: Target;
  readonly confectDirectory: string;
}

/**
 * What codegen hands a section's `verify.check`: the exports of each `confect/`
 * file `verify.match` selected, each mounted component with the specifier of
 * its definition, and the backend it generates.
 */
export interface VerifyInput {
  readonly modules: GenerateInput["modules"];
  readonly mounts: GenerateInput["mounts"];
  readonly target: Target;
}

export interface Generate {
  readonly file: string;
  match(relativePath: string): boolean;
  render(input: GenerateInput): {
    readonly contents: string;
    readonly errors: ReadonlyArray<string>;
  };
  /**
   * A check codegen runs once every `_generated` file exists, so the files
   * `match` selects may import this section's file or any other. Codegen fails
   * with each string `check` returns.
   */
  readonly verify?: {
    match(relativePath: string): boolean;
    check(input: VerifyInput): ReadonlyArray<string>;
  };
}

/**
 * What codegen hands a section's `summarize`: the `confect/` files its
 * `generate` matched, each function's description by path, and the spec file
 * declaring each function by path, relative to `confect/`.
 */
export interface SummarizeInput<Value = unknown> {
  readonly modules: GenerateInput["modules"];
  readonly functions: Readonly<Record<string, Value>>;
  readonly sources: Readonly<Record<string, string>>;
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
