import * as Array from "effect/Array";
import * as Rec from "effect/Record";

/**
 * The packages the deploy differential runs `convex deploy`'s definition
 * bundling and Confect's codegen on. Each fixture mounts packaged components on
 * a fresh project, and the differential compares the mount tree, each mount's
 * definition and the modules Convex would deploy with what codegen records. To
 * add a case, add a fixture: its files, the mounts the app declares, whether a
 * deploy succeeds, and the cases it covers.
 */

/**
 * The resolver and walk cases Confect has broken on, which the corpus must
 * cover.
 */
export const cases = [
  "development/default exports",
  "convex versus import branches",
  ".js-only exports",
  "import-only exports",
  ".js/.ts config siblings",
  "main/module without exports",
  "nested packaged mount",
  "directory symlink",
  "TypeScript file with no import or export",
  "#/ subpath import",
] as const;

export type Case = (typeof cases)[number];

/**
 * A mount the app's `confect/app.ts` declares: the definition `specifier`
 * imports, defined as `component`.
 */
export interface FixtureMount {
  readonly specifier: string;
  readonly component: string;
  readonly name: string;
}

export type FileContent = string | Readonly<Record<string, unknown>>;

export interface Fixture {
  readonly name: string;
  readonly covers: ReadonlyArray<Case>;
  /**
   * Whether `convex deploy` deploys it, so neither side passes by failing for a
   * reason the fixture did not mean.
   */
  readonly deploys: boolean;
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
  [`${directory}/surface.js`]:
    'import { queryGeneric } from "convex/server";\nexport const surface = queryGeneric({ args: {}, handler: () => "surface" });\n',
});

/**
 * The package `name` at version 1.0.0 with `manifest`'s fields and `files`, and
 * a test kit at `test.js`, below `node_modules`.
 */
export const pkg = (
  name: string,
  manifest: Readonly<Record<string, unknown>>,
  files: Readonly<Record<string, string>>,
): Record<string, FileContent> => ({
  [`${name}/package.json`]: {
    name,
    version: "1.0.0",
    type: "module",
    ...manifest,
  },
  [`${name}/test.js`]: "export function register() {}\n",
  ...Rec.mapKeys(files, (file) => `${name}/${file}`),
});

const tool: FixtureMount = {
  specifier: "tool/convex.config",
  component: "tool",
  name: "tool",
};

const toolExports = (config: unknown) => ({
  exports: { "./convex.config": config, "./test": "./test.js" },
});

export const corpus: ReadonlyArray<Fixture> = [
  {
    name: "a development branch before a default one",
    covers: ["development/default exports"],
    deploys: true,
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
    deploys: true,
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
    deploys: true,
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
    deploys: true,
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
    name: "a .js export beside a .ts sibling, which Convex deploys",
    covers: [".js/.ts config siblings"],
    deploys: true,
    mounts: [tool],
    files: pkg("tool", toolExports("./component/convex.config.js"), {
      ...component("component", "tool"),
      "component/convex.config.ts": definition(
        "tool",
        [],
        "// The sibling Convex deploys.\n",
      ),
    }),
  },
  {
    name: "a .ts sibling mounting a component the .js export does not",
    covers: [".js/.ts config siblings"],
    deploys: false,
    mounts: [tool],
    files: {
      ...pkg("tool", toolExports("./component/convex.config.js"), {
        ...component("component", "tool"),
        "component/convex.config.ts": definition("tool", [
          "inner/convex.config",
        ]),
      }),
      ...pkg("inner", toolExports("./component/convex.config.js"), {
        ...component("component", "inner"),
      }),
    },
  },
  {
    name: "a package with main and module fields and no exports",
    covers: ["main/module without exports"],
    deploys: true,
    mounts: [{ ...tool, specifier: "tool/component/convex.config" }],
    files: pkg(
      "tool",
      { main: "./cjs/convex.config.js", module: "./esm/convex.config.js" },
      {
        ...component("component", "tool"),
        ...component("cjs", "tool"),
        ...component("esm", "tool"),
        "component/test.js": "export function register() {}\n",
      },
    ),
  },
  {
    name: "a packaged component mounting another package's",
    covers: ["nested packaged mount"],
    deploys: true,
    mounts: [tool],
    files: {
      ...pkg("tool", toolExports("./component/convex.config.js"), {
        ...component("component", "tool", ["inner/convex.config"]),
      }),
      ...pkg("inner", toolExports("./component/convex.config.js"), {
        ...component("component", "inner"),
      }),
    },
  },
  {
    name: "a component directory holding a link to a directory of modules",
    covers: ["directory symlink"],
    deploys: true,
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
    deploys: true,
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
    deploys: false,
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
];
