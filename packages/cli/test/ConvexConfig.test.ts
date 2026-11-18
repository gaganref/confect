import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, expect, it as unit, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { generateComponents } from "@confect/cli/confect/codegen";
import { ConfectDirectory } from "@confect/cli/ConfectDirectory";
import {
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
}: {
  confectDirectory: string;
  convexDirectory: string;
  projectRoot: string;
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
