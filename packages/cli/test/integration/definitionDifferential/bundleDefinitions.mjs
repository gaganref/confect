/* oxlint-disable effecttsgo/async-function, effecttsgo/extends-native-error, effecttsgo/global-json, effecttsgo/node-builtin-import, effecttsgo/prefer-effect-array, effecttsgo/prefer-effect-record, effecttsgo/prefer-effect-string, effecttsgo/strict-boolean-expressions, no-await-in-loop -- This script runs in a child process outside Effect and drives convex's own Promise API, one step after another, as a push does. */
// The definition tree and module sets Convex's definition bundling gives for
// the project in the working directory, or why it gives none. It runs the
// steps a push runs before it bundles implementations
// (`src/cli/lib/components.ts:315-395` in convex 1.49): `componentGraph`, then
// `bundleDefinitions`, then each component directory's `entryPoints`, with the
// esbuild the installed convex resolves beside itself. It then evaluates the
// definition bundles as a deployment does, giving each `_componentDeps` import
// the definition it names, and reads the mount tree from their `export()`. It
// bundles no implementation and no schema, so a tree here does not mean a
// deploy succeeds: a module that imports a missing package bundles here and
// fails a deploy. It prints one JSON line.
//
// WORKAROUND: convex exports none of these functions, so this imports them
// from convex's unbundled build (`dist/esm`) by file path, which its exports
// map does not list. That build imports packages convex bundles into its CLI
// instead of depending on them, for prompts, telemetry, logs, config and local
// deployments, which definition bundling does not call, and the ones a store
// hoists may be other majors. So a resolve hook gives every package convex
// does not depend on a stub: any property, call or construction of it is the
// stub again, and a chalk color returns its text. Drop
// this when convex exports its deploy's definition bundling, and move the
// paths if a convex upgrade moves the files.
import { builtinModules, createRequire, registerHooks } from "node:module";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const manifest = createRequire(path.join(root, "_")).resolve(
  "convex/package.json",
);
const dist = path.join(path.dirname(manifest), "dist", "esm");
const entries = [
  "cli/lib/components/definition/bundle.js",
  "cli/lib/components/definition/directoryStructure.js",
  "bundler/index.js",
  "bundler/fs.js",
];

// The packages convex installs with itself, and the names each other package
// is imported by in the modules these entries reach.
const dependencies = new Set([
  ...Object.keys(JSON.parse(readFileSync(manifest, "utf8")).dependencies ?? {}),
  "convex",
]);
const packageOf = (specifier) =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");
const stubbed = new Map();
const seen = new Set();
const scan = (file) => {
  if (seen.has(file)) return;
  seen.add(file);
  const source = readFileSync(file, "utf8");
  for (const [, clause, specifier] of source.matchAll(
    /^\s*(?:import|export)\s+([^;]*?)\s*from\s*"([^"]+)"/gm,
  )) {
    if (specifier.startsWith(".")) {
      scan(path.resolve(path.dirname(file), specifier));
      continue;
    }
    const name = packageOf(specifier);
    if (
      specifier.startsWith("node:") ||
      builtinModules.includes(name) ||
      dependencies.has(name)
    )
      continue;
    const names = stubbed.get(specifier) ?? new Set();
    for (const [, imported] of (
      clause.match(/\{([^}]*)\}/)?.[1] ?? ""
    ).matchAll(/(?:^|,)\s*(?:type\s+)?([A-Za-z_$][\w$]*)/g))
      names.add(imported);
    stubbed.set(specifier, names);
  }
};
for (const entry of entries) scan(path.join(dist, entry));

// A color returns its text, so a message convex builds stays a string.
const stub = (names, colors) =>
  [
    "const any = new Proxy(function stub() {}, {",
    "  get: (_, key) => key === 'then' ? undefined : key === Symbol.toPrimitive ? () => '' : any,",
    `  apply: (_, __, args) => ${colors} && typeof args[0] === 'string' ? args[0] : any,`,
    "  construct: () => any,",
    "});",
    "export default any;",
    ...[...names].map((name) => `export const ${name} = any;`),
  ].join("\n");
registerHooks({
  resolve: (specifier, context, next) =>
    stubbed.has(specifier)
      ? {
          url: `data:text/javascript,${encodeURIComponent(stub(stubbed.get(specifier), specifier === "chalk"))}`,
          shortCircuit: true,
        }
      : next(specifier, context),
});

const load = (file) => import(pathToFileURL(path.join(dist, file)).href);
const { componentGraph, bundleDefinitions } = await load(
  "cli/lib/components/definition/bundle.js",
);
const { isComponentDirectory, toAbsolutePath } = await load(
  "cli/lib/components/definition/directoryStructure.js",
);
const { entryPoints } = await load("bundler/index.js");
const { nodeFs } = await load("bundler/fs.js");

class Crash extends Error {}
const ctx = {
  fs: nodeFs,
  deprecationMessagePrinted: false,
  spinner: undefined,
  crash: async (args) => {
    throw new Crash(args.printedMessage ?? "convex crashed");
  },
  flushAndExit: async (code) => {
    throw new Crash(`convex exited ${code}`);
  },
  registerCleanup: () => "",
  removeCleanup: () => null,
  bigBrainAuth: () => null,
  _updateBigBrainAuth: () => undefined,
};

const real = (file) => realpathSync(file);
const posix = (file) => file.split(path.sep).join("/");

const modulesOf = async (directory) => {
  const found = (await entryPoints(ctx, directory)).map((file) =>
    posix(path.relative(directory, file)),
  );
  for (const schema of ["schema.ts", "schema.js"])
    if (existsSync(path.join(directory, schema))) found.push(schema);
  return found.sort();
};

const run = async () => {
  const checked = isComponentDirectory(ctx, "convex", true);
  if (checked.kind !== "ok") throw new Crash(checked.why);
  const rootComponent = checked.component;
  const { components, dependencyGraph } = await componentGraph(
    ctx,
    root,
    rootComponent,
    false,
    false,
  );
  const {
    appDefinitionSpecWithoutImpls,
    componentDefinitionSpecsWithoutImpls,
  } = await bundleDefinitions(
    ctx,
    root,
    dependencyGraph,
    rootComponent,
    [...components.values()],
    false,
    false,
  );

  // Each definition bundle as a module, its `_componentDeps` imports pointing
  // at a stub with the definition path and the name the child defines.
  const scratch = path.join(root, ".convex-deploy");
  mkdirSync(scratch, { recursive: true });
  const id = (definitionPath) =>
    Buffer.from(definitionPath).toString("base64url");
  const specs = new Map(
    componentDefinitionSpecsWithoutImpls.map((spec) => [
      spec.definitionPath,
      spec,
    ]),
  );
  const missing = new Set();
  const write = (name, source) => {
    const rewritten = source.replace(
      /\.\/_componentDeps\/([A-Za-z0-9_-]+)/g,
      (_, encoded) => {
        const definitionPath = Buffer.from(encoded, "base64url").toString();
        if (!specs.has(definitionPath)) missing.add(definitionPath);
        return `./dep-${encoded}.mjs`;
      },
    );
    writeFileSync(path.join(scratch, `${name}.mjs`), rewritten);
  };
  write("app", appDefinitionSpecWithoutImpls.definition.source);
  for (const [definitionPath, spec] of specs) {
    write(`def-${id(definitionPath)}`, spec.definition.source);
    writeFileSync(
      path.join(scratch, `dep-${id(definitionPath)}.mjs`),
      `import child from "./def-${id(definitionPath)}.mjs";\nexport default { componentDefinitionPath: ${JSON.stringify(definitionPath)}, defaultName: child._name };\n`,
    );
  }
  if (missing.size > 0) {
    throw new Crash(
      `the definition bundles have no definition for ${[...missing].join(", ")}, which a bundled definition mounts`,
    );
  }
  const evaluate = async (name) =>
    (await import(pathToFileURL(path.join(scratch, `${name}.mjs`)).href))
      .default;

  const mounts = {};
  const visit = async (definition, prefix) => {
    for (const child of definition.export().childComponents) {
      const name = `${prefix}${child.name}`;
      const directory = toAbsolutePath(rootComponent, child.path);
      const component = components.get(directory);
      if (component === undefined)
        throw new Crash(`no component directory for ${child.path}`);
      mounts[name] = {
        directory: real(directory),
        definition: real(component.definitionPath),
        modules: await modulesOf(directory),
      };
      await visit(await evaluate(`def-${id(child.path)}`), `${name}/`);
    }
  };
  await visit(await evaluate("app"), "");
  return { bundles: true, app: await modulesOf(rootComponent.path), mounts };
};

const result = await run().catch((error) => {
  if (error instanceof Crash) return { bundles: false, reason: error.message };
  throw error;
});
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(0);
