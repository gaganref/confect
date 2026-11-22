import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, expect, it as unit, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Array from "effect/Array";
import * as Record from "effect/Record";
import * as String from "effect/String";
import { identity, pipe } from "effect/Function";
import { quote } from "@confect/cli/Json";
import * as templates from "@confect/cli/templates";
import { IdScope } from "@confect/core";
import { generateComponents } from "@confect/cli/confect/codegen";
import { ConfectDirectory } from "@confect/cli/ConfectDirectory";
import {
  componentApiModule,
  configImports,
  convexEsbuild,
  discoverInstalledComponents,
  isSupportedConfigImport,
  programImports,
  typeImportPath,
} from "@confect/cli/ConvexConfig";
import { ConvexDirectory } from "@confect/cli/ConvexDirectory";
import { ProjectRoot } from "@confect/cli/ProjectRoot";

const fixturesRoot = `${import.meta.dirname}/fixtures/components`;

const TestLayer = Layer.mergeAll(NodePath.layer, NodeFileSystem.layer);

const directoriesLayer = ({
  confectDirectory,
  convexDirectory,
  projectRoot,
  target,
}: {
  confectDirectory: string;
  convexDirectory: string;
  projectRoot: string;
  target?: ConvexDirectory["Service"]["target"];
}) =>
  Layer.mergeAll(
    Layer.succeed(
      ConfectDirectory,
      ConfectDirectory.of({
        get: Effect.succeed(confectDirectory),
      }),
    ),
    Layer.succeed(
      ConvexDirectory,
      ConvexDirectory.of({
        get: Effect.succeed(convexDirectory),
        ...(target === undefined ? {} : { target }),
      }),
    ),
    Layer.succeed(
      ProjectRoot,
      ProjectRoot.of({
        get: Effect.succeed(projectRoot),
      }),
    ),
  );

layer(TestLayer)("discoverInstalledComponents", (it) => {
  it.effect(
    "lists npm components by mount name, keeping bare import specifiers",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const components = yield* discoverInstalledComponents(
          path.join(fixturesRoot, "bare", "convex", "convex.config.ts"),
          "convex/convex.config.ts",
        );

        expect(components).toMatchObject([
          {
            name: "secondPool",
            componentDefinitionPath: "@convex-dev/workpool",
          },
          {
            name: "workpool",
            componentDefinitionPath: "@convex-dev/workpool",
          },
        ]);
      }),
  );

  it.effect(
    "records locally-defined components as resolved absolute directories",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const components = yield* discoverInstalledComponents(
          path.join(fixturesRoot, "local", "convex", "convex.config.ts"),
          "convex/convex.config.ts",
        );

        assert.strictEqual(components.length, 1);
        const [waitlist] = components;
        assert(waitlist !== undefined);
        expect(waitlist.name).toBe("waitlist");
        expect(path.resolve(waitlist.componentDefinitionPath)).toBe(
          path.resolve(path.join(fixturesRoot, "local", "convex", "waitlist")),
        );

        const importPath = typeImportPath(
          path,
          waitlist.componentDefinitionPath,
          path.join(fixturesRoot, "local", "confect", "_generated"),
        );
        expect(importPath).toBe("../../convex/waitlist");
      }),
  );

  it.effect(
    "discovers a component whose own definition installs other components",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const components = yield* discoverInstalledComponents(
          path.join(fixturesRoot, "nested", "convex", "convex.config.ts"),
          "convex/convex.config.ts",
        );

        // The workpool nested inside `test-nested` mounts on that component,
        // not on the app, so it isn't listed; its definition records it.
        expect(components).toMatchObject([
          { name: "nested", componentDefinitionPath: "test-nested" },
        ]);
        const [nested] = components;
        assert(nested !== undefined);
        const imported = Option.getOrUndefined(nested.imported);
        expect(imported?.import.specifier).toBe("test-nested/convex.config");
        expect(imported?.mounts).toMatchObject([
          {
            name: "workpool",
            definition: {
              import: { specifier: "@convex-dev/workpool/convex.config" },
            },
          },
        ]);
      }),
  );

  it.effect("fails with a BuildError when the config throws on import", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const result = yield* Effect.result(
        discoverInstalledComponents(
          path.join(fixturesRoot, "throwing", "convex", "convex.config.ts"),
          "convex/convex.config.ts",
        ),
      );

      assert(result._tag === "Failure");
      expect(result.failure._tag).toBe("ImportFailedError");
    }),
  );

  it.effect(
    "fails with InvalidConvexConfigError when a component name is invalid",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const result = yield* Effect.result(
          discoverInstalledComponents(
            path.join(fixturesRoot, "badName", "convex", "convex.config.ts"),
            "convex/convex.config.ts",
          ),
        );

        assert(result._tag === "Failure");
        assert(result.failure._tag === "InvalidConvexConfigError");
        expect(result.failure.reason).toContain('"not a valid name"');
      }),
  );

  it.effect(
    "fails with InvalidConvexConfigError when the default export is not an app definition",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const result = yield* Effect.result(
          discoverInstalledComponents(
            path.join(fixturesRoot, "invalid", "convex", "convex.config.ts"),
            "convex/convex.config.ts",
          ),
        );

        assert(result._tag === "Failure");
        expect(result.failure._tag).toBe("InvalidConvexConfigError");
      }),
  );
});

/**
 * Edits a file as formatters, editors and checkouts do. The registry must read
 * the same answer from each.
 */
const formats = {
  crlf: (text: string) => pipe(text, String.replaceAll("\n", "\r\n")),
  singleQuote: (text: string) => pipe(text, String.replaceAll('"', "'")),
  noSemicolons: (text: string) => pipe(text, String.replaceAll(/;$/gm, "")),
  headerComment: (text: string) =>
    `// IdScope.component("layouts:elsewhere/convex")\n/* export const scope = IdScope.component("layouts:elsewhere/convex"); */\n${text}`,
  noTrailingNewline: (text: string) => pipe(text, String.trimEnd),
  extraBlankLine: (text: string) => `${text}\n`,
  byteOrderMark: (text: string) => `﻿${text}`,
};

const reexport =
  'export { default } from "../confect/_generated/convexSchema.js";\n';
const declaredApp = `import { App, Env } from "@confect/core";
export default App.make({ env: Env.make("e", {}) });
`;
const declaredComponent = `import { App, Env } from "@confect/core";
export default App.make({ kind: "component", env: Env.make("g", {}) });
`;
const appId = Effect.runSync(templates.id({ tableNames: ["notes"] }));

/**
 * A scratch project named `layouts`, with helpers that lay out components as
 * their codegen leaves them, and that run `generateComponents` for a host.
 */
const layoutProject = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ directory: fixturesRoot });
  const write = Effect.fnUntraced(function* (file: string, contents: string) {
    yield* fs.makeDirectory(path.dirname(path.join(root, file)), {
      recursive: true,
    });
    yield* fs.writeFileString(path.join(root, file), contents);
  });
  yield* write("package.json", '{"name":"layouts"}');
  const definition = (name: string) =>
    `import { defineComponent } from "convex/server";\nexport default defineComponent(${quote(name)});\n`;
  const plainComponent = Effect.fnUntraced(function* (
    directory: string,
    name: string,
    schema = 'import { defineSchema } from "convex/server";\nexport default defineSchema({});\n',
  ) {
    yield* write(`${directory}/convex.config.ts`, definition(name));
    yield* write(`${directory}/schema.ts`, schema);
  });
  const confectComponent = Effect.fnUntraced(function* (
    convexDirectory: string,
    name: string,
    format: {
      readonly schema?: (text: string) => string;
      readonly id?: (text: string) => string;
    } = {},
  ) {
    const confectDirectory = `${path.dirname(convexDirectory)}/confect`;
    yield* plainComponent(
      convexDirectory,
      name,
      (format.schema ?? identity)(reexport),
    );
    yield* write(
      `${confectDirectory}/_generated/component.ts`,
      "export type ComponentApi = {};\n",
    );
    const id = yield* templates.id({
      tableNames: ["notes"],
      scope: IdScope.component(`layouts:${convexDirectory}`),
    });
    yield* write(
      `${confectDirectory}/_generated/id.ts`,
      (format.id ?? identity)(id),
    );
  });
  const registryOf = Effect.fnUntraced(function* (
    host: string,
    kind: "app" | "component",
    mounts: ReadonlyArray<readonly [name: string, directory: string]>,
  ) {
    yield* write(
      `${host}/convex/convex.config.ts`,
      Array.join(
        [
          `import { ${kind === "app" ? "defineApp" : "defineComponent"} } from "convex/server";`,
          ...Array.map(
            mounts,
            ([, directory], index) =>
              `import m${index} from ${quote(`${directory}/convex.config`)};`,
          ),
          kind === "app"
            ? "const host = defineApp();"
            : `const host = defineComponent(${quote(host)});`,
          ...Array.map(
            mounts,
            ([name], index) => `host.use(m${index}, { name: ${quote(name)} });`,
          ),
          "export default host;",
          "",
        ],
        "\n",
      ),
    );
    yield* fs.makeDirectory(path.join(root, host, "confect", "_generated"), {
      recursive: true,
    });
    const services = yield* Layer.build(
      directoriesLayer({
        confectDirectory: path.join(root, host, "confect"),
        convexDirectory: path.join(root, host, "convex"),
        projectRoot: root,
        target:
          kind === "app"
            ? { kind, scope: IdScope.app }
            : { kind, scope: IdScope.component(`layouts:${host}/convex`) },
      }),
    );
    yield* generateComponents.pipe(Effect.provideContext(services));
    const contents = yield* fs.readFileString(
      path.join(root, host, "confect", "_generated", "components.ts"),
    );
    return Record.fromEntries(
      Array.map(
        Array.fromIterable(
          pipe(contents, String.matchAll(/"(\w+)": import\("([^"]+)"\)/g)),
        ),
        ([, name = "", module = ""]) => [name, module] as const,
      ),
    );
  });
  return { root, write, plainComponent, confectComponent, registryOf };
});

layer(TestLayer)("generateComponents", (it) => {
  it.effect(
    "reads a component's type from its contract when the id.ts beside it records its directory, however either file is formatted",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, write, confectComponent, plainComponent, registryOf } =
          yield* layoutProject;

        yield* confectComponent("components/a/convex", "a");
        yield* confectComponent("components/b/backend", "b");
        // A plain component beside another component's `confect/`.
        yield* plainComponent("components/c/convex", "c");
        yield* confectComponent("components/c/backend", "cBackend");
        yield* confectComponent("components/a/convex/nested/convex", "nested");
        yield* plainComponent("components/a/convex/plain", "plainNested");
        yield* fs.symlink(
          path.join(root, "components", "a"),
          path.join(root, "linked"),
        );
        yield* confectComponent("node_modules/confect-kit/convex", "kit");
        yield* write(
          "node_modules/confect-kit/package.json",
          `{"name":"confect-kit","exports":{"./convex.config":"./convex/convex.config.ts","./_generated/component.js":"./confect/_generated/component.ts"}}`,
        );
        // Two definition folders share one `confect/`, whose `id.ts` records
        // one of them.
        yield* confectComponent("components/d/convex", "d");
        yield* plainComponent("components/d/backend", "dBackend", reexport);
        // A plain component whose hand-written `schema.ts` re-exports the
        // schema of the app beside it.
        yield* plainComponent("components/e/convex", "e", reexport);
        yield* write("components/e/confect/app.ts", declaredApp);
        yield* write("components/e/confect/_generated/id.ts", appId);
        // A component last generated before `id.ts` recorded a scope, and a
        // declared one whose codegen has not run. Neither has a contract
        // that exports `ComponentApi` until its codegen runs.
        yield* plainComponent("components/f/convex", "f", reexport);
        yield* write("components/f/confect/_generated/id.ts", appId);
        yield* plainComponent("components/g/convex", "g", reexport);
        yield* write("components/g/confect/app.ts", declaredComponent);
        for (const [variant, format] of Record.toEntries(formats)) {
          yield* confectComponent(`formats/id-${variant}/convex`, "f", {
            id: format,
          });
          yield* confectComponent(`formats/schema-${variant}/convex`, "f", {
            schema: format,
          });
        }
        yield* plainComponent("app/plain", "plainBesideHost");
        yield* write("app/confect/app.ts", declaredApp);
        // A host that is itself a Confect component, with its own contract.
        yield* confectComponent("host/convex", "host");
        yield* plainComponent("host/plain", "plainBesideComponentHost");

        const variants = Record.keys(formats);
        const registries = {
          ...(yield* registryOf("app", "app", [
            ["confectInConvex", "../../components/a/convex"],
            ["confectInBackend", "../../components/b/backend"],
            ["plainBesideOtherConfect", "../../components/c/convex"],
            ["plainBesideHost", "../plain"],
            ["confectNested", "../../components/a/convex/nested/convex"],
            ["plainNested", "../../components/a/convex/plain"],
            ["symlinked", "../../linked/convex"],
            ["bareName", "confect-kit"],
            [
              "relativeIntoNodeModules",
              "../../node_modules/confect-kit/convex",
            ],
            ["dotted", "../../components/c/../a/convex"],
            ["sharedConfectRecorded", "../../components/d/convex"],
            ["sharedConfectOther", "../../components/d/backend"],
            ["plainReexportingAppSchema", "../../components/e/convex"],
            ["olderBuild", "../../components/f/convex"],
            ["notGenerated", "../../components/g/convex"],
            ...Array.flatMap(variants, (variant) => [
              [`id_${variant}`, `../../formats/id-${variant}/convex`] as const,
              [
                `schema_${variant}`,
                `../../formats/schema-${variant}/convex`,
              ] as const,
            ]),
          ])),
          ...(yield* registryOf("host", "component", [
            ["plainBesideComponentHost", "../plain"],
          ])),
        };

        const confect = (directory: string) =>
          `${directory}/confect/_generated/component.js`;
        const convex = (directory: string) =>
          `${directory}/_generated/component.js`;
        expect(registries).toEqual({
          confectInConvex: confect("../../../components/a"),
          confectInBackend: confect("../../../components/b"),
          plainBesideOtherConfect: convex("../../../components/c/convex"),
          plainBesideHost: convex("../../plain"),
          plainBesideComponentHost: convex("../../plain"),
          confectNested: confect("../../../components/a/convex/nested"),
          plainNested: convex("../../../components/a/convex/plain"),
          symlinked: confect("../../../components/a"),
          bareName: convex("confect-kit"),
          // Discovery records both as the package name, whose export map
          // points at the contract.
          relativeIntoNodeModules: convex("confect-kit"),
          dotted: confect("../../../components/a"),
          sharedConfectRecorded: confect("../../../components/d"),
          sharedConfectOther: convex("../../../components/d/backend"),
          plainReexportingAppSchema: convex("../../../components/e/convex"),
          olderBuild: convex("../../../components/f/convex"),
          notGenerated: convex("../../../components/g/convex"),
          ...Record.fromEntries(
            Array.flatMap(variants, (variant) => [
              [`id_${variant}`, confect(`../../../formats/id-${variant}`)],
              [
                `schema_${variant}`,
                confect(`../../../formats/schema-${variant}`),
              ],
            ]),
          ),
        });
      }).pipe(Effect.scoped),
  );

  it.effect("writes a typed registry derived from `app.use(...)` calls", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const confectDirectory = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(confectDirectory, "_generated"));

      const services = yield* Layer.build(
        directoriesLayer({
          confectDirectory,
          convexDirectory: path.join(fixturesRoot, "bare", "convex"),
          projectRoot: path.join(fixturesRoot, "bare"),
        }),
      );
      yield* generateComponents.pipe(Effect.provideContext(services));

      const contents = yield* fs.readFileString(
        path.join(confectDirectory, "_generated", "components.ts"),
      );
      expect(contents).toBe(
        `import { componentsGeneric } from "convex/server";

export type Components = {
  "secondPool": import("@convex-dev/workpool/_generated/component.js").ComponentApi<"secondPool">;
  "workpool": import("@convex-dev/workpool/_generated/component.js").ComponentApi<"workpool">;
};

export const components: Components = componentsGeneric() as any;
`,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("writes an empty registry when there is no convex.config.ts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const confectDirectory = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(confectDirectory, "_generated"));
      const convexDirectory = yield* fs.makeTempDirectoryScoped();

      const services2 = yield* Layer.build(
        directoriesLayer({
          confectDirectory,
          convexDirectory,
          projectRoot: path.dirname(convexDirectory),
        }),
      );
      yield* generateComponents.pipe(Effect.provideContext(services2));

      const contents = yield* fs.readFileString(
        path.join(confectDirectory, "_generated", "components.ts"),
      );
      expect(contents).toBe(
        `import { componentsGeneric } from "convex/server";

export type Components = {};

export const components: Components = componentsGeneric() as any;
`,
      );
    }).pipe(Effect.scoped),
  );
});

layer(NodePath.layerWin32)("componentApiModule", (it) => {
  it.effect(
    "writes a component's module from Windows paths as a POSIX specifier",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const generated = "C:\\repo\\app\\confect\\_generated";
        expect(
          componentApiModule(
            path,
            "C:\\repo\\components\\b\\backend",
            generated,
            "confect",
          ),
        ).toBe("../../../components/b/confect/_generated/component.js");
        expect(
          componentApiModule(
            path,
            "C:\\repo\\components\\c\\convex",
            generated,
            "convex",
          ),
        ).toBe("../../../components/c/convex/_generated/component.js");
      }),
  );
});

describe("configImports", () => {
  unit(
    "reads the modules a definition's source imports, static, re-exported and dynamic, and leaves out type-only ones",
    () => {
      const imports =
        configImports(`import { defineComponent } from "convex/server";
import type { Shape } from "./types";
import { type Other } from "./moreTypes";
export type { Shape } from "./types";
import { logLevel } from "./logging";
export * from "./again";
import child from "child/convex.config";
const later = import("later");
const required = require("required");
export default defineComponent("tool");
`);
      expect(Option.getOrUndefined(imports)).toEqual([
        { specifier: "convex/server", dynamic: false },
        { specifier: "./logging", dynamic: false },
        { specifier: "./again", dynamic: false },
        { specifier: "child/convex.config", dynamic: false },
        { specifier: "later", dynamic: true },
        { specifier: "required", dynamic: true },
      ]);
    },
  );

  unit(
    "reads a TypeScript import-equals of a module as a runtime require, and erases a type-only one and an import type",
    () => {
      const imports =
        configImports(`import { defineComponent } from "convex/server";
import flags = require("../helpers/flag.js");
import type shapes = require("./shapes");
type Remote = import("remote").Shape;
let typed: import("typed").T;
export default defineComponent("tool");
`);
      expect(Option.getOrUndefined(imports)).toEqual([
        { specifier: "convex/server", dynamic: false },
        { specifier: "../helpers/flag.js", dynamic: true },
      ]);
    },
  );

  unit(
    "reads a runtime import-equals alias as an edge, as it may name require",
    () => {
      const imports = configImports(`import loader = require;
import Alias = Namespace.Inner;
const flags = loader("flags");
export default flags;
`);
      expect(Option.getOrUndefined(imports)).toEqual([
        { specifier: "import-equals alias", dynamic: true },
        { specifier: "import-equals alias", dynamic: true },
      ]);
    },
  );

  unit(
    "reads a free require, module or exports in any position as an edge, and leaves a module-level binding of one alone",
    () => {
      const free = configImports(`const pick = [require][0];
const name = module.id;
function read() { return exports; }
export default { pick, name, read, keyed: { require: 1 }.require };
`);
      expect(Option.getOrUndefined(free)).toEqual([
        { specifier: "require", dynamic: true },
        { specifier: "module", dynamic: true },
        { specifier: "exports", dynamic: true },
      ]);
      const local = configImports(`const exports = {};
function inner(module) { return module; }
export default { exports, inner };
`);
      expect(Option.getOrUndefined(local)).toEqual([
        { specifier: "module", dynamic: true },
      ]);
    },
  );

  unit.each([
    {
      form: "a declared variable",
      source:
        'declare const require: any;\nconst loader = require;\nloader("./hidden.js");\nexport {};\n',
      name: "require",
    },
    {
      form: "an exported declared variable",
      source: "export declare let module: any;\nexport default module.id;\n",
      name: "module",
    },
    {
      form: "a declared function",
      source:
        "declare function require(id: string): unknown;\nconst loader = require;\nexport default loader;\n",
      name: "require",
    },
    {
      form: "a declared class",
      source: "declare class module {}\nexport default module;\n",
      name: "module",
    },
    {
      form: "a declared enum",
      source: "declare enum exports { A }\nexport default exports;\n",
      name: "exports",
    },
    {
      form: "a declared module",
      source: "declare module require {}\nexport default require;\n",
      name: "require",
    },
    {
      form: "a global augmentation",
      source:
        "declare global { var require: unknown; }\nexport default require;\n",
      name: "require",
    },
    {
      form: "a namespace that holds only types",
      source:
        "namespace exports { export type T = 1; }\nexport default exports;\n",
      name: "exports",
    },
    {
      form: "a type-only import",
      source: 'import type require from "./types";\nexport default require;\n',
      name: "require",
    },
    {
      form: "a type-only import specifier",
      source:
        'import { type module } from "./types";\nexport default module;\n',
      name: "module",
    },
    {
      form: "an interface",
      source: "interface exports {}\nexport default exports;\n",
      name: "exports",
    },
    {
      form: "a type alias",
      source: "type module = 1;\nexport default module;\n",
      name: "module",
    },
  ])(
    "reads a free $name as an edge when $form, which TypeScript erases, is its only binding",
    ({ source, name }) => {
      const imports = Option.getOrUndefined(configImports(source));
      expect(imports).toContainEqual({ specifier: name, dynamic: true });
    },
  );

  unit(
    "reads import.meta and a require it does not call as runtime edges",
    () => {
      const imports = configImports(`const here = import.meta.url;
const load = require;
export default here;
`);
      expect(Option.getOrUndefined(imports)).toEqual([
        { specifier: "import.meta", dynamic: true },
        { specifier: "require", dynamic: true },
      ]);
    },
  );

  unit(
    "reads no esbuild from a path Node's lookup cannot start from as a failure, never a throw",
    () => {
      // createRequire takes only an absolute path, so a relative one throws,
      // and the throw must stay a failure.
      const loaded = convexEsbuild("relative/convex.config.ts");
      expect(Result.isFailure(loaded) ? loaded.failure : "loaded").toContain(
        "Node finds no convex package",
      );
    },
  );

  unit("fails closed on a node it does not know", () => {
    const imports = programImports({
      type: "Program",
      body: [{ type: "SomeFutureDeclaration", source: { value: "x" } }],
    });
    expect(Option.isNone(imports)).toBe(true);
  });

  unit("finds no imports in a source it cannot parse", () => {
    expect(Option.isNone(configImports("import {"))).toBe(true);
  });

  unit.each([
    [{ specifier: "convex/server", dynamic: false }, true],
    [{ specifier: "convex/values", dynamic: false }, true],
    [{ specifier: "child/convex.config", dynamic: false }, true],
    [{ specifier: "./logging", dynamic: false }, false],
    [{ specifier: "helper", dynamic: false }, false],
    [{ specifier: "convex/server", dynamic: true }, false],
  ])("supports %j: %s", (entry, supported) => {
    expect(isSupportedConfigImport(entry)).toBe(supported);
  });
});
