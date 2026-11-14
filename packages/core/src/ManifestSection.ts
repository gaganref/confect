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

/**
 * One public or internal function of a group, as `testing` sees it. A
 * `"Convex"` provenance function wraps a raw Convex function, so it carries no
 * Confect codecs.
 */
export interface TestingFunction {
  readonly name: string;
  readonly kind: "query" | "mutation" | "action";
  readonly visibility: "public" | "internal";
  readonly provenance: "Confect" | "Convex";
}

/**
 * What codegen hands a section's `testing`: the files its `generate` matched,
 * each function's description by path, and every group by its path, such as
 * `tasks/tasks`, with its functions.
 */
export interface TestingInput<Value = unknown> {
  readonly modules: GenerateInput["modules"];
  readonly functions: Readonly<Record<string, Value>>;
  readonly groups: ReadonlyArray<{
    readonly path: string;
    readonly functions: ReadonlyArray<TestingFunction>;
  }>;
}

/**
 * A law the schema alone does not state, declared by the section that owns its
 * declaration. `table` and `aggregate` name the app's own tables.
 */
export type DeclaredLaw =
  | { readonly law: "placement"; readonly table: string }
  | {
      readonly law: "aggregate";
      readonly table: string;
      readonly aggregate: string;
    }
  | {
      readonly law: "reference";
      readonly table: string;
      readonly field: string;
      readonly policy: "restrict" | "retain";
    }
  | { readonly law: "unique"; readonly table: string; readonly index: string }
  | {
      readonly law: "fixed";
      readonly table: string;
      readonly fields: ReadonlyArray<string>;
    }
  | { readonly law: "audit"; readonly table: string }
  | { readonly law: "observeEvent" }
  | { readonly law: "atomic" };

/**
 * A proof the backend owes beyond each public group's access proof and the
 * realm proof codegen derives. `ref` is a function path, `group:name`.
 */
export type DeclaredObligation =
  | { readonly kind: "roles" }
  | { readonly kind: "includeReach"; readonly ref: string }
  | { readonly kind: "migration"; readonly ref: string };

/**
 * A provider port: its name, the export in `confect/` holding its input codec,
 * as `<file>#<export>`, and its declared outcomes.
 */
export interface DeclaredPort {
  readonly name: string;
  readonly input: string;
  readonly outcomes: readonly [string, ...Array<string>];
}

/**
 * What a section tells the generated test subject. `owners` maps a group path
 * to the door that hosts it. `open` lists function paths a scope role admits.
 * Codegen refuses a fact that names no such group, public function or table.
 */
export interface TestingFacts {
  readonly owners?: Readonly<Record<string, `door:${string}`>>;
  readonly open?: ReadonlyArray<string>;
  readonly obligations?: ReadonlyArray<DeclaredObligation>;
  readonly laws?: ReadonlyArray<DeclaredLaw>;
  readonly ports?: ReadonlyArray<DeclaredPort>;
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
  /**
   * The facts this section adds to `_generated/testing.ts`'s `TestBackend`.
   * Codegen runs it once the manifest is written, and only for an app.
   */
  testing?(input: TestingInput<Value>): TestingFacts;
}

export type Any = ManifestSection<unknown, { readonly format: number }>;

export interface Entry {
  readonly key: string;
  readonly section: Any;
}
