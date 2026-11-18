import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { expect, layer } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { generateWithSnapshot } from "@confect/cli/confect/codegen";
import * as Project from "./integration/Project";

const files: Record<string, string> = {
  "components/counter/convex/convex.config.ts": `import { defineComponent } from "convex/server";
import { v } from "convex/values";
export default defineComponent("counter", { env: { REQUIRED: v.string() } });
`,
  "confect/env.ts": `import { Env } from "@confect/core";
export default Env.make("host", { API_KEY: Env.secret(), MODE: Env.literals(["live", "test"]) });
`,
  "confect/sections.ts": `export const paths = {
  owner: "test/paths",
  format: 1,
  describe: ({ path }) => path,
  generate: {
    file: "paths.ts",
    match: (file) => file === "env.ts",
    render: (input) => ({ contents: "export const paths = " + JSON.stringify(input.functions.map((f) => f.path)) + ";\\n", errors: [] }),
    verify: { match: () => false, check: () => [] },
  },
  testing: () => ({ open: ["notes:list"] }),
};
`,
  "confect/app.ts": `import { App, Component, Mount } from "@confect/core";
import * as Schema from "effect/Schema";
import counter from "../components/counter/convex/convex.config";
import env from "./env";
import { paths } from "./sections";
const Counter = Component.make("counter", { env: { REQUIRED: Schema.String }, client: (native: unknown) => native });
export const First = Mount.make(Counter, { name: "first", httpPrefix: "/first" });
export default App.make({ env, components: [counter], mounts: [First], manifestSections: [{ key: "paths", section: paths }] });
`,
  "confect/auth.ts": `import { Auth } from "@confect/core";
import app from "./app";
export default Auth.make(app, { providers: [{ domain: "https://login.example.test", applicationID: "host" }] });
`,
  "confect/http.ts": `import { Http } from "@confect/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
const Api = HttpApi.make("host").add(HttpApiGroup.make("meta").add(HttpApiEndpoint.get("status", "/status", { success: Schema.String })));
const handlers = HttpApiBuilder.group(Api, "meta", (h) => h.handle("status", () => Effect.succeed("ok")));
export default Http.make({ api: Api, handlers, docs: "/docs" });
`,
  "confect/tasks.spec.ts": `import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
export default GroupSpec.make()
  .addFunction(FunctionSpec.publicMutation({ name: "add", args: () => ({ text: Schema.String }), returns: () => Schema.Null }))
  .addFunction(FunctionSpec.internalQuery({ name: "count", returns: () => Schema.Number }));
`,
  "confect/tasks.impl.ts": `import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import databaseSchema from "./_generated/schema";
import tasks from "./tasks.spec";
export default GroupImpl.make(databaseSchema, tasks).pipe(
  Layer.provide(FunctionImpl.make(databaseSchema, tasks, "add", () => Effect.succeed(null))),
  Layer.provide(FunctionImpl.make(databaseSchema, tasks, "count", () => Effect.succeed(0))),
  GroupImpl.finalize,
);
`,
};

layer(Layer.mergeAll(NodePath.layer, NodeFileSystem.layer))(
  "codegen without route specs",
  (it) => {
    it.effect(
      "writes the same files the generator wrote before route specs",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const project = yield* Project.make;
          yield* fs.makeDirectory(
            path.join(project.root, "components/counter/convex"),
            { recursive: true },
          );
          for (const [file, contents] of Rec.toEntries(files))
            yield* project.write(file, contents);
          yield* project.provide(generateWithSnapshot);
          const generated = yield* project.generatedFiles;
          const golden = Arr.join(
            Arr.map(
              Arr.sort(Rec.keys(generated), Str.Order),
              (file) =>
                `==> ${Str.replaceAll("\\", "/")(file)} <==\n${generated[file]}`,
            ),
            "\n",
          );
          yield* Effect.promise(() =>
            expect(golden).toMatchFileSnapshot(
              "./__goldens__/no-routes.golden",
            ),
          );
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );
  },
);
