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
 * What kind of deployment codegen generates for: a backend on this machine, a
 * Convex cloud deployment, a self-hosted backend, or `"unknown"` when the
 * signals are missing or disagree. Treat `"unknown"` as hosted.
 */
export type DeploymentKind = "local" | "cloud" | "self-hosted" | "unknown";

/**
 * What codegen hands a section's `render`: the exports of each `confect/` file
 * it matched, every function and route spec with its visibility, the spec file
 * declaring it and the spec itself, a lookup from a spec to its function, each
 * mounted component with the specifier of its definition, every file `match`
 * was offered, the backend it generates, the kind of deployment it generates
 * for and the absolute path of `confect/`.
 */
export interface GenerateInput {
  readonly modules: ReadonlyArray<{
    readonly relativePath: string;
    readonly exports: Readonly<Record<string, unknown>>;
  }>;
  readonly functions: ReadonlyArray<{
    /**
     * The function's Confect path, such as `inbox/notify:notify`.
     */
    readonly path: string;
    readonly source: string;
    readonly visibility: FunctionSpec.FunctionVisibility;
    /**
     * The function's spec. Codegen bundles the matched files with the spec
     * files in one build, so a spec a matched file reaches through imports that
     * build bundles is this very object. A spec reached any other way, such as
     * through `createRequire` or a package in `node_modules` that re-exports
     * it, is a different object. Map a spec to its function with
     * {@link GenerateInput.functionOf}, which refuses such an object, rather
     * than by comparing it with `spec`.
     *
     * When the files cannot share one build, such as when a matched module
     * imports a file by a path computed at run time, reading `spec` throws why,
     * and the section fails rather than miss a function.
     *
     * `spec` is not enumerable, so serializing a function, or spreading it,
     * leaves it out.
     */
    readonly spec: FunctionSpec.AnyWithProps;
  }>;
  /**
   * The function whose `spec` is `spec`, the very object: the way a section
   * maps a spec a matched file imports to its function. It throws when `spec`
   * is not one codegen loaded, naming the likely causes: an import codegen
   * could not bundle, or a spec no group registers. It also throws when more
   * than one path registers `spec`, such as a spec added to two groups, naming
   * every path, because no one path is its function's. `functions` lists each
   * registration. When the files cannot share one build, it throws why, as
   * reading `spec` does.
   */
  readonly functionOf: (spec: unknown) => GenerateInput["functions"][number];
  readonly mounts: ReadonlyArray<{
    readonly name: string;
    readonly definition: string;
  }>;
  readonly files: ReadonlyArray<string>;
  readonly target: Target;
  readonly deployment: DeploymentKind;
  readonly confectDirectory: string;
}

/**
 * What codegen hands a section's `verify.check`: the exports of each `confect/`
 * file `verify.match` selected, every function and route spec as `render` gets
 * them, with each spec the object those files reach through bundled imports,
 * the lookup from a spec to its function, each mounted component with the
 * specifier of its definition, the backend it generates, the kind of deployment
 * it generates for, and the name of the guard `confect/http.ts` declares, if it
 * declares one.
 */
export interface VerifyInput {
  readonly modules: GenerateInput["modules"];
  readonly functions: GenerateInput["functions"];
  readonly functionOf: GenerateInput["functionOf"];
  readonly mounts: GenerateInput["mounts"];
  readonly target: Target;
  readonly deployment: DeploymentKind;
  readonly guard: string | undefined;
}

export interface Generate {
  /**
   * The name of the file codegen writes directly in `confect/_generated`, a
   * `.ts`, `.json` or `.md` file. A `.ts` file gets a header naming the section
   * and the files `match` accepted, and a `.md` file gets the same as HTML
   * comments. A `.json` file holds exactly what `render` returned. Only a `.ts`
   * file is imported, by registered functions, the HTTP router and
   * `convex/crons.ts`.
   */
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
  /**
   * Set when `file` exports `crons`, a function from Confect's cron jobs to
   * cron jobs. `convex/crons.ts` passes `confect/crons.ts`'s default export
   * through the `crons` of each section that sets this, in the order `App.make`
   * declares them, and deploys the result's `convexCronJobs`. Codegen refuses
   * it on a `.json` or `.md` file.
   */
  readonly wrapsCrons?: boolean;
  /**
   * Set when `file` exports `pushCheck`, a `PushCheck` from
   * `@confect/server/PushCheck`, made at the file's module scope. Every
   * registered function that imports `file` runs it from its `exportArgs`,
   * which Convex calls while it analyzes a push and never while it serves a
   * call. A refusal fails the push, so a deployment keeps serving the last
   * source the check passed. Each evaluation of a module graph runs it at most
   * once. The HTTP router runs it from its `getRoutes` only when no registered
   * function does, as for a file with `importedByFunctions: false` or a backend
   * whose only entry is its router: Convex refuses that push too, but discards
   * the refusal and prints a generic `getRoutes()` error.
   *
   * Use it for a check whose verdict depends only on the deployed source, such
   * as the one `verify` runs, so a push that skips codegen cannot deploy a
   * source `verify` would refuse. Each refusal must name the declaration it
   * refuses, since Convex's message may name no module or function. A backend
   * with neither a registered function nor an HTTP router runs no check at a
   * push. Codegen refuses it on a `.json` or `.md` file.
   *
   * This relies on Convex calling the `@internal` `exportArgs` during analysis.
   * Pin Convex exactly and keep the push contract test.
   */
  readonly pushCheck?: boolean;
  /**
   * Whether every registered function imports `file`, as a side effect before
   * its impl. `true` when unset for a `.ts` file. A `.json` or `.md` file is
   * never imported, and codegen refuses `true` on one. Set it to `false` for a
   * `.ts` file only an entry loads, such as the app's HTTP entry, so it stays
   * out of every function's bundle. Codegen still writes, verifies and claims
   * the file. The HTTP router still imports it, and `convex/crons.ts` still
   * does when `wrapsCrons` is set.
   */
  readonly importedByFunctions?: boolean;
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
 * each public or internal function's description by path, and every group by
 * its path, such as `tasks/tasks`, with its functions. Route specs are in
 * neither, as the test subject calls functions through refs.
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
