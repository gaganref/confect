import { fileURLToPath } from "node:url";
import { quote } from "@confect/cli/Json";
import { stripVTControlCharacters } from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Project from "./Project";
import * as Bundler from "@confect/cli/Bundler";
import { DatabaseSchema, MutationAuth } from "@confect/server";
import { TestConfect } from "../../../test/src";
import { defineSchema } from "convex/server";
import { vi } from "vitest";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Array from "effect/Array";
import * as Record from "effect/Record";

afterEach(() => vi.unstubAllEnvs());

layer(NodeServices.layer)("built confect codegen", (it) => {
  it.effect(
    "checks previous sections, removes only a failed section manifest and drops undeclared sections",
    () =>
      Effect.gen(function* () {
        const project = yield* Project.make;
        const fs = yield* FileSystem.FileSystem;
        const manifest = (yield* Path.Path).join(
          "confect",
          "_generated",
          "manifest.ts",
        );
        const declare = (sections: string) =>
          project.write(
            "confect/app.ts",
            `import { App, Env } from "@confect/core";
import { tags, other } from "./tags";
export default App.make({ env: Env.make("host", {}), manifestSections: [${sections}] });`,
          );
        yield* declare(
          '{ key: "tags", section: tags }, { key: "other", section: other }',
        );
        yield* project.write(
          "confect/tags.ts",
          `export const tags = { owner: "test/tags", format: 1, describe: ({ spec }) => spec.description,
check: (next, previous) => ({ errors: Object.values(next.functions).includes("bad") ? ["bad tags", "bad tags", "invalid entry"] : [], notes: [String(Object.keys(previous?.functions ?? {}).length) + " previous entries", "tags checked"] }) };
export const other = { ...tags, check: (next) => ({ errors: Object.values(next.functions).includes("bad") ? ["other failed"] : [], notes: [] }) };`,
        );
        const spec = (label: string) =>
          pipe(
            Project.spec,
            Str.replace(
              'name: "list"',
              `name: "list", description: "${label}"`,
            ),
          );
        const run = Effect.gen(function* () {
          const process = yield* project.start("codegen");
          const exit = yield* process.handle.exitCode;
          const output = yield* Ref.get(process.output);
          return { exit, output: stripVTControlCharacters(output) };
        });
        yield* project.write("confect/notes.spec.ts", spec("first"));
        const first = yield* run;
        expect(first.exit, first.output).toBe(0);
        expect(first.output).toContain("0 previous entries");
        yield* project.write(
          "confect/notes.spec.ts",
          'throw new Error("broken spec");',
        );
        expect((yield* run).exit).not.toBe(0);
        yield* project.write("confect/notes.spec.ts", spec("second"));
        const recovered = yield* run;
        expect(recovered.exit, recovered.output).toBe(0);
        expect(recovered.output).toContain("1 previous entries");
        expect(pipe(recovered.output, Str.split(manifest))).toHaveLength(2);
        const unchanged = yield* run;
        expect(unchanged.exit, unchanged.output).toBe(0);
        expect(unchanged.output).not.toContain(manifest);
        yield* project.write("confect/notes.spec.ts", spec("bad"));
        const failed = yield* run;
        expect(failed.exit).not.toBe(0);
        for (const message of [
          "bad tags",
          "invalid entry",
          "other failed",
          "1 previous entries",
          "tags checked",
        ])
          expect(pipe(failed.output, Str.split(message))).toHaveLength(2);
        expect(failed.output).toContain('Manifest section "tags" is invalid:');
        expect(failed.output).toContain('Manifest section "other" is invalid:');
        const found = yield* fs.exists(
          `${project.root}/confect/_generated/manifest.ts`,
        );
        expect(found).toBe(false);
        yield* project.write("confect/notes.spec.ts", spec("restored"));
        expect((yield* run).exit).toBe(0);
        yield* declare("");
        const undeclared = yield* run;
        expect(undeclared.exit, undeclared.output).toBe(0);
        expect(undeclared.output).not.toContain("tags checked");
        const contents = yield* fs.readFileString(
          `${project.root}/confect/_generated/manifest.ts`,
        );
        expect(contents).not.toContain('"tags"');
      }),
    { timeout: 30000 },
  );

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
        const exitCode2 = yield* generated.handle.exitCode;
        const output2 = yield* Ref.get(generated.output);
        expect(exitCode2, output2).toBe(0);
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
    "matches minted JWTs to generated providers under the test layer (configured=%s)",
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
        const exitCode2 = yield* generated.handle.exitCode;
        const output2 = yield* Ref.get(generated.output);
        expect(exitCode2, output2).toBe(0);
        const databaseSchema = DatabaseSchema.make({});
        yield* Effect.gen(function* () {
          const services = yield* Layer.build(
            TestConfect.layer(databaseSchema, defineSchema({}), {
              "_generated/server.ts": () => Promise.resolve({}),
            }),
          );
          return yield* Effect.gen(function* () {
            const runtime = yield* Bundler.bundle(
              `${project.root}/confect/_generated/auth.providers.ts`,
            );
            const test =
              yield* TestConfect.TestConfect<typeof databaseSchema>();
            const provider = runtime.module.providers[0];
            const token = yield* test.run(
              Effect.gen(function* () {
                const auth = yield* MutationAuth.MutationAuth;
                return yield* auth.signJwt({
                  claims: { sub: "person", aud: provider.audience },
                  expiresInSeconds: 60,
                });
              }),
              Schema.String,
            );
            const claims = yield* Schema.decodeEffect(
              Schema.fromJsonString(
                Schema.Struct({ iss: Schema.String, aud: Schema.String }),
              ),
            )(
              Buffer.from(
                pipe(token, Str.split("."))[1]!,
                "base64url",
              ).toString(),
            );
            expect(claims).toEqual({
              iss: provider.issuer,
              aud: provider.audience,
            });
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
          }).pipe(Effect.provideContext(services));
        }).pipe(Effect.scoped);
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
        const app = `import { App, Component, Env, Mount } from "@confect/core";
import auth from "../provider/convex.config";
export const env = Env.make("host", { PLATFORM_ISSUER: Env.string() });
const Auth = Component.make("auth", { client: (native: unknown) => native });
export default App.make({ env, components: [auth], mounts: [Mount.make(Auth, { name: "auth" })] });`;
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
            pipe(
              Project.impl,
              Str.replace(
                "const reader =",
                'if (providers[0].family !== "person") throw new Error("missing family"); const reader =',
              ),
            ),
        );
        const generated = yield* project.start("codegen");
        const exitCode2 = yield* generated.handle.exitCode;
        const output2 = yield* Ref.get(generated.output);
        expect(exitCode2, output2).toBe(0);
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
            Array.some(Record.keys(registered.metafile.inputs), (input) =>
              pipe(input, Str.endsWith(file)),
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
        const exitCode3 = yield* removed.handle.exitCode;
        const output3 = yield* Ref.get(removed.output);
        expect(exitCode3, output3).toBe(0);
        const found = yield* fs.exists(
          `${project.root}/confect/_generated/auth.providers.ts`,
        );
        expect(found).toBe(false);
        const configPathExists = yield* fs.exists(configPath);
        expect(configPathExists).toBe(false);
      }),
    { timeout: 30000 },
  );

  it.effect(
    "generates a fresh host whose mount passes one of the host's own refs in one run",
    () =>
      Effect.gen(function* () {
        const project = yield* Project.make;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${project.root}/email`);
        yield* project.write(
          "email/convex.config.ts",
          'import { defineComponent } from "convex/server"; export default defineComponent("email");',
        );
        yield* project.write(
          "email/client.ts",
          `import { Callback, Component, FunctionSpec, Ref } from "@confect/core";
import * as Schema from "effect/Schema";
export const OnEvent = Callback.mutation("email/onEvent", { args: () => ({ status: Schema.String }), returns: () => Schema.Null });
export default Component.make("email", {
  init: Ref.make("install", FunctionSpec.internalMutation({ name: "init", args: () => ({ onEvent: Callback.handle(OnEvent) }), returns: () => Schema.Null })),
  client: (native: unknown) => native,
});`,
        );
        yield* project.write(
          "confect/events.spec.ts",
          `import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
export default GroupSpec.make().addFunction(FunctionSpec.internalMutation({ name: "onEvent", args: () => ({ status: Schema.String }), returns: () => Schema.Null }));`,
        );
        yield* project.write(
          "confect/events.impl.ts",
          `import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Layer from "effect/Layer";
import schema from "./_generated/schema";
import events from "./events.spec";
const onEvent = FunctionImpl.make(schema, events, "onEvent", () => Effect.succeed(null));
export default GroupImpl.make(schema, events).pipe(Layer.provide(onEvent), GroupImpl.finalize);`,
        );
        yield* project.write(
          "confect/bulkEmail.ts",
          `import { Mount } from "@confect/core";
import Email from "../email/client";
import refs from "./_generated/refs";
export const BulkEmail = Mount.make(Email, { name: "bulkEmail", args: { onEvent: refs.internal.events.onEvent } });`,
        );
        yield* project.write(
          "confect/app.ts",
          `import { App, Env } from "@confect/core";
import email from "../email/convex.config";
import { BulkEmail } from "./bulkEmail";
export default App.make({ env: Env.make("host", {}), components: [email], mounts: [BulkEmail] });`,
        );
        const generated = yield* project.start("codegen");
        const exitCode2 = yield* generated.handle.exitCode;
        const output2 = yield* Ref.get(generated.output);
        expect(exitCode2, output2).toBe(0);
        const contents = yield* fs.readFileString(
          `${project.root}/convex/convex.config.ts`,
        );
        expect(contents).toContain('name: "bulkEmail"');
      }),
    { timeout: 30000 },
  );

  it.effect.each([
    ["inside a thunk", "", "components.bulkEmail"],
    [
      "at module top level",
      "const bulkEmail = components.bulkEmail;",
      "bulkEmail",
    ],
  ])(
    "generates a fresh host whose spec uses the component registry %s in one stable run",
    ([, topLevel, use]) =>
      Effect.gen(function* () {
        const project = yield* Project.make;
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${project.root}/email`);
        yield* project.write(
          "email/convex.config.ts",
          'import { defineComponent } from "convex/server"; export default defineComponent("email");',
        );
        yield* project.write(
          "email/client.ts",
          `import { Callback, Component, FunctionSpec, Ref } from "@confect/core";
import * as Schema from "effect/Schema";
export const OnEvent = Callback.mutation("email/onEvent", { args: () => ({ status: Schema.String }), returns: () => Schema.Null });
export default Component.make("email", {
  init: Ref.make("install", FunctionSpec.internalMutation({ name: "init", args: () => ({ onEvent: Callback.handle(OnEvent) }), returns: () => Schema.Null })),
  client: (native: unknown) => native,
});`,
        );
        yield* project.write(
          "confect/events.spec.ts",
          `import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
import { components } from "./_generated/components";
${topLevel}
export default GroupSpec.make().addFunction(FunctionSpec.internalMutation({ name: "onEvent", args: () => (${use} ? { status: Schema.String } : {}), returns: () => Schema.Null }));`,
        );
        yield* project.write(
          "confect/events.impl.ts",
          `import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Layer from "effect/Layer";
import schema from "./_generated/schema";
import events from "./events.spec";
const onEvent = FunctionImpl.make(schema, events, "onEvent", () => Effect.succeed(null));
export default GroupImpl.make(schema, events).pipe(Layer.provide(onEvent), GroupImpl.finalize);`,
        );
        yield* project.write(
          "confect/bulkEmail.ts",
          `import { Mount } from "@confect/core";
import Email from "../email/client";
import refs from "./_generated/refs";
export const BulkEmail = Mount.make(Email, { name: "bulkEmail", args: { onEvent: refs.internal.events.onEvent } });`,
        );
        yield* project.write(
          "confect/app.ts",
          `import { App, Env } from "@confect/core";
import email from "../email/convex.config";
import { BulkEmail } from "./bulkEmail";
export default App.make({ env: Env.make("host", {}), components: [email], mounts: [BulkEmail] });`,
        );
        const run = Effect.gen(function* () {
          const generated = yield* project.start("codegen");
          const exitCode2 = yield* generated.handle.exitCode;
          const output2 = yield* Ref.get(generated.output);
          expect(exitCode2, output2).toBe(0);
          return yield* project.generatedFiles;
        });
        const first = yield* run;
        expect(
          first[path.join("confect", "_generated", "components.ts")],
        ).toContain(
          '"bulkEmail": import("../../email/_generated/component.js").ComponentApi<"bulkEmail">;',
        );
        expect(first[path.join("convex", "convex.config.ts")]).toContain(
          'name: "bulkEmail"',
        );
        const runValue = yield* run;
        expect(runValue).toStrictEqual(first);
      }),
    { timeout: 60000 },
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
              pipe(
                Project.spec,
                Str.replace(
                  "GroupSpec.make()",
                  "GroupSpec.make().middleware(Policy)",
                ),
              ),
          );
          yield* project.write(
            "confect/notes.impl.ts",
            'import { MiddlewareImpl } from "@confect/server";\nimport { Policy } from "./policy";\n' +
              pipe(
                Project.impl,
                Str.replace(
                  "GroupImpl.finalize);",
                  "Layer.provide(MiddlewareImpl.make(databaseSchema, Policy, effect => effect)), GroupImpl.finalize);",
                ),
              ),
          );
        }
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${project.root}/confect/admin`);
        const contents = yield* fs.readFileString(
          `${project.root}/confect/notes.spec.ts`,
        );
        yield* project.write(
          "confect/admin/tasks.spec.ts",
          pipe(
            contents,
            Str.replace('"./policy"', '"../policy"'),
            Str.replace(
              '"./_generated/tables/notes"',
              '"../_generated/tables/notes"',
            ),
          ),
        );
        const contents2 = yield* fs.readFileString(
          `${project.root}/confect/notes.impl.ts`,
        );
        yield* project.write(
          "confect/admin/tasks.impl.ts",
          pipe(
            contents2,
            Str.replace('"./policy"', '"../policy"'),
            Str.replaceAll('"./_generated/', '"../_generated/'),
            Str.replace('"./notes.spec"', '"./tasks.spec"'),
          ),
        );
        const generated = yield* project.start("codegen");
        const exitCode = yield* generated.handle.exitCode;
        const output2 = yield* Ref.get(generated.output);
        const output = stripVTControlCharacters(output2);
        if (covered) {
          expect(exitCode, output).toBe(0);
          const registrationPath = `${project.root}/confect/_generated/registeredFunctions/admin/tasks.ts`;
          expect(
            (yield* Bundler.bundle(registrationPath)).module.default.list
              .isPublic,
          ).toBe(true);
          yield* project.write(
            "confect/admin/tasks.spec.ts",
            pipe(
              Project.spec,
              Str.replace(
                '"./_generated/tables/notes"',
                '"../_generated/tables/notes"',
              ),
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
          expect(
            pipe(
              output,
              Str.match(/Required middleware is missing:/g),
              Option.getOrNull,
            ),
          ).toHaveLength(1);
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
    ...Array.map(["http.ts", "crons.ts"], (file) => ({
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
        const exitCode2 = yield* initial.handle.exitCode;
        expect(exitCode2).toBe(0);
        if (name === "re-added file") {
          yield* fs.remove(`${project.root}/confect/notes.spec.ts`);
          yield* fs.remove(`${project.root}/confect/notes.impl.ts`);
          const removed = yield* project.start("codegen");
          yield* removed.waitFor("Generated files are up-to-date");
          const exitCode3 = yield* removed.handle.exitCode;
          expect(exitCode3).toBe(0);
          const found = yield* fs.exists(`${project.root}/convex/notes.ts`);
          expect(found).toBe(false);
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
        const output2 = yield* Ref.get(generated.output);
        const output = stripVTControlCharacters(output2);
        expect(exitCode, output).not.toBe(0);
        expect(output).toContain(`convex/${file}`);
        expect(output).toContain("not written by confect codegen");
        const contents = yield* fs.readFileString(
          `${project.root}/convex/${file}`,
        );
        expect(contents).toBe(previous + source);
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
        const exitCode2 = yield* initial.handle.exitCode;
        expect(exitCode2).toBe(0);
        yield* project.write("confect/removed.spec.ts", Project.spec);
        yield* project.write(
          "confect/removed.impl.ts",
          pipe(Project.impl, Str.replace('"./notes.spec"', '"./removed.spec"')),
        );
        const added = yield* project.start("codegen");
        yield* added.waitFor("Generated files are up-to-date");
        const exitCode3 = yield* added.handle.exitCode;
        expect(exitCode3).toBe(0);
        yield* fs.remove(path.join(project.root, "confect/removed.spec.ts"));
        yield* fs.remove(path.join(project.root, "confect/removed.impl.ts"));
        const removed = yield* project.start("codegen");
        yield* removed.waitFor("Generated files are up-to-date");
        const exitCode4 = yield* removed.handle.exitCode;
        expect(exitCode4).toBe(0);
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
        for (const [file, source] of Record.toEntries(files)) {
          yield* fs.makeDirectory(
            path.dirname(path.join(project.root, "convex", file)),
            { recursive: true },
          );
          yield* project.write(`convex/${file}`, source);
        }
        const generated = yield* project.start("codegen");
        const exitCode = yield* generated.handle.exitCode;
        const output2 = yield* Ref.get(generated.output);
        const output = stripVTControlCharacters(output2);
        expect(exitCode, output).not.toBe(0);
        for (const [file, source] of Record.toEntries(files)) {
          expect(output).toContain(`convex/${file}`);
          const contents = yield* fs.readFileString(
            path.join(project.root, "convex", file),
          );
          expect(contents).toBe(source);
        }
        expect(
          pipe(
            output,
            Str.match(/not written by confect codegen/g),
            Option.getOrNull,
          ),
        ).toHaveLength(1);
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
          pipe(Project.spec, Str.replace('name: "list"', 'name: "$list"')),
        );
        yield* project.write(
          "confect/notes.impl.ts",
          pipe(Project.impl, Str.replace('"list"', '"$list"')),
        );
        const initial = yield* project.start("codegen");
        yield* initial.waitFor("Generated files are up-to-date");
        const exitCode2 = yield* initial.handle.exitCode;
        expect(exitCode2).toBe(0);
        const expected = yield* project.generatedFiles;
        const repeated = yield* project.start("codegen");
        const exitCode3 = yield* repeated.handle.exitCode;
        const output2 = yield* Ref.get(repeated.output);
        expect(exitCode3, output2).toBe(0);
        const generatedFiles2 = yield* project.generatedFiles;
        expect(generatedFiles2).toEqual(expected);
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
        const exitCode2 = yield* component.handle.exitCode;
        expect(exitCode2).not.toBe(0);
        const output2 = yield* Ref.get(component.output);
        expect(output2).not.toContain("Generated files are up-to-date");
        const found = yield* fs.exists(`${project.root}/confect/_generated`);
        expect(found).toBe(false);
        const found2 = yield* fs.exists(`${project.root}/convex/tasks.ts`);
        expect(found2).toBe(false);
        yield* project.write(
          "convex/convex.config.ts",
          'import { defineApp } from "convex/server";\nexport default defineApp();\n',
        );
        const app = yield* project.start("codegen");
        yield* app.waitFor("Generated files are up-to-date");
        const exitCode3 = yield* app.handle.exitCode;
        expect(exitCode3).toBe(0);
        const contents = yield* fs.readFileString(
          `${project.root}/convex/tasks.ts`,
        );
        expect(contents).toContain('"use node"');
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
            const name = `g${pipe(String(index), Str.padStart(2, "0"))}`;
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
          const exitCode2 = yield* codegen.handle.exitCode;
          expect(exitCode2).toBe(0);
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
            "files": [${pipe(
              consumers,
              Array.map((consumer) => quote(consumer)),
              Array.join(","),
            )}]
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
        const exitCode3 = yield* compiler.exitCode;
        expect(exitCode3, output).toBe(0);
      }).pipe(Effect.scoped),
    { timeout: 60000 },
  );
});
