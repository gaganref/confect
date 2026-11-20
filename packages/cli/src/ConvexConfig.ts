import { parse as parseAST } from "@babel/parser";
import { pipe } from "effect/Function";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as String from "effect/String";
import * as Result from "effect/Result";
import type * as esbuild from "esbuild";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Loading convex's esbuild runs inside an esbuild hook, which has no services, and reads convex's manifest synchronously, as Node's resolution does.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fromBundlerError, type BuildError } from "./BuildError.js";
import * as Bundler from "./Bundler.js";
import { InvalidConvexConfigError } from "./CodegenError.js";
import { quote } from "./Json.js";
import { toPosixPath } from "./utils.js";

export const CONVEX_CONFIG_FILENAME = "convex.config.ts";

/**
 * A component installed on the app via `app.use(...)` in
 * `convex/convex.config.ts`.
 */
export interface InstalledComponent {
  /**
   * The mount name (`app.use`'s `name` option, falling back to the name the
   * component was defined with).
   */
  readonly name: string;
  readonly httpPrefix?: string;
  /**
   * The directory the component's definition lives in, mirroring the Convex
   * runtime's convention (a `componentDefinitionPath` identifies the
   * definition's directory): the import specifier minus its trailing
   * `convex.config` segment when it was bare (e.g. `@convex-dev/workpool`), or
   * the resolved absolute directory when it was relative (a locally-defined
   * component).
   */
  readonly componentDefinitionPath: string;
  /**
   * How the config imported the definition, and the definitions it mounts in
   * turn. None when the definition was not imported through
   * {@link componentConfigPlugin}, or Convex no longer keeps its mounts where
   * {@link importedDefinition} reads them.
   */
  readonly imported: Option.Option<ImportedDefinition>;
}

/**
 * A definition a config imported, as {@link componentConfigPlugin} recorded it,
 * and each definition it mounts, by mount name.
 */
export interface ImportedDefinition {
  readonly import: ComponentImport;
  readonly mounts: ReadonlyArray<{
    readonly name: string;
    readonly definition: ImportedDefinition;
  }>;
}

const COMPONENT_CONFIG_NAMESPACE = "confect-component-config";

/**
 * Where the plugin records how a definition was imported: the specifier as
 * written and the file it resolved to. Codegen reads it to write the import of
 * each mounted component into the generated `convex.config.ts`.
 */
export const COMPONENT_IMPORT_KEY = "~confect/componentImport";

export interface ComponentImport {
  readonly specifier: string;
  readonly path: string;
  /**
   * Whether `path` is the file Convex's deploy bundler resolves the import to
   * ({@link deployedDefinition}). When it is not, the plugin falls back to
   * Node's resolution so codegen still loads the definition, and the test
   * registry refuses the mount with the reason.
   */
  readonly deploy: Deploy;
}

/**
 * What Convex's deploy bundler does with a component definition import: it
 * resolves it to `path`, it finds nothing, or codegen could not load the
 * esbuild the installed `convex` bundles with.
 */
export type Deploy =
  | { readonly kind: "deployed" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "bundlerUnavailable"; readonly reason: string };

const DeploySchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("deployed") }),
  Schema.Struct({
    kind: Schema.Literals(["refused", "bundlerUnavailable"]),
    reason: Schema.String,
  }),
]);

export const componentImportOf = (
  definition: unknown,
): Option.Option<ComponentImport> => {
  if (!Predicate.hasProperty(definition, COMPONENT_IMPORT_KEY)) {
    return Option.none();
  }
  const recorded = definition[COMPONENT_IMPORT_KEY];
  const deploy = Predicate.hasProperty(recorded, "deploy")
    ? Schema.decodeUnknownOption(DeploySchema)(recorded.deploy)
    : Option.none();
  return Predicate.hasProperty(recorded, "specifier") &&
    Predicate.isString(recorded.specifier) &&
    Predicate.hasProperty(recorded, "path") &&
    Predicate.isString(recorded.path) &&
    Option.isSome(deploy)
    ? Option.some({
        specifier: recorded.specifier,
        path: recorded.path,
        deploy: deploy.value,
      })
    : Option.none();
};

/**
 * The mounts `use` recorded on a definition, as `[name, definition, ...]`.
 * Convex's own analysis export reads them there, and no public API lists a
 * mounted definition itself.
 */
const mountsOf = (definition: unknown): Option.Option<ReadonlyArray<unknown>> =>
  Predicate.hasProperty(definition, "_childComponents") &&
  Array.isArray(definition._childComponents)
    ? Option.some(definition._childComponents)
    : Option.none();

const mountedDefinitions = (
  definition: unknown,
): Option.Option<ImportedDefinition["mounts"]> =>
  Option.flatMap(mountsOf(definition), (mounts) =>
    Option.all(
      Array.map(mounts, (mount) =>
        Array.isArray(mount) && Predicate.isString(mount[0])
          ? Option.map(importedDefinition(mount[1]), (child) => ({
              name: mount[0] as string,
              definition: child,
            }))
          : Option.none(),
      ),
    ),
  );

/**
 * How a definition {@link componentConfigPlugin} wrapped was imported, and the
 * definitions it mounts, each wrapped as its import was.
 */
export const importedDefinition = (
  definition: unknown,
): Option.Option<ImportedDefinition> =>
  Option.flatMap(componentImportOf(definition), (recorded) =>
    Option.map(mountedDefinitions(definition), (mounts) => ({
      import: recorded,
      mounts,
    })),
  );

/**
 * Matches the trailing `convex.config` segment of a component-definition import
 * (with or without an extension), e.g. `@convex-dev/workpool/convex.config` or
 * `./waitlist/convex.config.ts`.
 */
const CONVEX_CONFIG_SUFFIX = /[/\\]convex\.config(\.[cm]?[jt]s)?$/;

/**
 * Marks the resolution {@link deployedDefinition} asks esbuild for, so its own
 * hook leaves it to esbuild's resolver.
 */
const DEPLOY_RESOLVE = Symbol.for("@confect/cli/ConvexConfig/deployResolve");

/**
 * The esbuild Convex's deploy bundler runs.
 */
type Esbuild = Pick<typeof esbuild, "build">;

const convexEsbuilds = new Map<string, Result.Result<Esbuild, string>>();

const ConvexManifest = Schema.fromJsonString(
  Schema.Struct({
    dependencies: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.String),
    ),
  }),
);

/**
 * The `package.json` of the `convex` Node finds from `from`, whose CLI would
 * deploy what `from` mounts, and whose pinned esbuild codegen resolves with.
 *
 * @internal
 */
export const convexManifest = (from: string): Option.Option<string> =>
  Option.liftThrowable(() =>
    createRequire(from).resolve("convex/package.json"),
  )();

/**
 * The esbuild the installed `convex` bundles with, loaded from `convex`'s own
 * package as its CLI loads it, rather than the CLI's own: `convex` 1.49 pins
 * esbuild 0.27.0, and a newer esbuild resolves imports a deploy does not, such
 * as a `#/` subpath import. `convex` is the one Node finds from `from`, the
 * file whose bundle reads the definitions. Failure holds why it cannot be
 * loaded.
 *
 * @internal
 */
export const convexEsbuild = (from: string): Result.Result<Esbuild, string> => {
  const manifest = convexManifest(from);
  if (Option.isNone(manifest)) {
    return Result.fail(`Node finds no convex package from ${quote(from)}`);
  }
  const cached = convexEsbuilds.get(manifest.value);
  if (cached !== undefined) return cached;
  const directory = quote(
    pipe(manifest.value, String.slice(0, -"/package.json".length)),
  );
  // Node's lookup walks up past convex's own directory, so a missing esbuild
  // of convex's could find another; an exact pin tells them apart.
  const pinned = pipe(
    Option.liftThrowable(() => readFileSync(manifest.value, "utf8"))(),
    Option.flatMap(Schema.decodeUnknownOption(ConvexManifest)),
    Option.flatMap(({ dependencies }) =>
      Option.fromNullishOr(dependencies?.["esbuild"]),
    ),
    Option.filter((version) => /^\d+\.\d+\.\d+$/.test(version)),
  );
  const loaded = pipe(
    Option.liftThrowable(
      () =>
        createRequire(manifest.value)("esbuild") as Partial<
          Esbuild & { readonly version: string }
        >,
    )(),
    Option.filter((candidate) => Predicate.isFunction(candidate.build)),
    Option.match({
      onNone: () =>
        Result.fail(
          `the convex package at ${directory} cannot load the esbuild it bundles with`,
        ),
      onSome: (candidate) =>
        Option.isSome(pinned) && candidate.version !== pinned.value
          ? Result.fail(
              `the convex package at ${directory} pins esbuild ${pinned.value}, and Node finds esbuild ${candidate.version ?? "(unknown)"} from it`,
            )
          : Result.succeed(candidate as Esbuild),
    }),
  );
  convexEsbuilds.set(manifest.value, loaded);
  return loaded;
};

/**
 * The deploy bundler's esbuild options for definitions: the browser platform
 * with the `convex` and `module` conditions
 * (`src/cli/lib/components/definition/bundle.ts:236-273`). A deploy passes
 * `liveComponentSources: false` (`src/cli/deploy.ts:351`), so the
 * `@convex-dev/component-source` condition that `convex dev
 * --live-component-sources` adds is not among them.
 */
const deployOptions = {
  bundle: true,
  write: false,
  logLevel: "silent",
  platform: "browser",
  format: "esm",
  conditions: ["convex", "module"],
} as const satisfies esbuild.BuildOptions;

/**
 * The first candidate esbuild resolves for a component definition import, as
 * the deploy bundler's component plugin tries them: the import as written, then
 * `.ts` for a `.js` import, then `.js` and `.ts` for an import with neither
 * (`bundle.ts:158-185`).
 */
const resolveCandidates = Effect.fnUntraced(function* (
  build: esbuild.PluginBuild,
  args: esbuild.OnResolveArgs,
) {
  const extension = Option.getOrUndefined(
    Option.flatMap(String.match(/\.[^./]+$/)(args.path), Array.head),
  );
  const candidates = [
    args.path,
    ...(extension === ".js"
      ? [pipe(args.path, String.slice(0, -".js".length)) + ".ts"]
      : []),
    ...(extension !== ".js" && extension !== ".ts"
      ? [`${args.path}.js`, `${args.path}.ts`]
      : []),
  ];
  for (const candidate of candidates) {
    const result = yield* Effect.promise(() =>
      build.resolve(candidate, {
        kind: args.kind,
        resolveDir: args.resolveDir,
        pluginData: DEPLOY_RESOLVE,
      }),
    );
    if (result.errors.length === 0 && result.path !== "")
      return Option.some(result.path);
  }
  return Option.none<string>();
});

/**
 * Bundle `stdin` with the deploy's options and give what each component
 * definition import it reaches resolves to, in the order esbuild asks, marking
 * each external, as the deploy bundler's discovery pass records them. None when
 * the bundle fails.
 */
const reachConfigs = (
  bundler: Esbuild,
  stdin: esbuild.StdinOptions,
): Effect.Effect<Option.Option<ReadonlyArray<Option.Option<string>>>> => {
  const reached: Array<Option.Option<string>> = [];
  return Effect.promise(() =>
    bundler
      .build({
        ...deployOptions,
        stdin,
        plugins: [
          {
            name: "confect:convex-deploy-resolve",
            setup(build) {
              // The deploy plugin's filter (`bundle.ts:128`).
              build.onResolve({ filter: /.*convex.config.*/ }, (args) =>
                args.pluginData === DEPLOY_RESOLVE ||
                args.kind === "entry-point"
                  ? undefined
                  : resolveCandidates(build, args).pipe(
                      Effect.map((resolved) => {
                        reached.push(resolved);
                        return { path: args.path, external: true };
                      }),
                      Effect.runPromise,
                    ),
              );
            },
          },
        ],
      })
      // A deploy that cannot bundle the import fails as no resolution does.
      .then(
        () => Option.some(reached),
        () => Option.none(),
      ),
  );
};

/**
 * The file Convex's deploy bundler resolves a component definition import to,
 * from the directory of the file that imports it, with the esbuild the
 * installed `convex` bundles with ({@link convexEsbuild}) and the candidates
 * and options its discovery uses (`bundle.ts:158-185`). Codegen evaluates that
 * file. Whether a packaged definition is a layout the test registry reads is
 * codegen's question, not this one's: it does not mirror the rest of Convex's
 * resolution.
 *
 * @internal
 */
export const deployedDefinition = (
  bundler: Result.Result<Esbuild, string>,
  specifier: string,
  resolveDir: string,
): Effect.Effect<{
  readonly deploy: Deploy;
  readonly path: Option.Option<string>;
}> =>
  Effect.gen(function* () {
    if (Result.isFailure(bundler)) {
      return {
        deploy: { kind: "bundlerUnavailable", reason: bundler.failure },
        path: Option.none(),
      } as const;
    }
    const reached = yield* reachConfigs(bundler.success, {
      contents: `import ${quote(specifier)};`,
      resolveDir,
      loader: "js",
    });
    const resolved = pipe(reached, Option.flatMap(Array.head), Option.flatten);
    return Option.isNone(resolved)
      ? ({
          deploy: {
            kind: "refused",
            reason: `Convex's deploy bundler, which resolves on the browser platform under the convex and module conditions, finds no ${quote(specifier)}.`,
          },
          path: Option.none(),
        } as const)
      : ({ deploy: { kind: "deployed" }, path: resolved } as const);
  });

/**
 * A module a component definition imports, read from its source: the specifier,
 * and whether a dynamic `import()`, a `require()` or a TypeScript `import x =
 * require()` names it.
 */
export interface ConfigImport {
  readonly specifier: string;
  readonly dynamic: boolean;
}

type AstNode = Readonly<Record<string, unknown>> & { readonly type: string };

const isNode = (value: unknown): value is AstNode =>
  Predicate.hasProperty(value, "type") && Predicate.isString(value.type);

const literalOf = (value: unknown): string =>
  Predicate.hasProperty(value, "value") && Predicate.isString(value.value)
    ? value.value
    : "(computed)";

/**
 * Keys that hold no runtime code: source positions, comments, and the
 * TypeScript type positions, which compiling erases, an `import("x")` type
 * among them.
 */
const erasedKeys = new Set([
  "loc",
  "start",
  "end",
  "range",
  "extra",
  "comments",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "typeAnnotation",
  "typeParameters",
  "typeArguments",
  "returnType",
  "superTypeParameters",
  "superTypeArguments",
  "implements",
  "predicate",
]);

/**
 * TypeScript declarations that hold only types, which compiling erases whole.
 */
const typeDeclarations = new Set([
  "TSInterfaceDeclaration",
  "TSTypeAliasDeclaration",
  "TSDeclareFunction",
  "TSDeclareMethod",
  "TSIndexSignature",
  "TSNamespaceExportDeclaration",
]);

/**
 * The node types a component definition may hold that create no module edge
 * themselves: JavaScript's statements, expressions, patterns, classes and JSX,
 * and TypeScript's runtime wrappers. A node type outside this set, and outside
 * the forms {@link configImports} classifies, is one the walker does not know,
 * so the definition is not read.
 */
const edgelessNodes = new Set([
  "File",
  "Program",
  "Directive",
  "DirectiveLiteral",
  "InterpreterDirective",
  "BlockStatement",
  "EmptyStatement",
  "ExpressionStatement",
  "IfStatement",
  "LabeledStatement",
  "BreakStatement",
  "ContinueStatement",
  "SwitchStatement",
  "SwitchCase",
  "ReturnStatement",
  "ThrowStatement",
  "TryStatement",
  "CatchClause",
  "WhileStatement",
  "DoWhileStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "DebuggerStatement",
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "VariableDeclaration",
  "VariableDeclarator",
  "ClassDeclaration",
  "ClassExpression",
  "ClassBody",
  "ClassMethod",
  "ClassPrivateMethod",
  "ClassProperty",
  "ClassPrivateProperty",
  "ClassAccessorProperty",
  "StaticBlock",
  "PrivateName",
  "Decorator",
  "Super",
  "ThisExpression",
  "YieldExpression",
  "AwaitExpression",
  "ArrayExpression",
  "ObjectExpression",
  "ObjectProperty",
  "ObjectMethod",
  "UnaryExpression",
  "UpdateExpression",
  "BinaryExpression",
  "AssignmentExpression",
  "LogicalExpression",
  "MemberExpression",
  "OptionalMemberExpression",
  "CallExpression",
  "OptionalCallExpression",
  "NewExpression",
  "ConditionalExpression",
  "SequenceExpression",
  "ParenthesizedExpression",
  "TemplateLiteral",
  "TaggedTemplateExpression",
  "TemplateElement",
  "Identifier",
  "StringLiteral",
  "NumericLiteral",
  "BigIntLiteral",
  "BooleanLiteral",
  "NullLiteral",
  "RegExpLiteral",
  "SpreadElement",
  "RestElement",
  "ObjectPattern",
  "ArrayPattern",
  "AssignmentPattern",
  "ImportSpecifier",
  "ImportDefaultSpecifier",
  "ImportNamespaceSpecifier",
  "ImportAttribute",
  "ExportSpecifier",
  "ExportNamespaceSpecifier",
  "ExportDefaultSpecifier",
  "ExportDefaultDeclaration",
  "JSXElement",
  "JSXOpeningElement",
  "JSXClosingElement",
  "JSXAttribute",
  "JSXSpreadAttribute",
  "JSXIdentifier",
  "JSXMemberExpression",
  "JSXNamespacedName",
  "JSXText",
  "JSXExpressionContainer",
  "JSXSpreadChild",
  "JSXEmptyExpression",
  "JSXFragment",
  "JSXOpeningFragment",
  "JSXClosingFragment",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
  "TSEnumDeclaration",
  "TSEnumMember",
  "TSModuleDeclaration",
  "TSModuleBlock",
  "TSParameterProperty",
  "TSExportAssignment",
  "TSQualifiedName",
]);

const typeOnly = (node: AstNode) =>
  node["importKind"] === "type" ||
  node["exportKind"] === "type" ||
  (Array.isArray(node["specifiers"]) &&
    Array.isArrayNonEmpty(node["specifiers"]) &&
    Array.every(
      node["specifiers"] as ReadonlyArray<Record<string, unknown>>,
      (specifier) =>
        specifier["importKind"] === "type" ||
        specifier["exportKind"] === "type",
    ));

/**
 * The names CommonJS gives a module, through which code can load another.
 */
const moduleScopeNames = new Set(["require", "module", "exports"]);

const isIdentifier = (value: unknown): boolean =>
  isNode(value) && value.type === "Identifier";

/**
 * The keys of `node` that hold a name, not a reference: a property's key or
 * member's property when not computed, a binding's own name, a label, an
 * import's or export's external name.
 */
const nonReferenceKeys = (node: AstNode): ReadonlySet<string> => {
  const computed = node["computed"] === true;
  switch (node.type) {
    case "MemberExpression":
    case "OptionalMemberExpression":
      return new Set(computed ? [] : ["property"]);
    case "ObjectProperty":
    case "ObjectMethod":
    case "ClassProperty":
    case "ClassMethod":
    case "ClassPrivateProperty":
    case "ClassPrivateMethod":
    case "ClassAccessorProperty":
      return new Set(computed ? [] : ["key"]);
    case "ImportSpecifier":
    case "ImportDefaultSpecifier":
    case "ImportNamespaceSpecifier":
      return new Set(["imported", "local"]);
    case "ExportSpecifier":
    case "ExportNamespaceSpecifier":
    case "ExportDefaultSpecifier":
      return new Set(["exported"]);
    case "VariableDeclarator":
      return new Set(isIdentifier(node["id"]) ? ["id"] : []);
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ClassDeclaration":
    case "ClassExpression":
    case "TSEnumDeclaration":
    case "TSEnumMember":
    case "TSModuleDeclaration":
      return new Set(["id"]);
    case "CatchClause":
      return new Set(isIdentifier(node["param"]) ? ["param"] : []);
    case "TSParameterProperty":
      return new Set(isIdentifier(node["parameter"]) ? ["parameter"] : []);
    case "LabeledStatement":
    case "BreakStatement":
    case "ContinueStatement":
      return new Set(["label"]);
    default:
      return new Set();
  }
};

/**
 * The names a program binds at module level at run time, which a reference
 * anywhere in it resolves to: its value imports, variables, functions, classes
 * and enums. TypeScript erases the rest, so none of it binds a name a deploy's
 * code can reach: a `declare` declaration of any kind, a type-only import or
 * import specifier, an interface or type alias, and a namespace, whether
 * `declare module`, `declare global` or a plain one, which binds only when it
 * holds values and is left out either way, so a reference it would shadow stays
 * free. A binding in an inner scope is not among them either, so a reference
 * the walker cannot place stays free.
 */
const moduleBindings = (program: unknown): ReadonlySet<string> => {
  const names = new Set<string>();
  const addPattern = (pattern: unknown): void => {
    if (!isNode(pattern)) return;
    switch (pattern.type) {
      case "Identifier":
        if (Predicate.isString(pattern["name"])) names.add(pattern["name"]);
        return;
      case "ObjectPattern":
        for (const property of (pattern[
          "properties"
        ] as ReadonlyArray<unknown>) ?? [])
          addPattern(
            isNode(property) && property.type === "RestElement"
              ? property["argument"]
              : isNode(property)
                ? property["value"]
                : undefined,
          );
        return;
      case "ArrayPattern":
        for (const element of (pattern["elements"] as ReadonlyArray<unknown>) ??
          [])
          addPattern(element);
        return;
      case "AssignmentPattern":
        addPattern(pattern["left"]);
        return;
      case "RestElement":
        addPattern(pattern["argument"]);
        return;
    }
  };
  const addStatement = (statement: unknown): void => {
    if (!isNode(statement) || statement["declare"] === true) return;
    switch (statement.type) {
      case "ImportDeclaration":
        if (statement["importKind"] === "type") return;
        for (const specifier of (statement[
          "specifiers"
        ] as ReadonlyArray<unknown>) ?? [])
          if (isNode(specifier) && specifier["importKind"] !== "type")
            addPattern(specifier["local"]);
        return;
      case "VariableDeclaration":
        for (const declarator of (statement[
          "declarations"
        ] as ReadonlyArray<unknown>) ?? [])
          if (isNode(declarator)) addPattern(declarator["id"]);
        return;
      case "FunctionDeclaration":
      case "ClassDeclaration":
      case "TSEnumDeclaration":
        addPattern(statement["id"]);
        return;
      case "ExportNamedDeclaration":
      case "ExportDefaultDeclaration":
        addStatement(statement["declaration"]);
        return;
    }
  };
  const body = isNode(program) ? program["body"] : undefined;
  if (Array.isArray(body))
    for (const statement of body) addStatement(statement);
  return names;
};

/**
 * The module edges in a parsed component definition, failing closed: `None`
 * when the walker meets a node it does not know. Each form that can create a
 * runtime module edge is classified. An `import` or `export ... from`, unless
 * it names only types; a dynamic `import()`; a `require` anywhere; a TypeScript
 * `import x = require()` unless it is `import type`; and `import.meta`. Type
 * positions, an `import("x")` type among them, are erased.
 *
 * @internal
 */
export const programImports = (
  program: unknown,
): Option.Option<ReadonlyArray<ConfigImport>> => {
  const found: Array<ConfigImport> = [];
  let known = true;
  const visit = (value: unknown): void => {
    if (!known) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isNode(value)) return;
    const node = value;
    switch (node.type) {
      case "ImportDeclaration":
      case "ExportAllDeclaration":
      case "ExportNamedDeclaration":
        if (node["source"] !== null && node["source"] !== undefined) {
          if (typeOnly(node)) return;
          found.push({ specifier: literalOf(node["source"]), dynamic: false });
        }
        break;
      case "ImportExpression":
        found.push({ specifier: literalOf(node["source"]), dynamic: true });
        break;
      case "CallExpression": {
        const callee = node["callee"];
        if (
          isNode(callee) &&
          (callee.type === "Import" ||
            (callee.type === "Identifier" && callee["name"] === "require"))
        ) {
          const args = node["arguments"];
          found.push({
            specifier: literalOf(Array.isArray(args) ? args[0] : undefined),
            dynamic: true,
          });
          visit(args);
          return;
        }
        break;
      }
      case "TSImportEqualsDeclaration": {
        if (node["importKind"] === "type") return;
        // A runtime import-equals is an edge, a `require()` one or an alias:
        // `import loader = require` hides a `require` call behind a name.
        const reference = node["moduleReference"];
        found.push({
          specifier:
            isNode(reference) && reference.type === "TSExternalModuleReference"
              ? literalOf(reference["expression"])
              : "import-equals alias",
          dynamic: true,
        });
        return;
      }
      case "TSExternalModuleReference":
        found.push({
          specifier: literalOf(node["expression"]),
          dynamic: true,
        });
        return;
      case "MetaProperty":
        if (isNode(node["meta"]) && node["meta"]["name"] === "import")
          found.push({ specifier: "import.meta", dynamic: true });
        return;
      case "Identifier": {
        // A free `require`, `module` or `exports`, read anywhere, may load a
        // module at run time; only a module-level binding of the name makes
        // it local.
        const name = node["name"];
        if (
          Predicate.isString(name) &&
          moduleScopeNames.has(name) &&
          !bound.has(name)
        )
          found.push({ specifier: name, dynamic: true });
        return;
      }
      default:
        if (typeDeclarations.has(node.type)) return;
        if (!edgelessNodes.has(node.type)) {
          known = false;
          return;
        }
    }
    const skipped = nonReferenceKeys(node);
    for (const [key, child] of Record.toEntries(node)) {
      if (erasedKeys.has(key) || skipped.has(key)) continue;
      if (key === "params" && Array.isArray(child)) {
        // A parameter's own name is a binding, not a reference.
        visit(Array.filter(child, (param) => !isIdentifier(param)));
        continue;
      }
      if (Predicate.isObjectOrArray(child)) visit(child);
    }
  };
  const bound = moduleBindings(program);
  visit(program);
  return known ? Option.some(found) : Option.none();
};

/**
 * The modules `source`, a component definition's text, imports, read with the
 * parser and options the test kernel reads `"use node"` with, without running
 * or bundling it ({@link programImports}). `None` when the source does not
 * parse, or holds a node the walker does not know.
 *
 * @internal
 */
export const configImports = (
  source: string,
): Option.Option<ReadonlyArray<ConfigImport>> =>
  pipe(
    Option.liftThrowable(() =>
      parseAST(source, {
        sourceType: "module",
        plugins: ["jsx", "typescript"],
      }),
    )(),
    Option.flatMap((file) => programImports(file.program)),
  );

/**
 * Whether a supported component definition may import `entry`: a static import
 * of `convex` itself (`convex/server`, `convex/values`), or of another
 * component's `convex.config`, which codegen checks under the same layout rules
 * as its own mount. Anything else, a helper or another package, may resolve
 * under Convex's conditions to code Node never runs, so it may change the tree
 * a definition mounts.
 *
 * @internal
 */
export const isSupportedConfigImport = (entry: ConfigImport): boolean =>
  !entry.dynamic &&
  (pipe(entry.specifier, String.startsWith("convex/")) ||
    /convex\.config/.test(entry.specifier));

/**
 * Resolve the same config spellings that Convex accepts, for configs and test
 * kits.
 *
 * @internal
 */
export const resolveDefinition = (
  specifier: string,
  importer: string,
  path: Path.Path,
): Option.Option<string> => {
  const extension = path.extname(specifier);
  const candidates = [
    specifier,
    ...(extension === ".js"
      ? [pipe(specifier, String.slice(0, -3)) + ".ts"]
      : []),
    ...(extension !== ".js" && extension !== ".ts"
      ? [specifier + ".js", specifier + ".ts"]
      : []),
  ];
  return Option.firstSomeOf(
    Array.map(candidates, (candidate) =>
      Bundler.resolveModule(candidate, importer),
    ),
  );
};

/**
 * `convex/server`'s `app.use(definition)` rejects any definition object that
 * lacks a string `componentDefinitionPath` ("This code only works in Convex
 * runtime"): that property is normally stamped on by the Convex backend's
 * module system when it evaluates a definition bundle. To evaluate
 * `convex.config.ts` in plain Node, this plugin intercepts every non-entry
 * import of a `convex.config` module (mirroring the Convex CLI's own
 * `componentPlugin`) and swaps in a virtual wrapper that re-exports the real
 * definition with `componentDefinitionPath` and `defaultName` filled in—the
 * exact shape of Convex's `ImportedComponentDefinition`.
 *
 * @internal
 */
export const componentConfigPlugin = (path: Path.Path): esbuild.Plugin => ({
  name: "confect:component-config",
  setup(build) {
    // The convex installed beside the file whose bundle reads the definitions,
    // whose CLI would deploy them. A shared build names its entries as
    // `{ in, out }`.
    const first = Array.isArray(build.initialOptions.entryPoints)
      ? build.initialOptions.entryPoints[0]
      : undefined;
    const entry = Predicate.isObject(first) ? first.in : first;
    const bundler = convexEsbuild(
      Predicate.isString(entry)
        ? path.resolve(entry)
        : path.join(process.cwd(), "_"),
    );
    build.onResolve({ filter: /convex\.config/ }, (args) => {
      // The app's own `convex.config.ts` is the entry point; only imports of
      // *component* definitions get wrapped.
      if (args.kind === "entry-point") return undefined;

      // Claim a wrapper's import of the real definition into the file
      // namespace: bundled, the definition's own nested `convex.config`
      // imports re-enter this plugin and get stamped; externalized, an npm
      // definition would be evaluated natively by Node, where its top-level
      // `component.use(...)` of unstamped nested definitions throws.
      if (args.namespace === COMPONENT_CONFIG_NAMESPACE) {
        return { path: args.path };
      }
      if (args.namespace !== "file" && args.namespace !== "") return undefined;

      const importer =
        args.importer !== "" ? args.importer : path.join(args.resolveDir, "_");

      // The definition Convex deploys, so codegen evaluates the same tree.
      // Component definitions are conventionally imported extensionless
      // (`.../convex.config`), which npm `exports` maps resolve but plain
      // file resolution may not, so both probe the same candidates.
      return deployedDefinition(bundler, args.path, args.resolveDir).pipe(
        Effect.map(({ deploy, path: deployed }) =>
          pipe(
            Option.orElse(deployed, () =>
              resolveDefinition(args.path, importer, path),
            ),
            Option.match({
              onNone: () => undefined,
              onSome: (resolved) => ({
                path: resolved,
                namespace: COMPONENT_CONFIG_NAMESPACE,
                pluginData: { specifier: args.path, deploy },
              }),
            }),
          ),
        ),
        Effect.runPromise,
      );
    });

    build.onLoad(
      { filter: /.*/, namespace: COMPONENT_CONFIG_NAMESPACE },
      (args) =>
        Effect.gen(function* () {
          const { specifier, deploy } = args.pluginData as {
            specifier: string;
            deploy: Deploy;
          };
          // The injected path is the definition's *directory*, matching the
          // Convex runtime's convention—so even if a future convex version
          // stops reading `defaultName`, `app.use`'s last-resort fallback
          // (`componentDefinitionPath.split("/").pop()`) still yields the
          // conventional component name rather than `convex.config`. Convex's
          // codegen doesn't trust relative specifiers as identifiers (the
          // importer's location is lost after bundling), so those are recorded
          // as the resolved absolute directory; bare specifiers keep their
          // package prefix so the generated type import stays a package
          // specifier.
          const isBareSpecifier =
            !String.startsWith(".")(specifier) && !path.isAbsolute(specifier);
          const componentDefinitionPath = isBareSpecifier
            ? String.replace(CONVEX_CONFIG_SUFFIX, "")(specifier)
            : path.dirname(args.path);
          const JsonString = Schema.fromJsonString(Schema.String);
          const modulePath = yield* Schema.encodeEffect(JsonString)(args.path);
          const definitionPath = yield* Schema.encodeEffect(JsonString)(
            componentDefinitionPath,
          );

          // The real module is imported (not inlined) so any nested
          // `convex.config` imports resolve from the definition's own file
          // rather than from this virtual wrapper. `defaultName` comes from
          // `defineComponent(name)`'s `_name`, keeping `app.use`'s name
          // resolution identical to the Convex runtime's.
          return {
            loader: "js",
            resolveDir: path.dirname(args.path),
            contents: Array.join(
              [
                `import real from ${modulePath};`,
                // oxlint-disable-next-line effecttsgo/prefer-schema-over-json, effecttsgo/global-json-in-effect -- Emit an escaped JavaScript string and object literal into the virtual module, not a JSON payload.
                `export default { ...real, componentDefinitionPath: ${definitionPath}, defaultName: real._name, [${JSON.stringify(COMPONENT_IMPORT_KEY)}]: ${JSON.stringify({ specifier, path: args.path, deploy })} };`,
              ],
              "\n",
            ),
          } satisfies esbuild.OnLoadResult;
        }).pipe(Effect.runPromise),
    );
  },
});

/**
 * The subset of `app.export()` (Convex's `AppDefinitionAnalysis`) that the
 * registry needs: each installed component's mount name and the
 * `componentDefinitionPath` injected by {@link componentConfigPlugin}.
 */
const AppDefinitionAnalysis = Schema.Struct({
  httpMounts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  childComponents: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      path: Schema.String,
    }),
  ),
});

const byName = Order.mapInput(
  Order.String,
  (component: InstalledComponent) => component.name,
);

/**
 * Convex component names must be alphanumeric plus underscores (see
 * `defineComponent`'s docs). Beyond rejecting genuinely invalid names, this is
 * a drift tripwire: if a future convex version stopped resolving names the way
 * we rely on (e.g. `defaultName` disappearing), the fallback name would be a
 * path segment like `convex.config`—caught here as a clear error instead of
 * silently emitting a broken registry.
 */
const VALID_COMPONENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Bundle and evaluate `convex/convex.config.ts` and list the components
 * installed on the app, in mount-name order. `displayPath` is used in error
 * messages (mirroring how impl/spec bundling reports relative paths).
 */
export const discoverInstalledComponents = Effect.fn(
  "ConvexConfig.discoverInstalledComponents",
)(function* (
  convexConfigPath: string,
  displayPath: string,
  kind: "app" | "component" = "app",
): Effect.fn.Return<
  ReadonlyArray<InstalledComponent>,
  BuildError | InvalidConvexConfigError,
  Path.Path | FileSystem.FileSystem
> {
  const path = yield* Path.Path;

  const { module } = yield* Bundler.bundle(convexConfigPath, {
    plugins: [componentConfigPlugin(path)],
  }).pipe(Effect.mapError((error) => fromBundlerError(displayPath, error)));

  const app = module.default as
    | { _isRoot?: unknown; export?: unknown }
    | null
    | undefined;

  const definition = Match.value(kind).pipe(
    Match.when("app", () => ({ isRoot: true, constructor: "defineApp" })),
    Match.when("component", () => ({
      isRoot: false,
      constructor: "defineComponent",
    })),
    Match.exhaustive,
  );

  if (
    app === null ||
    typeof app !== "object" ||
    app._isRoot !== definition.isRoot ||
    typeof app.export !== "function"
  ) {
    return yield* InvalidConvexConfigError.make({
      configPath: displayPath,
      reason: `it must default-export the ${kind} definition created by \`${definition.constructor}()\`.`,
    });
  }

  const analysis = yield* Effect.try({
    try: () => (app.export as () => unknown)(),
    catch: (cause) =>
      InvalidConvexConfigError.make({
        configPath: displayPath,
        reason: `exporting the app definition threw: ${globalThis.String(cause)}.`,
      }),
  });

  const decoded = yield* Schema.decodeUnknownEffect(AppDefinitionAnalysis)(
    analysis,
  ).pipe(
    Effect.mapError((cause) =>
      InvalidConvexConfigError.make({
        configPath: displayPath,
        reason: `the app definition's installed components could not be read: ${cause.message}.`,
      }),
    ),
  );

  const components = pipe(
    decoded.childComponents,
    Array.map(({ name, path: componentDefinitionPath }): InstalledComponent => {
      const httpPrefix = Option.getOrUndefined(
        Array.findFirst(
          Record.toEntries(decoded.httpMounts ?? {}),
          ([, reference]) => reference === `_reference/childComponent/${name}`,
        ),
      )?.[0];
      return {
        name,
        componentDefinitionPath,
        imported: Option.flatMap(mountsOf(app), (mounts) =>
          Option.flatMap(
            Array.findFirst(
              mounts,
              (mount) => Array.isArray(mount) && mount[0] === name,
            ),
            (mount) => importedDefinition((mount as ReadonlyArray<unknown>)[1]),
          ),
        ),
        ...(httpPrefix === undefined
          ? {}
          : { httpPrefix: pipe(httpPrefix, String.replace(/\/$/, "")) }),
      };
    }),
    Array.sort(byName),
  );

  const invalidNames = pipe(
    components,
    Array.map(({ name }) => name),
    Array.filter((name) =>
      Option.isNone(String.match(VALID_COMPONENT_NAME)(name)),
    ),
  );
  if (Array.isArrayNonEmpty(invalidNames)) {
    return yield* InvalidConvexConfigError.make({
      configPath: displayPath,
      reason: `component names must be alphanumeric plus underscores, but got: ${pipe(
        invalidNames,
        Array.map((name) => `"${name}"`),
        Array.join(", "),
      )}. Pass a valid \`name\` to \`app.use\`.`,
    });
  }

  const duplicateNames = pipe(
    components,
    Array.groupBy(({ name }) => name),
    Record.toEntries,
    Array.filter(([, group]) => group.length > 1),
    Array.map(([name]) => name),
  );
  if (Array.isArrayNonEmpty(duplicateNames)) {
    return yield* InvalidConvexConfigError.make({
      configPath: displayPath,
      reason: `multiple components are installed under the same name (${Array.join(duplicateNames, ", ")}); pass a unique \`name\` to \`app.use\` for each.`,
    });
  }

  return components;
});

/**
 * The name passed to `defineComponent`, independent of the package's ID scope.
 */
export const componentName = Effect.fnUntraced(function* (configPath: string) {
  const path = yield* Path.Path;
  const { module } = yield* Bundler.bundle(configPath, {
    plugins: [componentConfigPlugin(path)],
  }).pipe(
    Effect.mapError((error) =>
      fromBundlerError("convex/convex.config.ts", error),
    ),
  );
  const definition: unknown = module.default;
  if (
    !Predicate.hasProperty(definition, "_name") ||
    !Predicate.isString(definition._name)
  ) {
    return yield* InvalidConvexConfigError.make({
      configPath: "convex/convex.config.ts",
      reason: "the component definition must have a string name.",
    });
  }
  return definition._name;
});

/**
 * The module specifier the generated registry's `ComponentApi` type import
 * should use for a component, following Convex's own codegen convention:
 * `<definition directory>/_generated/component.js`. Bare (npm) definition
 * directories are used verbatim; locally-defined components (recorded as
 * absolute directories) become a relative path from `confect/_generated`.
 *
 * @internal
 */
export const typeImportPath = (
  path: Path.Path,
  componentDefinitionPath: string,
  confectGeneratedDirectory: string,
): string => {
  if (!path.isAbsolute(componentDefinitionPath)) {
    return componentDefinitionPath;
  }
  const relative = toPosixPath(
    path,
    path.relative(confectGeneratedDirectory, componentDefinitionPath),
  );
  return String.startsWith(".")(relative) ? relative : `./${relative}`;
};
