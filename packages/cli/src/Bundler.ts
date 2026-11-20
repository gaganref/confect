// oxlint-disable-next-line effecttsgo/node-builtin-import -- bundle-require calls its readFile synchronously inside an esbuild hook, which has no services.
import { readFileSync, realpathSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import * as BundleRequire from "bundle-require";
import { resolveModulePath } from "exsolve";
import { constUndefined, identity, pipe } from "effect/Function";
import * as Array from "effect/Array";
import * as Chunk from "effect/Chunk";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Iterable from "effect/Iterable";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Record from "effect/Record";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as String from "effect/String";
import * as esbuild from "esbuild";
import { BundlerError } from "./BuildError.js";
import { logCoalescedBuildWarnings } from "./log.js";
import * as PackageSelfReference from "./PackageSelfReference.js";
import * as TypeScriptConfig from "./TypeScriptConfig.js";

export interface Bundled {
  readonly module: any;
  readonly metafile: esbuild.Metafile;
}

/**
 * `bundle-require` sets `absWorkingDir: cwd` on the underlying esbuild build,
 * so the metafile's input keys (and each input's `imports[].path`) are stored
 * relative to that cwd. Callers reach for the metafile with absolute paths
 * (e.g. {@link directlyImports}), so we normalize every key/import path to
 * absolute up front. That way the lookup logic stays oblivious to whatever cwd
 * was used during bundling.
 *
 * `original` (the specifier as written, before resolution) is filled in from
 * `path` when esbuild omits it—esbuild only sets it when it differs from the
 * resolved path, which is exactly the externalized-bare-specifier case that
 * absolutizing `path` would otherwise mangle into `<cwd>/@confect/server`.
 * {@link importersOfPackage} relies on `original` always being the raw
 * specifier.
 */
const absolutizeMetafile = (
  path: Path.Path,
  metafile: esbuild.Metafile,
  cwd: string,
  inputPaths: ReadonlyMap<string, string>,
): esbuild.Metafile => {
  const absolutize = (p: string) => path.resolve(cwd, p);
  const inputPath = (p: string) =>
    inputPaths.get(absolutize(p)) ?? absolutize(p);
  const inputs = Record.mapEntries(metafile.inputs, (value, key) => [
    inputPath(key),
    {
      ...value,
      imports: Array.map(value.imports, (i) => ({
        ...i,
        path: inputPath(i.path),
        original: i.original ?? i.path,
      })),
    },
  ]);
  const outputs = Record.mapEntries(metafile.outputs, (value, key) => [
    absolutize(key),
    {
      ...value,
      ...(value.entryPoint !== undefined && value.entryPoint !== ""
        ? { entryPoint: inputPath(value.entryPoint) }
        : {}),
      inputs: Record.mapKeys(value.inputs, inputPath),
      imports: Array.map(value.imports, (imported) =>
        imported.external === true
          ? imported
          : { ...imported, path: absolutize(imported.path) },
      ),
    },
  ]);
  return { inputs, outputs };
};

const canonicalInputPaths = Effect.fnUntraced(function* (
  path: Path.Path,
  fs: FileSystem.FileSystem,
  metafile: esbuild.Metafile,
  cwd: string,
) {
  const inputPaths = yield* Effect.forEach(
    Record.keys(metafile.inputs),
    (input) => {
      const absolute = path.resolve(cwd, input);
      return fs.realPath(absolute).pipe(
        Effect.orElseSucceed(() => absolute),
        Effect.map((real) => [absolute, real] as const),
      );
    },
  );
  return new Map(inputPaths);
});

const resolveEsm = Option.liftThrowable((specifier: string, importer: string) =>
  resolveModulePath(specifier, {
    from: importer,
    conditions: ["node", "import"],
  }),
);

const resolveCjs = Option.liftThrowable((specifier: string, importer: string) =>
  createRequire(importer).resolve(specifier),
);

const resolveExternalEsm = Option.liftThrowable(
  (specifier: string, importer: string, conditions: string[]) =>
    resolveModulePath(specifier, { from: importer, conditions }),
);

/**
 * Whether `importer` can import `specifier` as ESM and TypeScript would. Unlike
 * {@link resolveModule}, it ignores `NODE_PATH`, which `pnpm` sets to its
 * hoisted store when it runs a bin.
 */
export const canImport = (specifier: string, importer: string): boolean =>
  Option.isSome(resolveEsm(specifier, importer));

/**
 * The file `importer` imports for `specifier` as Node's ESM resolution finds
 * it: a package's `exports` with nested conditions, arrays and the `node` and
 * `import` conditions, including a package importing itself by name. Unlike
 * {@link resolveModule}, it never falls back to CommonJS resolution.
 */
export const resolveEsmImport = (
  specifier: string,
  importer: string,
): Option.Option<string> => resolveEsm(specifier, importer);

export const resolveModule = (
  specifier: string,
  importer: string,
): Option.Option<string> =>
  Option.orElse(resolveEsm(specifier, importer), () =>
    resolveCjs(specifier, importer),
  );

/**
 * The names `file` exports, read by esbuild without evaluating the module, so a
 * test kit that only runs under Vite (`import.meta.glob`) can be checked. None
 * when only running the module would list them: a CommonJS module assigns its
 * exports at run time, and bare imports stay external, so `export *` from
 * another package hides its names.
 */
export const exportNames = (
  file: string,
): Effect.Effect<Option.Option<ReadonlyArray<string>>, BundlerError> =>
  Effect.tryPromise({
    try: () =>
      esbuild.build({
        entryPoints: [file],
        bundle: true,
        packages: "external",
        format: "esm",
        platform: "node",
        write: false,
        metafile: true,
        logLevel: "silent",
        outdir: "out",
      }),
    catch: (cause) => BundlerError.make({ cause }),
  }).pipe(
    Effect.map(({ metafile, outputFiles }) =>
      Array.some(
        Record.values(metafile.inputs),
        ({ format }) => format === "cjs",
      ) || Array.some(outputFiles, ({ text }) => /^export \* from /m.test(text))
        ? Option.none()
        : Option.some(
            Array.flatMap(
              Record.values(metafile.outputs),
              ({ exports }) => exports,
            ),
          ),
    ),
  );

/**
 * Bundles first-party workspace dependencies that `bundle-require` would
 * otherwise externalize and hand to Node's native ESM resolver. Resolves each
 * bare specifier and, following symlinks, bundles it when its real path lives
 * outside `node_modules`—mirroring Vite's "linked dependencies are not
 * externalized" heuristic. Registered ahead of `externalPlugin`, so deferring
 * (returning `undefined`) leaves third-party externalization untouched.
 * `skipPatterns` leave tsconfig `paths` aliases and package self-references to
 * esbuild's native resolution.
 *
 * @internal
 */
export const bundleWorkspacePlugin = (
  path: Path.Path,
  fs: FileSystem.FileSystem,
  skipPatterns: ReadonlyArray<string | RegExp>,
): esbuild.Plugin => ({
  name: "confect:bundle-workspace",
  setup(build) {
    const patterns = [...skipPatterns];
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.namespace !== "file" && args.namespace !== "") return undefined;
      if (isBuiltin(args.path) || path.isAbsolute(args.path)) return undefined;
      if (BundleRequire.match(args.path, patterns)) {
        return undefined;
      }

      const importer =
        args.importer !== "" ? args.importer : path.join(args.resolveDir, "_");

      return Option.match(resolveModule(args.path, importer), {
        onNone: () => ({
          path: args.path,
          external: true,
          warnings: [
            {
              text: `Confect could not resolve workspace dependency "${args.path}" (imported from ${importer}) to bundle it; leaving it external.`,
            },
          ],
        }),
        onSome: (resolved) =>
          Effect.runPromise(
            fs.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved)),
          ).then((real) =>
            pipe(real, String.split(path.sep), Array.contains("node_modules"))
              ? undefined
              : { path: real },
          ),
      });
    });
  },
});

interface CapturedBuildResult {
  readonly metafile: esbuild.Metafile | undefined;
  readonly warnings: ReadonlyArray<esbuild.Message>;
}

const captureBuildResultPlugin = (
  ref: Ref.Ref<CapturedBuildResult>,
): esbuild.Plugin => ({
  name: "confect:capture-build-result",
  setup(build) {
    build.onEnd((result) => {
      Effect.runSync(
        Ref.set(ref, {
          metafile: result.metafile,
          warnings: result.warnings,
        }),
      );
    });
  },
});

interface BatchCompilation {
  readonly entries: HashMap.HashMap<
    string,
    {
      readonly source: string;
      readonly output: string;
      readonly index: number;
    }
  >;
  readonly metafile: esbuild.Metafile;
  readonly inputPaths: ReadonlyMap<string, string>;
  readonly warnings: ReadonlyArray<esbuild.Message>;
  readonly cwd: string;
}

class BatchIncompatible extends Schema.TaggedError<
  BatchIncompatible,
  { readonly brand: unique symbol }
>()("BatchIncompatible", {
  reason: Schema.Literals([
    "RuntimeConditions",
    "UnsupportedEntries",
    "MixedTsconfigs",
    "UnattributedWarnings",
    "UnbundledImports",
    "DuplicatedModules",
  ]),
  message: Schema.String,
}) {}

class Batch extends Context.Service<
  Batch,
  {
    readonly entryPoints: ReadonlyArray<string>;
    readonly compilation: Effect.Effect<
      Option.Option<BatchCompilation>,
      never,
      Path.Path | FileSystem.FileSystem
    >;
  }
>()("@confect/cli/Bundler/Batch") {}

interface ExternalImport {
  readonly path: string;
  readonly original: string;
  /**
   * The file the import names, symlinks followed, when the build resolved it.
   */
  readonly real: string | undefined;
}

const inNodeModules = (file: string) => /[\\/]node_modules[\\/]/.test(file);

/**
 * Marks the resolution {@link batchResolutionPlugin} asks esbuild for, so the
 * plugin leaves it to esbuild.
 */
const realPathResolution = Symbol("confect:real-path-resolution");

const batchResolutionPlugin = (
  path: Path.Path,
  fs: FileSystem.FileSystem,
  skipPatterns: ReadonlyArray<string | RegExp>,
  conditions: string[],
  externalImports: Ref.Ref<
    HashMap.HashMap<string, ReadonlyArray<ExternalImport>>
  >,
): esbuild.Plugin => ({
  name: "confect:batch-resolution",
  setup(build) {
    const patterns = [...skipPatterns];
    const external = (
      args: esbuild.OnResolveArgs,
      resolved: string,
      real: string | undefined,
    ) => {
      const importer = path.resolve(args.importer);
      Effect.runSync(
        Ref.update(
          externalImports,
          HashMap.modifyAt(importer, (imports) =>
            Option.some(
              Array.append(
                Option.getOrElse(imports, () => []),
                { path: resolved, original: args.path, real },
              ),
            ),
          ),
        ),
      );
      return { path: resolved, external: true };
    };
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === "entry-point" || args.pluginData === realPathResolution)
        return undefined;
      if (isBuiltin(args.path)) return { path: args.path, external: true };
      if (BundleRequire.match(args.path, patterns)) return undefined;
      // A path through `node_modules` may be a symlink back into first-party
      // sources, such as a linked workspace package. Bundled by its real path,
      // it is the module the build reaches there; left external, Node would
      // load a second instance of it.
      if (inNodeModules(args.path)) {
        return build
          .resolve(args.path, {
            kind: args.kind,
            importer: args.importer,
            resolveDir: args.resolveDir,
            pluginData: realPathResolution,
          })
          .then((resolved) => {
            const real =
              resolved.errors.length === 0 &&
              resolved.external !== true &&
              resolved.namespace === "file"
                ? resolved.path
                : undefined;
            return real !== undefined && !inNodeModules(real)
              ? { path: real }
              : external(
                  args,
                  pathToFileURL(path.resolve(args.resolveDir, args.path)).href,
                  real,
                );
          });
      }
      if (String.startsWith(".")(args.path) || path.isAbsolute(args.path))
        return undefined;

      const resolved = resolveModule(args.path, args.importer);
      if (Option.isNone(resolved)) {
        return {
          errors: [
            { text: `Could not resolve "${args.path}" from ${args.importer}` },
          ],
        };
      }
      return Effect.runPromise(
        fs
          .realPath(resolved.value)
          .pipe(Effect.orElseSucceed(() => resolved.value)),
      ).then((real) => {
        if (!inNodeModules(real)) return { path: real };
        if (args.kind === "require-call" || args.kind === "require-resolve") {
          return external(
            args,
            createRequire(args.importer).resolve(args.path),
            real,
          );
        }
        return external(
          args,
          Option.match(
            resolveExternalEsm(args.path, args.importer, conditions),
            {
              onNone: () => args.path,
              onSome: (resolvedPath) => pathToFileURL(resolvedPath).href,
            },
          ),
          real,
        );
      });
    });
  },
});

/**
 * The esbuild messages for an `import()` or `require()` it leaves to Node
 * because it cannot tell what the call loads. esbuild reports them only at
 * debug level by default, so a lazy build raises them to warnings and fails on
 * them: a module loaded that way would be a second instance.
 */
const unbundledImports = [
  "unsupported-dynamic-import",
  "unsupported-require-call",
  "indirect-require",
] as const;

const lazyEntryNamespace = "confect:lazy-entry";

/**
 * Resolves `entry` to a module whose default export holds, for each of
 * `entries` in order, a function that imports it. Bundled without code
 * splitting, each import becomes a lazy initializer, so a module runs its top
 * level only once the first function that reaches it is called.
 */
const lazyEntryPlugin = (
  entry: string,
  entries: ReadonlyArray<string>,
  resolveDir: string,
): esbuild.Plugin => ({
  name: "confect:lazy-entry",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) =>
      args.kind === "entry-point" && args.path === entry
        ? { path: entry, namespace: lazyEntryNamespace }
        : undefined,
    );
    build.onLoad({ filter: /.*/, namespace: lazyEntryNamespace }, () => ({
      contents: `export default [${Array.join(
        Array.map(entries, (file) => `() => import(${JSON.stringify(file)})`),
        ", ",
      )}];\n`,
      resolveDir,
      loader: "js",
    }));
  },
});

/**
 * Compile `entryPoints` as one build. Split, each entry point gets its own
 * output, and modules several of them reach go to shared chunks. Lazy, one
 * output's default export holds a function per entry point, in the order of
 * {@link BatchCompilation.entries}' `index`, that imports it.
 */
const compileBatch = Effect.fn("Bundler.compileBatch")(function* (
  entryPoints: ReadonlyArray<string>,
  mode: "split" | "lazy",
  plugins: ReadonlyArray<esbuild.Plugin> = [],
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const nodeOptions = yield* Config.String("NODE_OPTIONS").pipe(
    Config.withDefault(""),
  );
  if (/--conditions|-C|--(?:no-)?addons/.test(nodeOptions))
    return yield* BatchIncompatible.make({
      reason: "RuntimeConditions",
      message:
        "NODE_OPTIONS changes Node export conditions; individual builds preserve native resolution.",
    });
  const runtimeOptions = yield* Effect.try({
    try: () =>
      parseArgs({
        args: process.execArgv,
        options: {
          conditions: { type: "string", short: "C", multiple: true },
          "no-addons": { type: "boolean" },
        },
        strict: false,
        allowPositionals: true,
      }).values,
    catch: (cause) => BundlerError.make({ cause }),
  });
  const conditions = [
    "node",
    "import",
    ...(process.features.require_module ? ["module-sync"] : []),
    ...(runtimeOptions["no-addons"] === true ||
    (typeof runtimeOptions["no-addons"] === "string" &&
      runtimeOptions["no-addons"] !== "")
      ? []
      : ["node-addons"]),
    ...Array.filter(
      runtimeOptions.conditions ?? [],
      (condition) => typeof condition === "string",
    ),
  ];
  const entries = Array.dedupe(
    Array.map(entryPoints, (entry) => path.resolve(entry)),
  );
  if (
    !Array.isReadonlyArrayNonEmpty(entries) ||
    !Array.every(
      entries,
      (entry) => BundleRequire.JS_EXT_RE.test(entry) && !inNodeModules(entry),
    )
  ) {
    return yield* BatchIncompatible.make({
      reason: "UnsupportedEntries",
      message:
        "Shared builds require JavaScript or TypeScript entries outside node_modules.",
    });
  }
  const first = Array.headNonEmpty(entries);
  const configs = yield* Effect.forEach(
    Array.dedupe(Array.map(entries, path.dirname)),
    TypeScriptConfig.discover,
  );
  const config = Array.headNonEmpty(configs);
  const configPath = (
    selected: Option.Option<TypeScriptConfig.TypeScriptConfig>,
  ) => Option.getOrUndefined(Option.map(selected, (value) => value.path));
  if (
    !Array.every(configs, (other) => configPath(other) === configPath(config))
  )
    return yield* BatchIncompatible.make({
      reason: "MixedTsconfigs",
      message: `Entries use different tsconfigs: ${Array.join(Array.dedupe(Array.map(configs, (item) => configPath(item) ?? "(no tsconfig)")), ", ")}`,
    });

  const cwd = yield* fs.realPath(path.dirname(first));
  const directory = yield* fs
    .makeTempDirectoryScoped({ prefix: "confect-batch-" })
    .pipe(Effect.flatMap((temporary) => fs.realPath(temporary)));
  const lazyEntry = path.join(path.dirname(first), "confect-lazy-entry.mjs");
  const artifacts = yield* Effect.forEach(entries, (entry, index) =>
    Effect.map(
      fs.realPath(entry),
      (source) =>
        [
          entry,
          {
            source,
            output: path.join(
              directory,
              mode === "lazy" ? "lazy.mjs" : `${index}.mjs`,
            ),
            index,
          },
        ] as const,
    ),
  );
  const externalImports = yield* Ref.make(
    HashMap.empty<string, ReadonlyArray<ExternalImport>>(),
  );
  const discoveredSelfReferences = yield* Effect.forEach(
    Array.dedupe(Array.map(entries, path.dirname)),
    PackageSelfReference.discover,
  );
  const selfReferences = Array.getSomes(discoveredSelfReferences);
  const result = yield* Effect.tryPromise({
    try: () =>
      esbuild.build({
        ...(mode === "lazy"
          ? {
              entryPoints: [lazyEntry],
              outfile: path.join(directory, "lazy.mjs"),
              logOverride: Record.fromIterableWith(
                unbundledImports,
                (id) => [id, "warning"] as const,
              ),
            }
          : {
              entryPoints: Array.map(entries, (entry, index) => ({
                in: entry,
                out: `${index}`,
              })),
              outdir: directory,
              outExtension: { ".js": ".mjs" },
              chunkNames: "chunk-[hash]",
              splitting: true,
            }),
        absWorkingDir: cwd,
        format: "esm",
        platform: "node",
        sourcemap: "inline",
        bundle: true,
        metafile: true,
        write: false,
        logLevel: "silent",
        ...TypeScriptConfig.buildOptions(config),
        plugins: [
          ...(mode === "lazy"
            ? [lazyEntryPlugin(lazyEntry, entries, cwd)]
            : []),
          ...plugins,
          batchResolutionPlugin(
            path,
            fs,
            [...TypeScriptConfig.aliasPatterns(config), ...selfReferences],
            conditions,
            externalImports,
          ),
          BundleRequire.injectFileScopePlugin(),
        ],
      }),
    catch: (cause) => BundlerError.make({ cause }),
  });
  const unbundled = Array.filter(result.warnings, (warning) =>
    Array.contains(unbundledImports, warning.id),
  );
  if (unbundled.length > 0)
    return yield* BatchIncompatible.make({
      reason: "UnbundledImports",
      message: Array.join(
        Array.map(
          unbundled,
          (warning) =>
            `${warning.location === null ? "" : `${path.resolve(cwd, warning.location.file)}:${warning.location.line}: `}${warning.text}`,
        ),
        "; ",
      ),
    });
  const inputPaths = HashSet.fromIterable(
    Array.map(Record.keys(result.metafile.inputs), (input) =>
      path.resolve(cwd, input),
    ),
  );
  const unattributedWarnings = Array.filter(
    result.warnings,
    (warning) =>
      warning.location === null ||
      !HashSet.has(inputPaths, path.resolve(cwd, warning.location.file)),
  );
  if (unattributedWarnings.length > 0)
    return yield* BatchIncompatible.make({
      reason: "UnattributedWarnings",
      message: `Cannot attribute build warnings to entries: ${Array.join(
        Array.map(unattributedWarnings, (warning) => warning.text),
        "; ",
      )}`,
    });
  yield* Effect.forEach(result.outputFiles, (output) =>
    fs.writeFile(output.path, output.contents),
  );
  const capturedExternalImports = yield* Ref.get(externalImports);
  const canonicalPaths = yield* canonicalInputPaths(
    path,
    fs,
    result.metafile,
    cwd,
  );
  const bundled = HashSet.fromIterable(canonicalPaths.values());
  const duplicated = Array.dedupe(
    Array.filter(
      Array.map(
        Array.flatten(
          Array.fromIterable(HashMap.values(capturedExternalImports)),
        ),
        ({ real }) => real,
      ),
      (real): real is string =>
        real !== undefined && HashSet.has(bundled, real),
    ),
  );
  if (duplicated.length > 0)
    return yield* BatchIncompatible.make({
      reason: "DuplicatedModules",
      message: `Modules both bundled and left to Node would run twice: ${Array.join(duplicated, ", ")}`,
    });
  const inputs = Record.fromEntries(
    Array.map(Record.toEntries(result.metafile.inputs), ([input, metadata]) => {
      const originals = Option.getOrElse(
        HashMap.get(capturedExternalImports, path.resolve(cwd, input)),
        () => [],
      );
      return [
        input,
        {
          ...metadata,
          imports: Array.flatMap(metadata.imports, (imported) => {
            const matching =
              imported.external === true
                ? Array.filter(
                    originals,
                    (original) => original.path === imported.path,
                  )
                : [];
            return matching.length === 0
              ? [imported]
              : Array.map(matching, (original) =>
                  Object.assign({}, imported, {
                    original: original.original,
                  }),
                );
          }),
        },
      ];
    }),
  );
  return {
    entries: HashMap.fromIterable(artifacts),
    metafile: absolutizeMetafile(
      path,
      { ...result.metafile, inputs },
      cwd,
      canonicalPaths,
    ),
    inputPaths: canonicalPaths,
    warnings: result.warnings,
    cwd,
  } satisfies BatchCompilation;
});

/**
 * Lazily shares one compilation across ordinary bundle calls in this effect.
 * Different tsconfigs and failed compilations fall back to individual builds.
 * Runtime conditions supplied through NODE_OPTIONS also use individual builds.
 * Imports still run at each caller, and temporary chunks live until the effect
 * finishes. The disposable evaluator, not this scope, owns Node's import
 * cache.
 */
export const withBatch = <A, E, R>(
  entryPoints: ReadonlyArray<string>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.scopedWith((scope) =>
    Effect.gen(function* () {
      const current = yield* Effect.serviceOption(Batch);
      if (
        Option.isSome(current) &&
        Array.every(entryPoints, (entry) =>
          current.value.entryPoints.includes(entry),
        )
      )
        return yield* effect;
      const compilation = yield* Effect.cached(
        compileBatch(entryPoints, "split").pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.asSome,
          Effect.catchTag("BatchIncompatible", (error) =>
            Effect.logDebug(
              "Shared build skipped; falling back to individual builds.",
              {
                entryPoints,
                reason: error.reason,
                detail: error.message,
              },
            ).pipe(Effect.as(Option.none<BatchCompilation>())),
          ),
          Effect.catch((error) =>
            Effect.logDebug(
              "Shared build failed; falling back to individual builds.",
              {
                entryPoints,
                reason: "CompileFailure",
              },
              Cause.fail(error),
            ).pipe(Effect.as(Option.none<BatchCompilation>())),
          ),
        ),
      );
      return yield* Effect.provideService(effect, Batch, {
        entryPoints,
        compilation,
      });
    }),
  );

interface MetafileTraversal {
  readonly pending: Chunk.Chunk<string>;
  readonly visited: HashSet.HashSet<string>;
}

const reachableMetafileEntries = <
  Metadata extends {
    readonly imports: ReadonlyArray<{
      readonly path: string;
      readonly external?: boolean;
    }>;
  },
>(
  entries: Readonly<Record<string, Metadata>>,
  root: string,
  resolveImport: (path: string) => string,
): Record<string, Metadata> =>
  Record.fromEntries(
    pipe(
      Iterable.unfold<
        MetafileTraversal,
        Option.Option<readonly [string, Metadata]>
      >(
        { pending: Chunk.of(root), visited: HashSet.empty() },
        ({ pending, visited }) => {
          if (!Chunk.isNonEmpty(pending)) return Option.none();
          const key = Chunk.headNonEmpty(pending);
          const remaining = Chunk.tailNonEmpty(pending);
          const metadata = entries[key];
          if (HashSet.has(visited, key) || metadata === undefined)
            return Option.some([
              Option.none(),
              { pending: remaining, visited },
            ]);
          return Option.some([
            Option.some([key, metadata] as const),
            {
              pending: Array.reduce(
                metadata.imports,
                remaining,
                (queue, imported) =>
                  imported.external === true
                    ? queue
                    : Chunk.append(queue, resolveImport(imported.path)),
              ),
              visited: HashSet.add(visited, key),
            },
          ]);
        },
      ),
      Iterable.getSomes,
    ),
  );

const entryMetafile = (
  path: Path.Path,
  compilation: BatchCompilation,
  source: string,
  output: string,
): esbuild.Metafile => ({
  inputs: reachableMetafileEntries(
    compilation.metafile.inputs,
    source,
    identity,
  ),
  outputs: reachableMetafileEntries(
    compilation.metafile.outputs,
    output,
    (key) => path.resolve(compilation.cwd, key),
  ),
});

/**
 * An entry of a shared build: the metafile of the modules it reaches, the
 * build's warnings about them, and its import, which runs each module it
 * reaches at most once across the build's entries.
 */
export interface SharedEntry {
  readonly metafile: esbuild.Metafile;
  readonly warnings: ReadonlyArray<esbuild.Message>;
  readonly module: Effect.Effect<any, BundlerError>;
}

const importOutput = (output: string): Effect.Effect<any, BundlerError> =>
  Effect.tryPromise({
    try: () =>
      BundleRequire.dynamicImport(pathToFileURL(output).href, {
        format: "esm",
      }),
    catch: (cause) => BundlerError.make({ cause }),
  });

const sharedEntry = (
  path: Path.Path,
  compilation: BatchCompilation,
  entry: { readonly source: string; readonly output: string },
  module: Effect.Effect<any, BundlerError>,
): SharedEntry => {
  const metafile = entryMetafile(path, compilation, entry.source, entry.output);
  return {
    metafile,
    warnings: Array.filter(
      compilation.warnings,
      (warning) =>
        warning.location !== null &&
        metafile.inputs[
          compilation.inputPaths.get(
            path.resolve(compilation.cwd, warning.location.file),
          ) ?? path.resolve(compilation.cwd, warning.location.file)
        ] !== undefined,
    ),
    module,
  };
};

/**
 * Bundle `entryPoints` as one build without code splitting, and give each entry
 * point's {@link SharedEntry}, in order. Each entry point's import runs the
 * modules it reaches in the order it imports them, as its own bundle would,
 * except a module an earlier import already ran, which is the same instance.
 * `plugins` are registered ahead of the build's own.
 *
 * Fails when the entry points cannot share a build: under different tsconfigs,
 * when the build fails, when an `import()` or `require()` loads what esbuild
 * cannot tell, or when a module would be both bundled and left to Node. Every
 * module would then not be one instance; bundling each on its own, as
 * {@link bundle} does, names a file at fault. The output lives until the scope
 * closes.
 */
export const bundleShared = Effect.fnUntraced(function* (
  entryPoints: ReadonlyArray<string>,
  plugins: ReadonlyArray<esbuild.Plugin> = [],
) {
  const path = yield* Path.Path;
  const compilation = yield* compileBatch(entryPoints, "lazy", plugins).pipe(
    Effect.mapError((cause) =>
      cause._tag === "BundlerError" ? cause : BundlerError.make({ cause }),
    ),
  );
  const entries = yield* Effect.forEach(entryPoints, (entryPoint) =>
    Option.match(HashMap.get(compilation.entries, path.resolve(entryPoint)), {
      onNone: () =>
        Effect.die(new Error(`${entryPoint} is not an entry point`)),
      onSome: Effect.succeed,
    }),
  );
  if (!Array.isReadonlyArrayNonEmpty(entries)) return [];
  // Every entry is one function of the same output's default export.
  const loaders = yield* Effect.cached(
    importOutput(Array.headNonEmpty(entries).output),
  );
  return Array.map(entries, (entry) =>
    sharedEntry(
      path,
      compilation,
      entry,
      Effect.flatMap(loaders, ({ default: load }) =>
        Effect.tryPromise({
          try: () => load[entry.index](),
          catch: (cause) => BundlerError.make({ cause }),
        }),
      ),
    ),
  );
});

/**
 * Bundle a TypeScript entry point with esbuild via
 * {@link BundleRequire.bundleRequire} and import the result. `bundle-require`
 * writes a temp `.mjs` next to the source, `import()`s it, and deletes it—so
 * third-party `node_modules` externals resolve through the user's normal
 * `node_modules` walk, while first-party workspace deps are bundled by
 * {@link bundleWorkspacePlugin} and tsconfig `paths` aliases stay inside the
 * bundle.
 *
 * The returned pair carries both the imported module and the esbuild metafile
 * so callers can inspect the import graph (see {@link directlyImports}); the
 * metafile is captured via a small `onEnd` plugin because `bundle-require`
 * itself only exposes a flat `dependencies: string[]`.
 *
 * `options.plugins` are registered ahead of every other plugin—including
 * `bundle-require`'s own `externalPlugin`—so a caller-supplied plugin can claim
 * resolutions (e.g. `convex.config` imports) before the workspace and
 * externalization heuristics see them.
 *
 * `options.footers` appends to each file it names, by real path as
 * `FileSystem.realPath` gives it, the text its function returns for the file's
 * source, as esbuild reads it.
 */
export const bundle = Effect.fn("Bundler.bundle")(
  (entryPoint: string, options?: BundleOptions) =>
    bundleWith(entryPoint, BundleRequire.dynamicImport, options),
);

export const check = Effect.fn("Bundler.check")((entryPoint: string) =>
  bundleWith(entryPoint).pipe(Effect.asVoid),
);

interface BundleOptions {
  readonly plugins?: ReadonlyArray<esbuild.Plugin>;
  readonly footers?: ReadonlyMap<string, (source: string) => string>;
}

const bundleWith = Effect.fnUntraced(function* (
  entryPoint: string,
  load?: typeof BundleRequire.dynamicImport,
  options?: BundleOptions,
): Effect.fn.Return<Bundled, BundlerError, Path.Path | FileSystem.FileSystem> {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  const batch = yield* Effect.serviceOption(Batch);
  if (
    Option.isSome(batch) &&
    (options?.plugins?.length ?? 0) === 0 &&
    options?.footers === undefined &&
    Array.some(
      batch.value.entryPoints,
      (entry) => path.resolve(entry) === path.resolve(entryPoint),
    )
  ) {
    const compilation = yield* batch.value.compilation;
    if (Option.isSome(compilation)) {
      const entry = HashMap.get(
        compilation.value.entries,
        path.resolve(entryPoint),
      );
      if (Option.isSome(entry)) {
        const { metafile, warnings, module } = sharedEntry(
          path,
          compilation.value,
          entry.value,
          importOutput(entry.value.output),
        );
        const loaded = yield* (load === undefined ? Effect.void : module).pipe(
          Effect.ensuring(logCoalescedBuildWarnings(warnings)),
        );
        return { module: loaded, metafile };
      }
    }
  }

  const buildResultRef = yield* Ref.make<CapturedBuildResult>({
    metafile: undefined,
    warnings: [],
  });

  const cwd = path.dirname(entryPoint);
  const selfReference = yield* PackageSelfReference.discover(cwd);
  const selfReferences = Option.toArray(selfReference);
  const config = yield* TypeScriptConfig.discover(cwd);
  const skipPatterns = [
    ...TypeScriptConfig.aliasPatterns(config),
    ...selfReferences,
  ];
  const footers = options?.footers;
  const result = yield* Effect.tryPromise({
    try: () =>
      BundleRequire.bundleRequire({
        filepath: entryPoint,
        require: load ?? constUndefined,
        cwd,
        format: "esm",
        tsconfig: false,
        notExternal: skipPatterns,
        ...(footers === undefined
          ? {}
          : {
              readFile: (file: string) => {
                const source = readFileSync(file, "utf8");
                const footer = footers.get(realpathSync.native(file));
                return footer === undefined ? source : source + footer(source);
              },
            }),
        esbuildOptions: {
          plugins: [
            {
              name: "confect:typescript-config",
              setup(build) {
                delete build.initialOptions.tsconfigRaw;
                Object.assign(
                  build.initialOptions,
                  TypeScriptConfig.buildOptions(config),
                );
              },
            },
            ...(options?.plugins ?? []),
            bundleWorkspacePlugin(path, fs, skipPatterns),
            captureBuildResultPlugin(buildResultRef),
          ],
          logLevel: "silent",
        },
      }),
    catch: (cause) => BundlerError.make({ cause }),
  }).pipe(
    Effect.ensuring(
      Effect.andThen(Ref.get(buildResultRef), (captured) =>
        logCoalescedBuildWarnings(captured.warnings),
      ),
    ),
  );

  const { metafile } = yield* Ref.get(buildResultRef);
  if (metafile === undefined) {
    return yield* Effect.die(new Error("esbuild metafile missing"));
  }

  const inputPaths = yield* canonicalInputPaths(path, fs, metafile, cwd);
  return {
    module: result.mod,
    metafile: absolutizeMetafile(path, metafile, cwd, inputPaths),
  };
});

const findMetafileInputKey = Effect.fnUntraced(function* (
  metafile: esbuild.Metafile,
  absolutePath: string,
) {
  const path = yield* Path.Path;
  const resolved = path.resolve(absolutePath);
  if (metafile.inputs[resolved] !== undefined) return Option.some(resolved);
  const fs = yield* FileSystem.FileSystem;
  const real = yield* fs
    .realPath(resolved)
    .pipe(Effect.orElseSucceed(() => resolved));
  return Array.findFirst(
    Record.keys(metafile.inputs),
    (key) => path.resolve(key) === real,
  );
});

/**
 * Returns `true` when the module bundled from `sourceAbsolutePath` declares a
 * direct import of `targetAbsolutePath` (according to the bundle's esbuild
 * metafile). Returns `false` if either path is missing from the metafile.
 */
export const directlyImports = Effect.fnUntraced(function* (
  bundled: Bundled,
  sourceAbsolutePath: string,
  targetAbsolutePath: string,
) {
  const path = yield* Path.Path;
  const sourceKey = yield* findMetafileInputKey(
    bundled.metafile,
    sourceAbsolutePath,
  );
  const targetKey = yield* findMetafileInputKey(
    bundled.metafile,
    targetAbsolutePath,
  );

  return pipe(
    Option.all([sourceKey, targetKey]),
    Option.flatMap(([sourceKey_, targetKey_]) =>
      Option.fromNullishOr(bundled.metafile.inputs[sourceKey_]).pipe(
        Option.map((sourceInput) => {
          const targetResolved = path.resolve(targetKey_);
          return Array.some(
            sourceInput.imports,
            (importedFile) =>
              path.resolve(importedFile.path) === targetResolved,
          );
        }),
      ),
    ),
    Option.getOrElse(() => false),
  );
});

/**
 * Returns the absolute paths of every module in the bundle that declares a
 * direct import of `packageName` (the package itself or one of its subpaths)
 * and satisfies `where`. Use `where` to restrict the search to the modules you
 * care about—the bundle's inputs include every transitive dependency.
 *
 * Matching is on the specifier as written rather than the resolved path,
 * because {@link bundleWorkspacePlugin} bundles first-party workspace
 * dependencies (so `@confect/server` resolves to a path inside the monorepo)
 * while a published install externalizes them (so it stays a bare specifier).
 * esbuild erases `import type` before it produces the metafile, so type-only
 * imports are not reported.
 */
export const importersOfPackage = (
  bundled: Bundled,
  packageName: string,
  where: (absolutePath: string) => boolean,
): ReadonlyArray<string> => {
  const subpathPrefix = `${packageName}/`;

  return Array.map(
    Array.filter(
      Record.toEntries(bundled.metafile.inputs),
      ([absolutePath, input]) =>
        where(absolutePath) &&
        Array.some(
          input.imports,
          (imported) =>
            imported.original === packageName ||
            (imported.original !== undefined &&
              String.startsWith(subpathPrefix)(imported.original)),
        ),
    ),
    ([absolutePath]) => absolutePath,
  );
};
