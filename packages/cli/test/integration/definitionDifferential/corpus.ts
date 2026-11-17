import * as Array from "effect/Array";
import * as Rec from "effect/Record";

/**
 * The packages the definition differential runs Convex's definition bundling
 * and Confect's codegen on. Each fixture mounts packaged components on a fresh
 * project. The differential compares the mount tree, each mount's definition
 * and its module set with what codegen records, and checks what Confect does
 * with a layout it does not read. To add a case, add a fixture: its files, the
 * mounts the app declares, whether Convex's definition bundling gives a tree
 * for it, what Confect does, and the cases it covers.
 */

/**
 * The cases the corpus must cover.
 */
export const cases = [
  "development/default exports",
  "convex versus import branches",
  ".js-only exports",
  "import-only exports",
  "exports map patterns",
  ".js/.ts config siblings",
  "a sibling whose child another mount supplies",
  "no exports map",
  "a definition not named convex.config",
  "nested packaged mount",
  "directory symlink",
  "TypeScript file with no import or export",
  "#/ subpath import",
  "a module importing a missing package",
  "a config importing a relative helper",
  "a config importing a helper package",
  "a relative import leaving the package",
  "a relative import with a .js and a .ts candidate",
  "exports: null",
  "an unsupported mount's nested package",
] as const;

export type Case = (typeof cases)[number];

/**
 * Why codegen does not read a packaged mount's layout, as the registry records
 * it.
 */
export type Unsupported =
  | "outside-exports"
  | "no-exports"
  | "config-file"
  | "config-siblings"
  | "config-imports"
  | "inside-unsupported";

/**
 * A mount codegen records as a layout it does not read: why, and the package
 * its own import names.
 */
export interface UnsupportedMount {
  readonly reason: Unsupported;
  readonly package: string;
}

const unread = (
  reason: Unsupported,
  packageName = "tool",
): UnsupportedMount => ({ reason, package: packageName });

/**
 * A mount the app's `confect/app.ts` declares: the definition `specifier`
 * imports, defined as `component`.
 */
export interface FixtureMount {
  readonly specifier: string;
  readonly component: string;
  readonly name: string;
  /**
   * The test kit the component names, when it is not the package's own.
   */
  readonly testing?: string;
}

export type FileContent = string | Readonly<Record<string, unknown>>;

export interface Fixture {
  readonly name: string;
  readonly covers: ReadonlyArray<Case>;
  /**
   * Whether Convex's definition bundling gives a definition tree for it. It
   * bundles no implementation, so this says nothing of whether a deploy's
   * module bundling succeeds.
   */
  readonly bundles: boolean;
  /**
   * What Confect does: reads every mount, records the given mounts as layouts
   * it does not read, by mount path, or refuses at codegen.
   */
  readonly confect:
    | "reads"
    | "refuses"
    | { readonly unsupported: Readonly<Record<string, UnsupportedMount>> };
  /**
   * For a fixture Confect reads, the error code and message a session opened on
   * its registry fails with.
   */
  readonly failsToOpen?: { readonly code: string; readonly message: RegExp };
  readonly mounts: ReadonlyArray<FixtureMount>;
  /**
   * Files below the project's `node_modules`, by path: a file's text, or a
   * manifest the project writes as JSON.
   */
  readonly files: Readonly<Record<string, FileContent>>;
  /**
   * Symbolic links below `node_modules` to directories, by path, each to a
   * target relative to the project's `node_modules`. Windows grants a link only
   * with a privilege CI lacks, so a fixture with links runs elsewhere.
   */
  readonly links?: Readonly<Record<string, string>>;
}

/**
 * A component definition named `name`, mounting each of `mounts` by the import
 * it names.
 */
export const definition = (
  name: string,
  mounts: ReadonlyArray<string> = [],
  note = "",
) =>
  Array.join(
    [
      'import { defineComponent } from "convex/server";',
      ...Array.map(
        mounts,
        (specifier, index) => `import child${index} from "${specifier}";`,
      ),
      `const component = defineComponent("${name}");`,
      ...Array.map(mounts, (_, index) => `component.use(child${index});`),
      "export default component;",
      note,
    ],
    "\n",
  );

/**
 * A component definition named `name` whose source starts with `imports`,
 * mounting each of `mounts`.
 */
const definitionWith = (
  imports: string,
  name: string,
  mounts: ReadonlyArray<string>,
) => `${imports}\n${definition(name, mounts)}`;

const surface =
  'import { queryGeneric } from "convex/server";\nexport const surface = queryGeneric({ args: {}, handler: () => "surface" });\n';

/**
 * A component directory at `directory` defining `name`, with a schema, a
 * `surface` module and its generated API.
 */
export const component = (
  directory: string,
  name: string,
  mounts: ReadonlyArray<string> = [],
): Record<string, string> => ({
  [`${directory}/convex.config.js`]: definition(name, mounts),
  [`${directory}/schema.js`]:
    'import { defineSchema } from "convex/server";\nexport default defineSchema({});\n',
  [`${directory}/_generated/api.js`]: "export {};\n",
  [`${directory}/surface.js`]: surface,
});

/**
 * A test kit that registers `component/`'s schema and modules, so a session
 * loads them.
 */
const registeringKit = `import schema from "./component/schema.js";
const modules = {
  "./component/_generated/api.js": () => import("./component/_generated/api.js"),
  "./component/surface.js": () => import("./component/surface.js"),
};
export function register(t, name) {
  t.registerComponent(name, schema, modules);
}
`;

/**
 * The package `name` at version 1.0.0 with `manifest`'s fields and `files`, and
 * a test kit at `test.js`, below `node_modules`.
 */
export const pkg = (
  name: string,
  manifest: Readonly<Record<string, unknown>>,
  files: Readonly<Record<string, string>>,
  kit = "export function register() {}\n",
): Record<string, FileContent> => ({
  [`${name}/package.json`]: {
    name,
    version: "1.0.0",
    type: "module",
    ...manifest,
  },
  [`${name}/test.js`]: kit,
  ...Rec.mapKeys(files, (file) => `${name}/${file}`),
});

const tool: FixtureMount = {
  specifier: "tool/convex.config",
  component: "tool",
  name: "tool",
};

const inner: FixtureMount = {
  specifier: "inner/convex.config",
  component: "inner",
  name: "inner",
};

const toolExports = (config: unknown) => ({
  exports: { "./convex.config": config, "./test": "./test.js" },
});

/**
 * The package `inner`, which defines "inner".
 */
const innerPackage = pkg(
  "inner",
  toolExports("./component/convex.config.js"),
  component("component", "inner"),
);

/**
 * `tool`, whose `component/` holds a `convex.config.js` export mounting
 * `jsMounts` beside a `convex.config.ts` mounting `tsMounts`.
 */
const siblings = (
  jsMounts: ReadonlyArray<string>,
  tsMounts: ReadonlyArray<string>,
) =>
  pkg("tool", toolExports("./component/convex.config.js"), {
    ...component("component", "tool", jsMounts),
    "component/convex.config.ts": definition(
      "tool",
      tsMounts,
      "// The sibling Convex deploys.\n",
    ),
  });

export const corpus: ReadonlyArray<Fixture> = [
  {
    name: "a development branch before a default one",
    covers: ["development/default exports"],
    bundles: true,
    confect: "reads",
    mounts: [tool],
    files: pkg(
      "tool",
      toolExports({
        development: "./dev/convex.config.js",
        default: "./component/convex.config.js",
      }),
      { ...component("component", "tool"), ...component("dev", "tool") },
    ),
  },
  {
    name: "a convex branch before an import one",
    covers: ["convex versus import branches"],
    bundles: true,
    confect: "reads",
    mounts: [tool],
    files: pkg(
      "tool",
      toolExports({
        import: "./node/convex.config.js",
        convex: "./component/convex.config.js",
      }),
      { ...component("component", "tool"), ...component("node", "tool") },
    ),
  },
  {
    name: "an export of the .js spelling only",
    covers: [".js-only exports"],
    bundles: true,
    confect: "reads",
    mounts: [{ ...tool, specifier: "tool/convex.config.js" }],
    files: pkg(
      "tool",
      {
        exports: {
          "./convex.config.js": "./component/convex.config.js",
          "./test": "./test.js",
        },
      },
      component("component", "tool"),
    ),
  },
  {
    name: "an export only an import condition resolves",
    covers: ["import-only exports"],
    bundles: true,
    confect: "reads",
    mounts: [{ ...tool, specifier: "tool/convex.config.js" }],
    files: pkg(
      "tool",
      {
        exports: {
          "./convex.config.js": { import: "./component/convex.config.js" },
          "./test": "./test.js",
        },
      },
      component("component", "tool"),
    ),
  },
  {
    name: "an exports map pattern that maps every subpath into dist",
    covers: ["exports map patterns"],
    bundles: true,
    confect: "reads",
    mounts: [{ ...tool, specifier: "tool/convex.config.js" }],
    files: pkg(
      "tool",
      { exports: { "./test": "./test.js", "./*": "./dist/*" } },
      component("dist", "tool"),
    ),
  },
  {
    name: "a .js export beside a .ts sibling, which Convex deploys",
    covers: [".js/.ts config siblings"],
    bundles: true,
    confect: { unsupported: { tool: unread("config-siblings") } },
    mounts: [tool],
    files: siblings([], []),
  },
  {
    name: "a .ts sibling mounting a component the .js export does not import",
    covers: [".js/.ts config siblings"],
    bundles: false,
    confect: { unsupported: { tool: unread("config-siblings") } },
    mounts: [tool],
    files: { ...siblings([], ["inner/convex.config"]), ...innerPackage },
  },
  {
    name: "a .ts sibling mounting a component another mount supplies",
    covers: ["a sibling whose child another mount supplies"],
    bundles: true,
    confect: { unsupported: { tool: unread("config-siblings") } },
    mounts: [tool, inner],
    files: { ...siblings([], ["inner/convex.config"]), ...innerPackage },
  },
  {
    name: "a package with main and module fields and no exports map, whose module imports a helper with them too",
    covers: ["no exports map"],
    bundles: true,
    confect: { unsupported: { tool: unread("no-exports") } },
    mounts: [{ ...tool, specifier: "tool/component/convex.config" }],
    files: {
      ...pkg(
        "tool",
        { main: "./cjs/index.js", module: "./esm/index.js" },
        {
          ...component("component", "tool"),
          "component/test.js": "export function register() {}\n",
          "component/surface.js":
            'import { queryGeneric } from "convex/server";\nimport { which } from "helper";\nexport const surface = queryGeneric({ args: {}, handler: () => which });\n',
          "cjs/index.js": "exports.tool = 'main';\n",
          "esm/index.js": "export const tool = 'module';\n",
        },
      ),
      "helper/package.json": {
        name: "helper",
        version: "1.0.0",
        main: "./main.cjs",
        module: "./module.js",
      },
      "helper/main.cjs": "exports.which = 'main';\n",
      "helper/module.js": "export const which = 'module';\n",
    },
  },
  {
    name: "an export to a definition not named convex.config",
    covers: ["a definition not named convex.config"],
    bundles: false,
    confect: { unsupported: { tool: unread("config-file") } },
    mounts: [tool],
    files: pkg("tool", toolExports("./component/index.js"), {
      ...component("component", "tool"),
      "component/index.js": definition("tool"),
    }),
  },
  {
    name: "a packaged component mounting another package's",
    covers: ["nested packaged mount"],
    bundles: true,
    confect: "reads",
    mounts: [tool],
    files: {
      ...pkg("tool", toolExports("./component/convex.config.js"), {
        ...component("component", "tool", ["inner/convex.config"]),
      }),
      ...innerPackage,
    },
  },
  {
    name: "a component directory holding a link to a directory of modules",
    covers: ["directory symlink"],
    bundles: true,
    confect: "reads",
    mounts: [tool],
    files: pkg("tool", toolExports("./component/convex.config.js"), {
      ...component("component", "tool"),
      "shared/extra.js":
        'import { queryGeneric } from "convex/server";\nexport const extra = queryGeneric({ args: {}, handler: () => "extra" });\n',
    }),
    links: { "tool/component/linked": "tool/shared" },
  },
  {
    name: "a component directory holding a TypeScript file with no import or export",
    covers: ["TypeScript file with no import or export"],
    bundles: true,
    confect: "reads",
    mounts: [tool],
    files: pkg("tool", toolExports("./component/convex.config.js"), {
      ...component("component", "tool"),
      "component/empty.ts": "const unused = 1;\n",
      "component/typed.ts":
        'import { queryGeneric } from "convex/server";\nexport const typed = queryGeneric({ args: {}, handler: () => "typed" });\n',
    }),
  },
  {
    name: "a nested definition imported through a #/ subpath import",
    covers: ["#/ subpath import"],
    bundles: false,
    confect: "refuses",
    mounts: [tool],
    files: pkg(
      "tool",
      {
        ...toolExports("./component/convex.config.js"),
        imports: { "#/*": "./*" },
      },
      {
        ...component("component", "tool", ["#/inner/convex.config.js"]),
        ...component("inner", "inner"),
      },
    ),
  },
  {
    name: "a registered module that imports a package that does not exist",
    covers: ["a module importing a missing package"],
    bundles: true,
    confect: "reads",
    // Definition bundling never reads the module, so only the session's load
    // finds the missing package, and fails the open.
    // Node's own error for the module's import, not a typed refusal: the
    // kernel loads every module as the session opens, and the load fails.
    failsToOpen: {
      code: "ERR_MODULE_NOT_FOUND",
      message:
        /^Cannot find package 'missing-package' imported from .*tool[/\\]component[/\\]surface\.js$/,
    },
    mounts: [tool],
    files: pkg(
      "tool",
      toolExports("./component/convex.config.js"),
      {
        ...component("component", "tool"),
        "component/surface.js": `import { gone } from "missing-package";\n${surface}export const used = () => gone;\n`,
      },
      registeringKit,
    ),
  },
  {
    name: "a config importing a relative helper that reaches only convex",
    covers: ["a config importing a relative helper"],
    bundles: true,
    confect: "reads",
    mounts: [tool],
    files: pkg("tool", toolExports("./component/convex.config.js"), {
      ...component("component", "tool"),
      "component/convex.config.js": definitionWith(
        'import { limit } from "./limits.js";',
        "tool",
        [],
      ),
      "component/limits.js":
        'import { v } from "convex/values";\nexport const limit = v.number();\n',
    }),
  },
  {
    name: "a config whose helper package's convex branch mounts a child its default branch does not",
    covers: ["a config importing a helper package"],
    bundles: true,
    confect: { unsupported: { tool: unread("config-imports") } },
    mounts: [tool],
    files: {
      ...pkg("tool", toolExports("./component/convex.config.js"), {
        ...component("component", "tool"),
        "component/convex.config.js": Array.join(
          [
            'import { defineComponent } from "convex/server";',
            'import { enabled } from "flags";',
            'import inner from "inner/convex.config";',
            'const component = defineComponent("tool");',
            "if (enabled) component.use(inner);",
            "export default component;",
            "",
          ],
          "\n",
        ),
      }),
      "flags/package.json": {
        name: "flags",
        version: "1.0.0",
        type: "module",
        exports: { ".": { convex: "./on.js", default: "./off.js" } },
      },
      "flags/on.js": "export const enabled = true;\n",
      "flags/off.js": "export const enabled = false;\n",
      ...innerPackage,
    },
  },
  {
    name: "a config importing a relative helper that imports a package",
    covers: ["a config importing a helper package"],
    bundles: true,
    confect: { unsupported: { tool: unread("config-imports") } },
    mounts: [tool],
    files: {
      ...pkg("tool", toolExports("./component/convex.config.js"), {
        ...component("component", "tool"),
        "component/convex.config.js": definitionWith(
          'import { flag } from "./flag.js";',
          "tool",
          [],
        ),
        "component/flag.js": 'export { enabled as flag } from "flags";\n',
      }),
      "flags/package.json": {
        name: "flags",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./on.js" },
      },
      "flags/on.js": "export const enabled = true;\n",
    },
  },
  {
    name: "a config importing a relative file outside its package",
    covers: ["a relative import leaving the package"],
    bundles: true,
    confect: { unsupported: { tool: unread("config-imports") } },
    mounts: [tool],
    files: {
      ...pkg("tool", toolExports("./component/convex.config.js"), {
        ...component("component", "tool"),
        "component/convex.config.js": definitionWith(
          'import { shared } from "../../shared/index.js";',
          "tool",
          [],
        ),
      }),
      "shared/index.js": "export const shared = 1;\n",
    },
  },
  {
    name: "a config importing a relative helper with a .js and a .ts candidate",
    covers: ["a relative import with a .js and a .ts candidate"],
    bundles: true,
    confect: { unsupported: { tool: unread("config-imports") } },
    mounts: [tool],
    files: pkg("tool", toolExports("./component/convex.config.js"), {
      ...component("component", "tool"),
      "component/convex.config.js": definitionWith(
        'import { limit } from "./limits";',
        "tool",
        [],
      ),
      "component/limits.js": "export const limit = 1;\n",
      "component/limits.ts": "export const limit = 2;\n",
    }),
  },
  {
    name: "a package whose exports field is null, imported by a deep path",
    covers: ["exports: null"],
    bundles: true,
    confect: { unsupported: { tool: unread("no-exports") } },
    // Vite reads a null exports field as one that exports nothing, so the
    // kit comes from another package.
    mounts: [
      {
        ...tool,
        specifier: "tool/component/convex.config.js",
        testing: "tool-kit/test",
      },
    ],
    files: {
      ...pkg(
        "tool",
        { exports: null, main: "./index.js" },
        {
          ...component("component", "tool"),
          "index.js": "export const tool = 1;\n",
        },
      ),
      ...pkg("tool-kit", { exports: { "./test": "./test.js" } }, {}),
    },
  },
  {
    name: "an unsupported mount whose nested mount is another package's",
    covers: ["an unsupported mount's nested package"],
    bundles: true,
    confect: {
      unsupported: {
        tool: unread("no-exports"),
        "tool/inner": unread("inside-unsupported", "inner"),
      },
    },
    mounts: [{ ...tool, specifier: "tool/component/convex.config.js" }],
    files: {
      ...pkg(
        "tool",
        { main: "./index.js" },
        {
          ...component("component", "tool", ["inner/convex.config"]),
          "component/test.js": "export function register() {}\n",
          "index.js": "export const tool = 1;\n",
        },
      ),
      ...innerPackage,
    },
  },
];
