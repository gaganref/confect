import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Project from "./Project";
import * as Bundler from "@confect/cli/Bundler";
import { DatabaseSchema } from "@confect/server";
import { TestConfect } from "../../../test/src";
import { defineSchema } from "convex/server";
import { vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());

const stringLiteral = Schema.encodeSync(Schema.fromJsonString(Schema.String));

layer(NodeServices.layer)("built confect codegen", (it) => {
  it.effect(
    "lowers deployment JWT providers from a clean checkout without reading env",
    () =>
      Effect.gen(function* () {
        const project = yield* Project.make;
        yield* project.write(
          "confect/app.ts",
          `import { App, Env } from "@confect/core";
export const env = Env.make("host", { TRUSTED_ISSUER: Env.string(), TRUSTED_JWKS: Env.string() });
export default App.make({ env });`,
        );
        yield* project.write(
          "confect/auth.ts",
          `import { Auth } from "@confect/core";
import app, { env } from "./app";
export default Auth.make(app, { providers: [
  { type: "customJwt", issuer: Auth.cloudUrl("/components/auth"), jwks: Auth.cloudUrl("/.well-known/jwks.json"), applicationID: "convex", algorithm: "ES256" },
  { type: "customJwt", issuer: env.TRUSTED_ISSUER, jwks: env.TRUSTED_JWKS, applicationID: Auth.siteUrl(), algorithm: "ES256" }
] });`,
        );
        const generated = yield* project.start("codegen");
        expect(
          yield* generated.handle.exitCode,
          yield* Ref.get(generated.output),
        ).toBe(0);
        const fs = yield* FileSystem.FileSystem;
        const configPath = `${project.root}/convex/auth.config.ts`;
        const config = yield* fs.readFileString(configPath);
        expect(config).toContain("process.env.CONVEX_CLOUD_URL");
        expect(config).toContain('process.env["TRUSTED_ISSUER"]!');
        const lowered = yield* Bundler.bundle(configPath, {
          plugins: [
            {
              name: "deployment-env",
              setup(build) {
                build.initialOptions.define = {
                  "process.env.CONVEX_CLOUD_URL":
                    '"https://deployment.convex.cloud"',
                  "process.env.CONVEX_SITE_URL":
                    '"https://deployment.convex.site"',
                  "process.env.TRUSTED_ISSUER":
                    '"https://platform.convex.cloud/components/auth"',
                  "process.env.TRUSTED_JWKS":
                    '"https://platform.convex.cloud/.well-known/jwks.json"',
                };
              },
            },
          ],
        });
        expect(lowered.module.default).toEqual({
          providers: [
            {
              type: "customJwt",
              issuer: "https://deployment.convex.cloud/components/auth",
              jwks: "https://deployment.convex.cloud/.well-known/jwks.json",
              applicationID: "convex",
              algorithm: "ES256",
            },
            {
              type: "customJwt",
              issuer: "https://platform.convex.cloud/components/auth",
              jwks: "https://platform.convex.cloud/.well-known/jwks.json",
              applicationID: "https://deployment.convex.site",
              algorithm: "ES256",
            },
          ],
        });
      }),
    { timeout: 30000 },
  );

  it.effect.each([false, true])(
    "resolves generated provider URLs under the test layer (configured=%s)",
    (configured) =>
      Effect.gen(function* () {
        vi.stubEnv(
          "CONVEX_CLOUD_URL",
          configured ? "https://configured.convex.cloud" : undefined,
        );
        vi.stubEnv(
          "CONVEX_SITE_URL",
          configured ? "https://configured.convex.site" : undefined,
        );
        const project = yield* Project.make;
        yield* project.write(
          "confect/app.ts",
          `import { App, Env } from "@confect/core";
export default App.make({ env: Env.make("host", {}) });`,
        );
        yield* project.write(
          "confect/auth.ts",
          `import { Auth } from "@confect/core";
import app from "./app";
export default Auth.make(app, { providers: [
  { type: "customJwt", issuer: Auth.cloudUrl(), jwks: Auth.cloudUrl("/.well-known/jwks.json"), applicationID: Auth.siteUrl(), algorithm: "ES256", family: "person" }
] });`,
        );
        const generated = yield* project.start("codegen");
        expect(
          yield* generated.handle.exitCode,
          yield* Ref.get(generated.output),
        ).toBe(0);
        yield* Effect.gen(function* () {
          const runtime = yield* Bundler.bundle(
            `${project.root}/confect/_generated/auth.providers.ts`,
          );
          expect(runtime.module.providers).toEqual([
            {
              issuer: configured
                ? "https://configured.convex.cloud"
                : "https://some-deployment.convex.cloud",
              audience: configured
                ? "https://configured.convex.site"
                : "https://some.convex.site",
              family: "person",
            },
          ]);
        }).pipe(
          Effect.provide(
            TestConfect.layer(DatabaseSchema.make({}), defineSchema({}), {
              "_generated/server.ts": () => Promise.resolve({}),
            }),
          ),
        );
      }),
    { timeout: 30000 },
  );

  it.effect(
    "generates runtime provider families without importing component definitions",
    () =>
      Effect.gen(function* () {
        const project = yield* Project.make;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${project.root}/provider`);
        yield* project.write(
          "provider/convex.config.ts",
          'import { defineComponent } from "convex/server"; export default defineComponent("auth");',
        );
        const app = `import { App, Env } from "@confect/core";
import auth from "../provider/convex.config";
export const env = Env.make("host", { PLATFORM_ISSUER: Env.string() });
export default App.make({ env, mounts: { auth: App.mount(auth) } });`;
        yield* project.write("confect/app.ts", app);
        yield* project.write(
          "confect/auth.ts",
          `import { Auth } from "@confect/core";
import app, { env } from "./app";
export default Auth.make(app, { providers: [
 { type: "customJwt", issuer: Auth.cloudUrl("/components/auth"), jwks: Auth.cloudUrl("/.well-known/jwks.json"), applicationID: "convex", algorithm: "ES256", family: "person" },
 { type: "customJwt", issuer: env.PLATFORM_ISSUER, jwks: "https://platform.test/.well-known/jwks.json", applicationID: Auth.siteUrl(), algorithm: "ES256", family: "service", name: "platform" },
 { domain: "https://legacy.test", applicationID: "legacy" }
] });`,
        );
        yield* project.write(
          "confect/notes.impl.ts",
          'import { providers } from "./_generated/auth.providers";\n' +
            Project.impl.replace(
              "const reader =",
              'if (providers[0].family !== "person") throw new Error("missing family"); const reader =',
            ),
        );
        const generated = yield* project.start("codegen");
        expect(
          yield* generated.handle.exitCode,
          yield* Ref.get(generated.output),
        ).toBe(0);
        const configPath = `${project.root}/convex/auth.config.ts`;
        const config = yield* fs.readFileString(configPath);
        expect(config).not.toMatch(/family:|name:/);
        const definitions = [
          "confect/auth.ts",
          "confect/app.ts",
          "provider/convex.config.ts",
        ];
        for (const file of definitions)
          yield* project.write(
            file,
            'throw new Error("definition imported at runtime");',
          );
        const runtime = yield* Bundler.bundle(
          `${project.root}/confect/_generated/auth.providers.ts`,
          {
            plugins: [
              {
                name: "deployment-env",
                setup(build) {
                  build.initialOptions.define = {
                    "process.env.CONVEX_CLOUD_URL":
                      '"https://deployment.convex.cloud"',
                    "process.env.CONVEX_SITE_URL":
                      '"https://deployment.convex.site"',
                    "process.env.PLATFORM_ISSUER":
                      '"https://platform.test/components/auth"',
                  };
                },
              },
            ],
          },
        );
        expect(runtime.module.providers).toEqual([
          {
            issuer: "https://deployment.convex.cloud/components/auth",
            family: "person",
            audience: "convex",
          },
          {
            issuer: "https://platform.test/components/auth",
            family: "service",
            name: "platform",
            audience: "https://deployment.convex.site",
          },
          { issuer: "https://legacy.test", audience: "legacy" },
        ]);
        const registered = yield* Bundler.bundle(
          `${project.root}/confect/_generated/registeredFunctions/notes.ts`,
        );
        expect(registered.module.default.list.isPublic).toBe(true);
        for (const file of definitions)
          expect(
            Object.keys(registered.metafile.inputs).some((input) =>
              input.endsWith(file),
            ),
          ).toBe(false);
        yield* project.write("confect/app.ts", app);
        yield* project.write(
          "provider/convex.config.ts",
          'import { defineComponent } from "convex/server"; export default defineComponent("auth");',
        );
        yield* project.write("confect/notes.impl.ts", Project.impl);
        yield* fs.remove(`${project.root}/confect/auth.ts`);
        const removed = yield* project.start("codegen");
        expect(
          yield* removed.handle.exitCode,
          yield* Ref.get(removed.output),
        ).toBe(0);
        expect(
          yield* fs.exists(
            `${project.root}/confect/_generated/auth.providers.ts`,
          ),
        ).toBe(false);
        expect(yield* fs.exists(configPath)).toBe(false);
      }),
    { timeout: 30000 },
  );

  it.effect.each([false, true])(
    "enforces declared middleware in generated registration (covered=%s)",
    (covered) =>
      Effect.gen(function* () {
        const project = yield* Project.make;
        yield* project.write(
          "confect/policy.ts",
          `import { MiddlewareSpec } from "@confect/core";
export class Policy extends MiddlewareSpec.MiddlewareSpec<Policy>()("Policy", { functionTypes: { query: true, mutation: true, action: true } }) {}`,
        );
        yield* project.write(
          "confect/app.ts",
          `import { App, Env } from "@confect/core";
import { Policy } from "./policy";
export default App.make({ env: Env.make("host", {}), requiresMiddleware: [Policy] });`,
        );
        if (covered) {
          yield* project.write(
            "confect/notes.spec.ts",
            'import { Policy } from "./policy";\n' +
              Project.spec.replace(
                "GroupSpec.make()",
                "GroupSpec.make().middleware(Policy)",
              ),
          );
          yield* project.write(
            "confect/notes.impl.ts",
            'import { MiddlewareImpl } from "@confect/server";\nimport { Policy } from "./policy";\n' +
              Project.impl.replace(
                "GroupImpl.finalize);",
                "Layer.provide(MiddlewareImpl.make(databaseSchema, Policy, effect => effect)), GroupImpl.finalize);",
              ),
          );
        }
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${project.root}/confect/admin`);
        yield* project.write(
          "confect/admin/tasks.spec.ts",
          (yield* fs.readFileString(`${project.root}/confect/notes.spec.ts`))
            .replace('"./policy"', '"../policy"')
            .replace(
              '"./_generated/tables/notes"',
              '"../_generated/tables/notes"',
            ),
        );
        yield* project.write(
          "confect/admin/tasks.impl.ts",
          (yield* fs.readFileString(`${project.root}/confect/notes.impl.ts`))
            .replace('"./policy"', '"../policy"')
            .replaceAll('"./_generated/', '"../_generated/')
            .replace('"./notes.spec"', '"./tasks.spec"'),
        );
        const generated = yield* project.start("codegen");
        const exitCode = yield* generated.handle.exitCode;
        const output = stripVTControlCharacters(
          yield* Ref.get(generated.output),
        );
        if (covered) {
          expect(exitCode, output).toBe(0);
          const registrationPath = `${project.root}/confect/_generated/registeredFunctions/admin/tasks.ts`;
          expect(
            (yield* Bundler.bundle(registrationPath)).module.default.list
              .isPublic,
          ).toBe(true);
          yield* project.write(
            "confect/admin/tasks.spec.ts",
            Project.spec.replace(
              '"./_generated/tables/notes"',
              '"../_generated/tables/notes"',
            ),
          );
          expect(
            String(
              (yield* Effect.flip(Bundler.bundle(registrationPath))).cause,
            ),
          ).toContain('admin.tasks.list requires middleware "Policy"');
        } else {
          expect(exitCode, output).not.toBe(0);
          expect(output).toContain(
            'Required middleware is missing:\nadmin.tasks.list requires middleware "Policy"\nnotes.list requires middleware "Policy"',
          );
          expect(output.match(/Required middleware is missing:/g)).toHaveLength(
            1,
          );
        }
      }),
    { timeout: 30000 },
  );

  it.effect.each([
    {
      name: "raw export",
      file: "raw.ts",
      source:
        'import { queryGeneric } from "convex/server";\nexport const raw = queryGeneric({ handler: () => null });\n',
    },
    {
      name: "alias",
      file: "alias.js",
      source:
        'import { queryGeneric as query } from "convex/server";\nconst hidden = query({ handler: () => null });\nexport { hidden as raw };\n',
    },
    {
      name: "re-export",
      file: "nested/reexport.ts",
      source: 'export { raw } from "../../raw";\n',
    },
    {
      name: "re-added file",
      file: "notes.ts",
      source:
        'import { queryGeneric } from "convex/server";\nexport const raw = queryGeneric({ handler: () => null });\n',
    },
    {
      name: "appended export",
      file: "notes.ts",
      source: "\nexport { list as unchecked };\n",
    },
    {
      name: "hand-written helper without evaluating it",
      file: "helper.ts",
      source:
        'throw new Error("must not evaluate");\nexport const helper = 1;\n',
    },
    ...["http.ts", "crons.ts"].map((file) => ({
      name: "hand-written optional entrypoint",
      file,
      source: "export default {};\n",
    })),
  ])(
    "refuses $name in convex/$file",
    ({ name, file, source }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const project = yield* Project.make;
        const initial = yield* project.start("codegen");
        yield* initial.waitFor("Generated files are up-to-date");
        expect(yield* initial.handle.exitCode).toBe(0);
        if (name === "re-added file") {
          yield* fs.remove(`${project.root}/confect/notes.spec.ts`);
          yield* fs.remove(`${project.root}/confect/notes.impl.ts`);
          const removed = yield* project.start("codegen");
          yield* removed.waitFor("Generated files are up-to-date");
          expect(yield* removed.handle.exitCode).toBe(0);
          expect(yield* fs.exists(`${project.root}/convex/notes.ts`)).toBe(
            false,
          );
        }
        if (name === "re-export") {
          yield* project.write(
            "raw.ts",
            'import { queryGeneric } from "convex/server";\nexport const raw = queryGeneric({ handler: () => null });\n',
          );
        }
        const previous =
          name === "appended export"
            ? yield* fs.readFileString(`${project.root}/convex/${file}`)
            : "";
        yield* fs.makeDirectory(
          path.dirname(path.join(project.root, "convex", file)),
          { recursive: true },
        );
        yield* project.write(`convex/${file}`, previous + source);
        const generated = yield* project.start("codegen");
        const exitCode = yield* generated.handle.exitCode;
        const output = stripVTControlCharacters(
          yield* Ref.get(generated.output),
        );
        expect(exitCode, output).not.toBe(0);
        expect(output).toContain(`convex/${file}`);
        expect(output).toContain("not written by confect codegen");
        expect(yield* fs.readFileString(`${project.root}/convex/${file}`)).toBe(
          previous + source,
        );
      }).pipe(Effect.scoped),
    { timeout: 30000 },
  );

  it.effect(
    "reports all five refusal cases without changing their files",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const project = yield* Project.make;
        const initial = yield* project.start("codegen");
        yield* initial.waitFor("Generated files are up-to-date");
        expect(yield* initial.handle.exitCode).toBe(0);
        yield* project.write("confect/removed.spec.ts", Project.spec);
        yield* project.write(
          "confect/removed.impl.ts",
          Project.impl.replace('"./notes.spec"', '"./removed.spec"'),
        );
        const added = yield* project.start("codegen");
        yield* added.waitFor("Generated files are up-to-date");
        expect(yield* added.handle.exitCode).toBe(0);
        yield* fs.remove(path.join(project.root, "confect/removed.spec.ts"));
        yield* fs.remove(path.join(project.root, "confect/removed.impl.ts"));
        const removed = yield* project.start("codegen");
        yield* removed.waitFor("Generated files are up-to-date");
        expect(yield* removed.handle.exitCode).toBe(0);
        const files = {
          "raw.ts":
            'import { queryGeneric } from "convex/server"; export const raw = queryGeneric({ handler: () => null });',
          "alias.js":
            'import { queryGeneric as query } from "convex/server"; const hidden = query({ handler: () => null }); export { hidden as raw };',
          "nested/reexport.ts": 'export { raw } from "../raw";',
          "removed.ts": "export const raw = 1;",
          "notes.ts":
            (yield* fs.readFileString(
              path.join(project.root, "convex/notes.ts"),
            )) + "\nexport { list as unchecked };",
        };
        for (const [file, source] of Object.entries(files)) {
          yield* fs.makeDirectory(
            path.dirname(path.join(project.root, "convex", file)),
            { recursive: true },
          );
          yield* project.write(`convex/${file}`, source);
        }
        const generated = yield* project.start("codegen");
        const exitCode = yield* generated.handle.exitCode;
        const output = stripVTControlCharacters(
          yield* Ref.get(generated.output),
        );
        expect(exitCode, output).not.toBe(0);
        for (const [file, source] of Object.entries(files)) {
          expect(output).toContain(`convex/${file}`);
          expect(
            yield* fs.readFileString(path.join(project.root, "convex", file)),
          ).toBe(source);
        }
        expect(output.match(/not written by confect codegen/g)).toHaveLength(1);
      }).pipe(Effect.scoped),
    { timeout: 30000 },
  );

  it.effect(
    "accepts a generated tree on repeated codegen",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const project = yield* Project.make;
        yield* project.write(
          "confect/notes.spec.ts",
          Project.spec.replace('name: "list"', 'name: "$list"'),
        );
        yield* project.write(
          "confect/notes.impl.ts",
          Project.impl.replace('"list"', '"$list"'),
        );
        const initial = yield* project.start("codegen");
        yield* initial.waitFor("Generated files are up-to-date");
        expect(yield* initial.handle.exitCode).toBe(0);
        const expected = yield* project.generatedFiles;
        const repeated = yield* project.start("codegen");
        expect(
          yield* repeated.handle.exitCode,
          yield* Ref.get(repeated.output),
        ).toBe(0);
        expect(yield* project.generatedFiles).toEqual(expected);
        expect(expected[path.join("convex", "notes.ts")]).toContain(
          "export const $list = registeredFunctions.$list;",
        );
      }).pipe(Effect.scoped),
    { timeout: 30000 },
  );

  it.effect(
    "rejects a component Node group without generated output but permits it in an application",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const project = yield* Project.makeNodeComponent;
        const component = yield* project.start("codegen", [
          "--component-dir",
          "convex",
        ]);
        yield* component.waitFor(
          'Group "tasks" in tasks.spec.ts uses the Node runtime. Convex components do not support Node.js functions.',
        );
        expect(yield* component.handle.exitCode).not.toBe(0);
        expect(yield* Ref.get(component.output)).not.toContain(
          "Generated files are up-to-date",
        );
        expect(yield* fs.exists(`${project.root}/confect/_generated`)).toBe(
          false,
        );
        expect(yield* fs.exists(`${project.root}/convex/tasks.ts`)).toBe(false);
        yield* project.write(
          "convex/convex.config.ts",
          'import { defineApp } from "convex/server";\nexport default defineApp();\n',
        );
        const app = yield* project.start("codegen");
        yield* app.waitFor("Generated files are up-to-date");
        expect(yield* app.handle.exitCode).toBe(0);
        expect(
          yield* fs.readFileString(`${project.root}/convex/tasks.ts`),
        ).toContain('"use node"');
      }).pipe(Effect.scoped),
    { timeout: 30000 },
  );

  it.effect(
    "typechecks 47 groups strictly for applications and authored components",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner;
        const directory = yield* fs.makeTempDirectoryScoped({
          directory: import.meta.dirname,
          prefix: "strict-",
        });
        const consumers: string[] = [];
        for (const kind of ["host", "component"] as const) {
          const project = yield* Project.make;
          yield* fs.remove(path.join(project.root, "confect/notes.spec.ts"));
          yield* fs.remove(path.join(project.root, "confect/notes.impl.ts"));
          if (kind === "component") {
            yield* project.write(
              "package.json",
              '{"name":"@confect-fixtures/depth","type":"module"}',
            );
            yield* project.write(
              "convex/convex.config.ts",
              'import { defineComponent } from "convex/server";\nexport default defineComponent("depth");\n',
            );
          }
          for (let index = 1; index <= 47; index++) {
            const name = `g${String(index).padStart(2, "0")}`;
            yield* project.write(
              `confect/${name}.spec.ts`,
              `import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
export default GroupSpec.make().addFunction(
  FunctionSpec.publicQuery({ name: "get", args: () => ({ value: Schema.Number }), returns: () => Schema.Number }),
);
`,
            );
            yield* project.write(
              `confect/${name}.impl.ts`,
              `import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import schema from "./_generated/schema";
import group from "./${name}.spec";
const get = FunctionImpl.make(schema, group, "get", ({ value }) => Effect.succeed(value + 1));
export default GroupImpl.make(schema, group).pipe(Layer.provide(get), GroupImpl.finalize);
`,
            );
          }
          const codegen = yield* project.start(
            "codegen",
            kind === "component" ? ["--component-dir", "convex"] : [],
          );
          yield* codegen.waitFor("Generated files are up-to-date");
          expect(yield* codegen.handle.exitCode).toBe(0);
          yield* project.write(
            "consumer.ts",
            `import { expectTypeOf } from "vitest";
import type { Ref } from "@confect/core";
import refs from "./confect/_generated/refs";
expectTypeOf<Ref.Returns<typeof refs.public.g01.get>>().toEqualTypeOf<number>();
expectTypeOf<Ref.Returns<typeof refs.public.g47.get>>().toEqualTypeOf<number>();
// @ts-expect-error The generated annotation must still reject unknown groups.
refs.public.g48;
`,
          );
          consumers.push(path.join(project.root, "consumer.ts"));
        }
        yield* fs.writeFileString(
          path.join(directory, "tsconfig.json"),
          `{
            "compilerOptions": {
              "strict": true,
              "exactOptionalPropertyTypes": true,
              "noEmit": true,
              "skipLibCheck": true,
              "module": "ESNext",
              "moduleResolution": "Bundler",
              "target": "ESNext",
              "verbatimModuleSyntax": true
            },
            "files": [${consumers.map((consumer) => stringLiteral(consumer)).join(",")}]
          }`,
        );
        const compiler = yield* spawner.spawn(
          ChildProcess.make(process.execPath, [
            fileURLToPath(
              new URL(
                "bin/tsc",
                import.meta.resolve("typescript/package.json"),
              ),
            ),
            "-p",
            directory,
          ]),
        );
        const output = yield* compiler.all.pipe(
          Stream.decodeText(),
          Stream.mkString,
        );
        expect(yield* compiler.exitCode, output).toBe(0);
      }).pipe(Effect.scoped),
    { timeout: 60000 },
  );
});
