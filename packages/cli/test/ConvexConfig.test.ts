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
import { pipe } from "effect/Function";
import { quote } from "@confect/cli/Json";
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

layer(TestLayer)("generateComponents", (it) => {
  it.effect(
    "reads a Confect component's type from its contract and every other component's from Convex's file",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          directory: fixturesRoot,
        });
        const write = Effect.fnUntraced(function* (
          file: string,
          contents: string,
        ) {
          yield* fs.makeDirectory(path.dirname(path.join(root, file)), {
            recursive: true,
          });
          yield* fs.writeFileString(path.join(root, file), contents);
        });
        const definition = (name: string) =>
          `import { defineComponent } from "convex/server";\nexport default defineComponent(${quote(name)});\n`;
        const contract = "export type ComponentApi = {};\n";
        const confectComponent = Effect.fnUntraced(function* (
          convexDirectory: string,
          name: string,
        ) {
          yield* write(`${convexDirectory}/convex.config.ts`, definition(name));
          yield* write(
            `${convexDirectory}/schema.ts`,
            'export { default } from "../confect/_generated/convexSchema.js";\n',
          );
          yield* write(
            `${path.dirname(convexDirectory)}/confect/_generated/component.ts`,
            contract,
          );
        });
        const plainComponent = Effect.fnUntraced(function* (
          directory: string,
          name: string,
        ) {
          yield* write(`${directory}/convex.config.ts`, definition(name));
          yield* write(
            `${directory}/schema.ts`,
            'import { defineSchema } from "convex/server";\nexport default defineSchema({});\n',
          );
        });

        yield* confectComponent("components/a/convex", "a");
        yield* confectComponent("components/b/backend", "b");
        yield* plainComponent("components/c/convex", "c");
        // Another Confect project's files beside the plain component.
        yield* write("components/c/confect/app.ts", "export default {};\n");
        yield* write("components/c/confect/_generated/component.ts", contract);
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
        yield* plainComponent("app/plain", "plainBesideHost");
        yield* write("app/confect/app.ts", "export default {};\n");
        yield* write(
          "app/convex/convex.config.ts",
          `import { defineApp } from "convex/server";
import a from "../../components/a/convex/convex.config";
import b from "../../components/b/backend/convex.config";
import c from "../../components/c/convex/convex.config";
import plainBesideHost from "../plain/convex.config";
import nested from "../../components/a/convex/nested/convex/convex.config";
import plainNested from "../../components/a/convex/plain/convex.config";
import linked from "../../linked/convex/convex.config";
import kit from "confect-kit/convex.config";
import kitRelative from "../../node_modules/confect-kit/convex/convex.config";
import dotted from "../../components/c/../a/convex/convex.config";

const app = defineApp();
app.use(a, { name: "confectInConvex" });
app.use(b, { name: "confectInBackend" });
app.use(c, { name: "plainBesideUnrelatedConfect" });
app.use(plainBesideHost, { name: "plainBesideHost" });
app.use(nested, { name: "confectNested" });
app.use(plainNested, { name: "plainNested" });
app.use(linked, { name: "symlinked" });
app.use(kit, { name: "bareName" });
app.use(kitRelative, { name: "relativeIntoNodeModules" });
app.use(dotted, { name: "dotted" });
export default app;
`,
        );
        // A host that is itself a Confect component, with its own contract.
        yield* confectComponent("host/convex", "host");
        yield* write("host/confect/app.ts", "export default {};\n");
        yield* plainComponent("host/plain", "plainBesideComponentHost");
        yield* write(
          "host/convex/convex.config.ts",
          `import { defineComponent } from "convex/server";
import plain from "../plain/convex.config";

const host = defineComponent("host");
host.use(plain, { name: "plainBesideComponentHost" });
export default host;
`,
        );

        const registryOf = Effect.fnUntraced(function* (
          host: string,
          kind: "app" | "component",
        ) {
          yield* fs.makeDirectory(
            path.join(root, host, "confect", "_generated"),
            {
              recursive: true,
            },
          );
          const services = yield* Layer.build(
            directoriesLayer({
              confectDirectory: path.join(root, host, "confect"),
              convexDirectory: path.join(root, host, "convex"),
              projectRoot: root,
              target:
                kind === "app"
                  ? { kind, scope: IdScope.app }
                  : {
                      kind,
                      scope: IdScope.component(`fixture:${host}/convex`),
                    },
            }),
          );
          yield* generateComponents.pipe(Effect.provideContext(services));
          const contents = yield* fs.readFileString(
            path.join(root, host, "confect", "_generated", "components.ts"),
          );
          return Record.fromEntries(
            Array.map(
              Array.fromIterable(
                pipe(
                  contents,
                  String.matchAll(/"(\w+)": import\("([^"]+)"\)/g),
                ),
              ),
              ([, name = "", module = ""]) => [name, module] as const,
            ),
          );
        });

        const confect = (directory: string) =>
          `${directory}/confect/_generated/component.js`;
        const convex = (directory: string) =>
          `${directory}/_generated/component.js`;
        expect({
          ...(yield* registryOf("app", "app")),
          ...(yield* registryOf("host", "component")),
        }).toEqual({
          confectInConvex: confect("../../../components/a"),
          confectInBackend: confect("../../../components/b"),
          plainBesideUnrelatedConfect: convex("../../../components/c/convex"),
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
