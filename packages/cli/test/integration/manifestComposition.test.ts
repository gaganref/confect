import { expect, layer } from "@effect/vitest";
import * as Config from "effect/Config";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as String from "effect/String";
import { pipe } from "effect/Function";
import { codegenHandler } from "@confect/cli/confect/codegen";
import * as DirectoryOptions from "@confect/cli/DirectoryOptions";
import * as Bundler from "@confect/cli/Bundler";
import * as Declaration from "@confect/cli/Declaration";
import { stringify } from "@confect/cli/Json";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";

const http = (
  api: string,
  group: string,
  endpoint: string,
  method: string,
  route: string,
) =>
  `import { Http } from "@confect/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
export const Api = HttpApi.make("${api}").add(
  HttpApiGroup.make("${group}").add(HttpApiEndpoint.${method}("${endpoint}", "${route}", { success: Schema.String })),
);
const handlers = HttpApiBuilder.group(Api, "${group}", (h) => h.handle("${endpoint}", () => Effect.succeed("ok")));
export default Http.make({ api: Api, handlers });
`;

const client = (name: string) => `import { Component } from "@confect/core";
import manifest from "./confect/_generated/manifest";
export default Component.make("${name}", { manifest, client: (native: unknown) => native });
`;

const kit =
  "export function register(t, name) { t.registerComponent(name); }\n";

const packageJson = (name: string) =>
  stringify({
    name,
    type: "module",
    exports: {
      "./convex.config": "./convex/convex.config.ts",
      "./client": "./client.ts",
      "./testing": "./testing.js",
    },
  });

/**
 * A host mounts the packaged component relay, which mounts the packaged
 * component child. Each level leaves one slot open and serves one route.
 */
layer(NodeServices.layer)("ManifestComposition", (it) => {
  it.effect(
    "composes a nested packaged component's open slots and routes into the host manifest",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          directory: `${import.meta.dirname}/../fixtures`,
          prefix: "composition-",
        });
        const write = (file: string, contents: string) =>
          Effect.gen(function* () {
            yield* fs.makeDirectory(path.dirname(path.join(root, file)), {
              recursive: true,
            });
            yield* fs.writeFileString(path.join(root, file), contents);
          });
        const link = (from: string, to: string) =>
          Effect.gen(function* () {
            yield* fs.makeDirectory(path.dirname(path.join(root, from)), {
              recursive: true,
            });
            yield* fs.symlink(path.join(root, to), path.join(root, from));
          });

        yield* write("child/package.json", packageJson("@fx/child"));
        yield* write(
          "child/confect/app.ts",
          `import { App, Env } from "@confect/core";
export default App.make({ kind: "component", env: Env.make("child", { OPEN_SECRET: Env.secret(), REGION: Env.string(), STAGE: Env.automatic(Env.string()) }) });
`,
        );
        yield* write(
          "child/confect/http.ts",
          http("child", "hooks", "received", "post", "/received"),
        );
        yield* write("child/client.ts", client("child"));
        yield* write("child/testing.js", kit);
        yield* fs.makeDirectory(path.join(root, "child/convex"), {
          recursive: true,
        });

        yield* write("relay/package.json", packageJson("@fx/relay"));
        yield* link("relay/node_modules/@fx/child", "child");
        yield* write(
          "relay/confect/app.ts",
          `import { App, Env, Mount } from "@confect/core";
import child from "@fx/child/convex.config";
import Child from "@fx/child/client";
export default App.make({
  kind: "component",
  env: Env.make("relay", { TOKEN: Env.secret(), EMAIL_PROVIDER: Env.providers({ ses: { SES_REGION: Env.string(), SES_KEY: Env.secret() }, resend: { RESEND_API_KEY: Env.secret() } }) }),
  components: [child],
  mounts: [Mount.make(Child, { name: "child", httpPrefix: "/child", env: { REGION: "eu-west-1" } })],
});
`,
        );
        yield* write(
          "relay/confect/http.ts",
          http("relay", "hooks", "ping", "get", "/ping"),
        );
        yield* write("relay/client.ts", client("relay"));
        yield* write("relay/testing.js", kit);
        yield* fs.makeDirectory(path.join(root, "relay/convex"), {
          recursive: true,
        });

        yield* write(
          "host/package.json",
          stringify({ name: "host", type: "module" }),
        );
        yield* link("host/node_modules/@fx/relay", "relay");
        yield* write(
          "host/confect/app.ts",
          `import { App, Env, Mount } from "@confect/core";
import relay from "@fx/relay/convex.config";
import Relay from "@fx/relay/client";
export default App.make({
  env: Env.make("host", { HOST_KEY: Env.secret() }),
  components: [relay],
  mounts: [Mount.make(Relay, { name: "relay", httpPrefix: "/relay" })],
});
`,
        );
        yield* write(
          "host/confect/http.ts",
          http("host", "meta", "status", "get", "/status"),
        );
        yield* fs.makeDirectory(path.join(root, "host/convex"), {
          recursive: true,
        });

        const generate = (directory: string, component: boolean) =>
          Effect.gen(function* () {
            const services = yield* Layer.build(
              DirectoryOptions.layer({
                componentDir: component
                  ? Option.some(path.join(root, directory, "convex"))
                  : Option.none(),
              }),
            );
            return yield* codegenHandler.pipe(Effect.provideContext(services));
          }).pipe(Effect.scoped);
        const cwd = process.cwd();
        yield* generate("child", true);
        yield* generate("relay", true);
        yield* Effect.acquireUseRelease(
          Effect.sync(() => process.chdir(path.join(root, "host"))),
          () => generate("host", false),
          () => Effect.sync(() => process.chdir(cwd)),
        );

        const manifest = yield* fs.readFileString(
          path.join(root, "host/confect/_generated/manifest.ts"),
        );
        const relayConfig = yield* fs.readFileString(
          path.join(root, "relay/convex/convex.config.ts"),
        );
        const hostConfig = yield* fs.readFileString(
          path.join(root, "host/convex/convex.config.ts"),
        );
        const configured = yield* Config.option(
          Config.String("CONFECT_COMPOSITION_OUT"),
        );
        const out = Option.getOrUndefined(configured);
        if (out !== undefined) {
          yield* fs.makeDirectory(out, { recursive: true });
          yield* fs.writeFileString(
            path.join(out, "host-manifest.ts"),
            manifest,
          );
          const healthModule = yield* fs.readFileString(
            path.join(root, "host/convex/confectHealth.ts"),
          );
          yield* fs.writeFileString(
            path.join(out, "host-confectHealth.ts"),
            healthModule,
          );
          yield* fs.writeFileString(
            path.join(out, "relay-convex.config.ts"),
            relayConfig,
          );
          yield* fs.writeFileString(
            path.join(out, "host-convex.config.ts"),
            hostConfig,
          );
          const relayManifest = yield* fs.readFileString(
            path.join(root, "relay/confect/_generated/manifest.ts"),
          );
          yield* fs.writeFileString(
            path.join(out, "relay-manifest.ts"),
            relayManifest,
          );
        }
        const data = (yield* Bundler.bundle(
          path.join(root, "host/confect/_generated/manifest.ts"),
        )).module.default as {
          readonly digest: string;
          readonly env: unknown;
          readonly mounts: unknown;
          readonly http: Record<
            string,
            Record<string, Record<string, { path: string; digest: string }>>
          >;
        };
        expect(data.env).toEqual({
          HOST_KEY: { kind: "secret", optional: false },
          STAGE: { kind: "string", optional: false, automatic: true },
        });
        expect(data.mounts).toEqual({
          relay: {
            component: "relay",
            httpPrefix: "/relay",
            env: {
              TOKEN: {
                kind: "secret",
                optional: false,
                variable: "RELAY_TOKEN",
              },
              EMAIL_PROVIDER: {
                kind: "providers",
                values: ["ses", "resend"],
                optional: false,
                variable: "RELAY_EMAIL_PROVIDER",
              },
              SES_REGION: {
                kind: "string",
                optional: true,
                provider: {
                  selector: "EMAIL_PROVIDER",
                  name: "ses",
                  required: true,
                },
                variable: "RELAY_SES_REGION",
              },
              SES_KEY: {
                kind: "secret",
                optional: true,
                provider: {
                  selector: "EMAIL_PROVIDER",
                  name: "ses",
                  required: true,
                },
                variable: "RELAY_SES_KEY",
              },
              RESEND_API_KEY: {
                kind: "secret",
                optional: true,
                provider: {
                  selector: "EMAIL_PROVIDER",
                  name: "resend",
                  required: true,
                },
                variable: "RELAY_RESEND_API_KEY",
              },
              CHILD_OPEN_SECRET: {
                kind: "secret",
                optional: false,
                variable: "RELAY_CHILD_OPEN_SECRET",
              },
            },
          },
        });
        expect(
          Arr.flatMap(Rec.toEntries(data.http), ([owner, groups]) =>
            Arr.flatMap(Rec.values(groups), (endpoints) =>
              Arr.map(Rec.values(endpoints), (leaf) => [
                owner,
                leaf.path,
                leaf.digest === data.digest,
              ]),
            ),
          ),
        ).toEqual([
          ["app", "/status", true],
          ["relay", "/relay/ping", true],
          ["relay/child", "/relay/child/received", true],
        ]);
        const health = yield* fs.readFileString(
          path.join(root, "host/convex/confectHealth.ts"),
        );
        expect(health).toContain(`handler: () => "${data.digest}",`);
        const componentHealth = yield* fs.exists(
          path.join(root, "relay/convex/confectHealth.ts"),
        );
        expect(componentHealth).toBe(false);
        expect(relayConfig).toContain("STAGE: component.env.STAGE,");
        expect(hostConfig).toContain("STAGE: app.env.STAGE,");
        expect(hostConfig).toContain("STAGE: v.string(),");
        expect(pipe(hostConfig, String.includes("RELAY_STAGE"))).toBe(false);
        expect(relayConfig).toContain("EMAIL_PROVIDER: v.string(),");
        expect(relayConfig).toContain("SES_REGION: v.optional(v.string()),");
        expect(hostConfig).toContain("RELAY_EMAIL_PROVIDER: v.string(),");
        expect(hostConfig).toContain("RELAY_SES_KEY: v.optional(v.string()),");
        expect(hostConfig).toContain(
          "EMAIL_PROVIDER: app.env.RELAY_EMAIL_PROVIDER,",
        );
        expect(relayConfig).toContain("CHILD_OPEN_SECRET: v.string(),");
        expect(relayConfig).toContain('REGION: "eu-west-1",');
        expect(relayConfig).toContain(
          "OPEN_SECRET: component.env.CHILD_OPEN_SECRET,",
        );
        expect(pipe(relayConfig, String.includes("CHILD_REGION"))).toBe(false);
        expect(hostConfig).toContain("RELAY_CHILD_OPEN_SECRET: v.string(),");
        expect(hostConfig).toContain(
          "CHILD_OPEN_SECRET: app.env.RELAY_CHILD_OPEN_SECRET,",
        );
        yield* write(
          "host/confect/http.ts",
          http("host", "meta", "status", "get", "/renamed"),
        );
        yield* Effect.acquireUseRelease(
          Effect.sync(() => process.chdir(path.join(root, "host"))),
          () => generate("host", false),
          () => Effect.sync(() => process.chdir(cwd)),
        );
        const updated = (yield* Bundler.bundle(
          path.join(root, "host/confect/_generated/manifest.ts"),
        )).module.default as typeof data;
        expect(updated.digest).not.toBe(data.digest);
        const updatedHealth = yield* fs.readFileString(
          path.join(root, "host/convex/confectHealth.ts"),
        );
        expect(updatedHealth).toContain(`handler: () => "${updated.digest}",`);
        expect(updated.http.app?.meta?.status?.path).toBe("/renamed");
        expect(
          Arr.flatMap(Rec.values(updated.http), (groups) =>
            Arr.flatMap(Rec.values(groups), (endpoints) =>
              Arr.map(Rec.values(endpoints), (leaf) => leaf.digest),
            ),
          ),
        ).toEqual([updated.digest, updated.digest, updated.digest]);
      }).pipe(Effect.scoped),
    { timeout: 120000 },
  );
  it.effect(
    "round-trips a special endpoint key through generated manifest source",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const file = path.join(root, "manifest.ts");
        const catalogue = Declaration.routeCatalogue(
          [
            {
              method: "GET",
              path: "/special",
              owner: "app",
              group: "hooks",
              endpoint: "__proto__",
            },
          ],
          "sha256:special",
        );
        const routes = yield* Effect.fromResult(catalogue);
        yield* fs.writeFileString(
          file,
          Declaration.renderManifest({ http: routes }),
        );
        const bundled = yield* Bundler.bundle(file);
        expect(bundled.module.default).toEqual({
          http: {
            app: {
              hooks: {
                ["__proto__"]: {
                  method: "GET",
                  path: "/special",
                  owner: "app",
                  group: "hooks",
                  endpoint: "__proto__",
                  digest: "sha256:special",
                },
              },
            },
          },
        });
      }).pipe(Effect.scoped),
  );
});
