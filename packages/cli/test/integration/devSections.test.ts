import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, layer } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Option from "effect/Option";
import { stringify } from "@confect/cli/Json";
import * as Project from "./Project";
import * as String from "effect/String";
import { pipe } from "effect/Function";

const success = "Generated files are up-to-date";

layer(NodeServices.layer, { excludeTestServices: true })(
  "built confect dev with fork sections",
  (it) => {
    it.effect(
      "preserves required middleware after a spec edit",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const project = yield* Project.make;
          yield* project.write(
            "confect/policy.ts",
            `import { MiddlewareSpec } from "@confect/core";
export class Policy extends MiddlewareSpec.MiddlewareSpec<Policy>()("Policy", { functionTypes: { query: true } }) {}`,
          );
          yield* project.write(
            "confect/app.ts",
            `import { App, Env } from "@confect/core";
import { Policy } from "./policy";
export default App.make({ env: Env.make("host", {}), requiresMiddleware: [Policy] });`,
          );
          const spec =
            'import { Policy } from "./policy";\n' +
            pipe(
              Project.spec,
              String.replace(
                "GroupSpec.make()",
                "GroupSpec.make().middleware(Policy)",
              ),
            );
          yield* project.write("confect/notes.spec.ts", spec);
          yield* project.write(
            "confect/notes.impl.ts",
            'import { MiddlewareImpl } from "@confect/server";\nimport { Policy } from "./policy";\n' +
              pipe(
                Project.impl,
                String.replace(
                  "GroupImpl.finalize);",
                  "Layer.provide(MiddlewareImpl.make(databaseSchema, Policy, effect => effect)), GroupImpl.finalize);",
                ),
              ),
          );
          const watching = yield* project.start("dev");
          yield* watching.waitFor(success);
          const registrationPath = `${project.root}/confect/_generated/registeredFunctions/notes.ts`;
          const required = 'GroupImpl.finalize({ required: [{ key: "Policy" }]';
          const registrationPathContents =
            yield* fs.readFileString(registrationPath);
          expect(registrationPathContents).toContain(required);
          yield* project.write(
            "confect/notes.spec.ts",
            `${spec}\nconsole.log("REQUIRED_SPEC_EDIT");\n`,
          );
          yield* watching.waitFor("REQUIRED_SPEC_EDIT");
          yield* watching.waitFor(success);
          const registrationPathContents2 =
            yield* fs.readFileString(registrationPath);
          expect(registrationPathContents2).toContain(required);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "stops the standby evaluator when its parent is killed",
      () =>
        Effect.gen(function* () {
          const project = yield* Project.make;
          const watching = yield* project.start("dev", [
            "--log-level",
            "debug",
          ]);
          yield* watching.waitFor(success);
          const isAlive = (pid: number) => {
            try {
              process.kill(pid, 0);
              return true;
            } catch (error) {
              if (
                error instanceof Error &&
                "code" in error &&
                error.code === "ESRCH"
              )
                return false;
              throw error;
            }
          };
          const standby = yield* Ref.get(watching.output).pipe(
            Effect.map((output) => {
              const matches = [
                ...pipe(
                  output,
                  String.matchAll(/Evaluator ready[^\n]*pid: (\d+)/g),
                ),
              ];
              const pid = Number(matches.at(-1)?.[1]);
              return Number.isInteger(pid) && isAlive(pid) ? pid : undefined;
            }),
            Effect.repeat({
              while: (pid) => pid === undefined,
              schedule: Schedule.spaced("20 millis"),
            }),
            Effect.timeout("10 seconds"),
          );
          assert(standby !== undefined);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              if (isAlive(standby)) process.kill(standby, "SIGKILL");
            }),
          );
          expect(isAlive(standby)).toBe(true);
          process.kill(watching.handle.pid, "SIGKILL");
          const exited = yield* Effect.sync(() => isAlive(standby)).pipe(
            Effect.repeat({
              while: (alive) => alive,
              schedule: Schedule.spaced("20 millis"),
            }),
            Effect.timeoutOption("5 seconds"),
          );
          expect(exited).toEqual(Option.some(false));
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );
    it.effect.each(["initial sync", "after a successful sync"] as const)(
      "reports a component Node group at %s and recovers when the group is removed",
      (when) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const project = yield* Project.makeNodeComponent;
          const nodeSpec = yield* fs.readFileString(
            `${project.root}/confect/tasks.spec.ts`,
          );
          const dependentSpec = `import { scope } from "./_generated/id";\nexport const componentScope = scope;\n${nodeSpec}`;
          yield* project.write(
            "confect/tasks.spec.ts",
            when === "initial sync"
              ? dependentSpec
              : pipe(
                  dependentSpec,
                  String.replace("makeNode()", "make()"),
                  String.replace("publicNodeAction", "publicAction"),
                ),
          );
          const watching = yield* project.start("dev", [
            "--component-dir",
            "convex",
          ]);
          if (when === "after a successful sync") {
            yield* watching.waitFor(success);
            yield* Effect.sleep("2 seconds");
            yield* Ref.set(watching.output, "");
            yield* project.write("confect/tasks.spec.ts", dependentSpec);
          }
          const message =
            'Group "tasks" in tasks.spec.ts uses the Node runtime. Convex components do not support Node.js functions.';
          yield* watching.waitFor(message);
          if (when === "initial sync") yield* watching.waitFor(message);
          const output2 = yield* Ref.get(watching.output);
          expect(output2).not.toContain(success);
          const output3 = yield* Ref.get(watching.output);
          expect(output3).toContain(
            "Restored generated output after rejecting the Node group.",
          );
          if (when === "initial sync") {
            const found = yield* fs.exists(
              `${project.root}/confect/_generated`,
            );
            expect(found).toBe(false);
          } else {
            const contents = yield* fs.readFileString(
              `${project.root}/confect/_generated/component.ts`,
            );
            expect(contents).toContain("$Component.contract($spec, $scope,");
          }
          const settled = yield* Ref.get(watching.output);
          yield* Effect.sleep("6 seconds");
          const output4 = yield* Ref.get(watching.output);
          expect(output4).toBe(settled);
          yield* fs.remove(`${project.root}/confect/tasks.spec.ts`);
          yield* fs.remove(`${project.root}/confect/tasks.impl.ts`);
          yield* watching.waitFor(success);
          const contents2 = yield* fs.readFileString(
            `${project.root}/confect/_generated/component.ts`,
          );
          expect(contents2).toContain("$Component.contract($spec, $scope,");
          const found2 = yield* fs.exists(`${project.root}/convex/tasks.ts`);
          expect(found2).toBe(false);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "re-emits the Convex config and manifest when a declaration file changes",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const project = yield* Project.make;
          const env = (variable: string) =>
            `import { Env } from "@confect/core";\nexport default Env.make("host", { ${variable}: Env.string() });\n`;
          yield* project.write("confect/env.ts", env("FIRST"));
          yield* project.write(
            "confect/app.ts",
            'import { App } from "@confect/core";\nimport env from "./env";\nexport default App.make({ env });\n',
          );
          const read = (file: string) =>
            fs.readFileString(path.join(project.root, file));
          const watching = yield* project.start("dev");
          yield* watching.waitFor(success);
          // Watchers start after the initial sync reports success; an edit
          // before they are up is not seen.
          yield* Effect.sleep("2 seconds");
          const convexConfig = yield* read("convex/convex.config.ts");
          expect(convexConfig).toContain("FIRST: v.string(),");
          yield* Ref.set(watching.output, "");
          yield* project.write("confect/env.ts", env("SECOND"));
          yield* watching.waitFor(success);
          const convexConfig2 = yield* read("convex/convex.config.ts");
          expect(convexConfig2).toContain("SECOND: v.string(),");
          const manifest = yield* read("confect/_generated/manifest.ts");
          expect(manifest).toContain('"SECOND": {');
          const auth = (applicationID: string) =>
            `import { Auth } from "@confect/core";\nimport app from "./app";\nexport default Auth.make(app, { providers: [{ domain: "https://login.example.test", applicationID: "${applicationID}" }] });\n`;
          yield* Ref.set(watching.output, "");
          yield* project.write("confect/auth.ts", auth("first"));
          yield* watching.waitFor(success);
          yield* Ref.set(watching.output, "");
          yield* project.write("confect/auth.ts", auth("second"));
          yield* watching.waitFor(success);
          const authConfig = yield* read("convex/auth.config.ts");
          expect(authConfig).toContain('applicationID: "second",');
          const settled = yield* Ref.get(watching.output);
          yield* Effect.sleep("2 seconds");
          const output2 = yield* Ref.get(watching.output);
          expect(output2).toBe(settled);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );
  },
);

layer(NodeServices.layer, { excludeTestServices: true })(
  "built confect dev with a generating manifest section",
  (it) => {
    const refusal = 'Manifest section "observe" is invalid: refused';
    const sectionProject = (log: string, helper: string) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const project = yield* Project.make;
        yield* fs.makeDirectory(`${project.root}/confect/billing`);
        yield* project.write(
          "confect/app.ts",
          'import { App, Env } from "@confect/core";\nimport { observe } from "./observe";\nexport default App.make({ env: Env.make("host", {}), manifestSections: [{ key: "observe", section: observe }] });\n',
        );
        yield* project.write(
          "confect/observe.ts",
          `const render = ({ modules }) => ({ contents: "export {};\\n", errors: modules[0].exports.valid ? [] : ["refused"] });
export const observe = { owner: "test/observe", format: 1, describe: () => null, generate: { file: "observe.ts", match: (path) => path.endsWith("/log.ts"), render } };`,
        );
        yield* project.write("confect/notes.spec.ts", Project.spec);
        yield* project.write("confect/billing/log.ts", log);
        yield* project.write("confect/billing/helper.ts", helper);
        return project;
      });

    it.effect(
      "regenerates once a refused matched file is fixed",
      () =>
        Effect.gen(function* () {
          const project = yield* sectionProject(
            "export const valid = false;\n",
            "export {};\n",
          );
          const watching = yield* project.start("dev");
          // Bootstrap retries a failed generation once.
          yield* watching.waitFor(refusal);
          yield* watching.waitFor(refusal);
          yield* project.write(
            "confect/billing/log.ts",
            "export const valid = true;\n",
          );
          yield* watching.waitFor(success);
          const fs = yield* FileSystem.FileSystem;
          const found = yield* fs.exists(
            `${project.root}/confect/_generated/observe.ts`,
          );
          expect(found).toBe(true);
        }).pipe(Effect.scoped),
      { timeout: 45000 },
    );

    it.effect(
      "regenerates once a module that threw on first load is fixed",
      () =>
        Effect.gen(function* () {
          const project = yield* sectionProject(
            'export { valid } from "./helper";\n',
            'throw new Error("helper failed to load");\n',
          );
          const watching = yield* project.start("dev");
          yield* watching.waitFor("helper failed to load");
          yield* watching.waitFor("helper failed to load");
          yield* project.write(
            "confect/billing/helper.ts",
            "export const valid = true;\n",
          );
          yield* watching.waitFor(success);
        }).pipe(Effect.scoped),
      { timeout: 45000 },
    );

    it.effect(
      "verifies again when a matched implementation changes",
      () =>
        Effect.gen(function* () {
          const project = yield* Project.make;
          yield* project.write(
            "confect/app.ts",
            'import { App, Env } from "@confect/core";\nimport { doors } from "./doors";\nexport default App.make({ env: Env.make("host", {}), manifestSections: [{ key: "doors", section: doors }] });\n',
          );
          yield* project.write(
            "confect/doors.ts",
            `export const doors = { owner: "test/doors", format: 1, describe: () => null, generate: { file: "doors.ts", match: () => false, render: () => ({ contents: "export {};\\n", errors: [] }), verify: { match: (path) => path === "notes.impl.ts", check: ({ modules }) => modules[0].exports.allowed ? [] : ["impl denied"] } } };`,
          );
          const impl = (allowed: boolean) =>
            project.write(
              "confect/notes.impl.ts",
              `${Project.impl}export const allowed = ${allowed};\n`,
            );
          yield* impl(true);
          const watching = yield* project.start("dev");
          yield* watching.waitFor(success);
          yield* impl(false);
          yield* watching.waitFor("impl denied");
          yield* impl(true);
          yield* watching.waitFor(success);
        }).pipe(Effect.scoped),
      { timeout: 45000 },
    );

    it.effect(
      "hands render and verify each function's spec as the object a matched module imports in an incremental run",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const project = yield* Project.make;
          yield* Project.writeAuthz(project.root, {
            component: false,
            node: false,
            check:
              '(named) => named.includes("unnamed") ? [`unnamed ${named}`] : []',
          });
          // No matched file imports `tasks`, so an edit to its spec takes the
          // incremental run rather than a full one.
          yield* project.write("confect/tasks.spec.ts", Project.spec);
          yield* project.write(
            "confect/tasks.impl.ts",
            pipe(
              Project.impl,
              String.replace('from "./notes.spec"', 'from "./tasks.spec"'),
            ),
          );
          const generated = `${project.root}/confect/_generated/authz.ts`;
          const named = `export default ${stringify({
            "permissions/direct.ts": ["notes:list"],
            "permissions/indirect.ts": ["notes:list"],
          })};`;
          const watching = yield* project.start("dev");
          yield* watching.waitFor(success);
          const first = yield* fs.readFileString(generated);
          expect(first).toContain(named);
          // Watchers start after the initial sync reports success; an edit
          // before they are up is not seen.
          yield* Effect.sleep("2 seconds");
          yield* fs.remove(generated);
          yield* project.write(
            "confect/tasks.spec.ts",
            `${Project.spec}\nconsole.log("AUTHZ_SPEC_EDIT");\n`,
          );
          yield* watching.waitFor("AUTHZ_SPEC_EDIT");
          yield* watching.waitFor(success);
          const output = yield* Ref.get(watching.output);
          expect(output).not.toContain("unnamed");
          const edited = yield* fs.readFileString(generated);
          expect(edited).toContain(named);
        }).pipe(Effect.scoped),
      { timeout: 45000 },
    );

    it.effect(
      "renders again when a module a matched file imports changes",
      () =>
        Effect.gen(function* () {
          const project = yield* sectionProject(
            'export { valid } from "./helper";\n',
            "export const valid = true;\n",
          );
          const watching = yield* project.start("dev");
          yield* watching.waitFor(success);
          yield* project.write(
            "confect/billing/helper.ts",
            "export const valid = false;\n",
          );
          yield* watching.waitFor(refusal);
        }).pipe(Effect.scoped),
      { timeout: 45000 },
    );

    it.effect(
      "keeps crons wrapped through crons.ts edits and rewrites the entry when the section stops wrapping",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const project = yield* Project.make;
          const declare = (wraps: boolean) =>
            project.write(
              "confect/authz.ts",
              `export const authz = { owner: "test/authz", format: 1, describe: () => null, generate: { file: "authz.ts", match: () => false, render: () => ({ contents: "export const crons = (jobs) => jobs;\\n", errors: [] }), wrapsCrons: ${wraps} } };`,
            );
          yield* declare(true);
          yield* project.write(
            "confect/app.ts",
            `import { App, Env } from "@confect/core";
import { authz } from "./authz";
export default App.make({ env: Env.make("host", {}), manifestSections: [{ key: "authz", section: authz }] });`,
          );
          const crons =
            'import { CronJobs } from "@confect/server";\nexport default CronJobs.make();\n';
          yield* project.write("confect/crons.ts", crons);
          const entry = `${project.root}/convex/crons.ts`;
          const wrapper =
            'import { crons as wrap0 } from "../confect/_generated/authz.js";';
          const watching = yield* project.start("dev");
          yield* watching.waitFor(success);
          const started = yield* fs.readFileString(entry);
          expect(started).toContain(wrapper);
          yield* project.write("confect/crons.ts", `${crons}// An edit.\n`);
          yield* watching.waitFor(success);
          const edited = yield* fs.readFileString(entry);
          expect(edited).toContain(wrapper);
          yield* fs.remove(`${project.root}/confect/crons.ts`);
          yield* watching.waitFor(success);
          const kept = yield* fs.exists(entry);
          expect(kept).toBe(false);
          yield* project.write("confect/crons.ts", crons);
          yield* watching.waitFor(success);
          const restored = yield* fs.readFileString(entry);
          expect(restored).toContain(wrapper);
          yield* declare(false);
          yield* watching.waitFor(success);
          const unwrapped = yield* fs.readFileString(entry);
          expect(unwrapped).toBe(
            'import crons from "../confect/crons.js";\n\nexport default crons.convexCronJobs;\n',
          );
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );

    it.effect(
      "keeps the schema wrapped through table and spec edits, adds a new table inside the wrap, and rewrites the schema when the section stops or starts wrapping",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const project = yield* Project.make;
          const declare = (wraps: boolean) =>
            project.write(
              "confect/prelude.ts",
              `const contents = 'import { Table } from "@confect/server";\\nexport const tables = (confect) => Object.fromEntries(Object.entries(confect).map(([name, table]) => [name, Table.tableDefinition(table)]));\\n';
export const prelude = { owner: "test/prelude", format: 1, describe: () => null, generate: { file: "prelude.ts", match: () => false, render: () => ({ contents, errors: [] }), importedFirst: true, wrapsSchema: ${wraps} } };`,
            );
          yield* declare(true);
          yield* project.write(
            "confect/app.ts",
            `import { App, Env } from "@confect/core";
import { prelude } from "./prelude";
export default App.make({ env: Env.make("host", {}), manifestSections: [{ key: "prelude", section: prelude }] });`,
          );
          const schemaPath = `${project.root}/confect/_generated/convexSchema.ts`;
          const wrapped = (tables: ReadonlyArray<string>) =>
            `import { tables as $tables } from "./prelude.js";\nimport { defineSchema as $defineSchema } from "convex/server";\n\n${Arr.join(
              Arr.map(
                tables,
                (table) => `import ${table} from "./tables/${table}.js";\n`,
              ),
              "",
            )}\nexport default $defineSchema($tables({\n${Arr.join(
              Arr.map(tables, (table) => `  ${table},\n`),
              "",
            )}}));\n`;
          const watching = yield* project.start("dev");
          yield* watching.waitFor(success);
          const started = yield* fs.readFileString(schemaPath);
          expect(started).toBe(wrapped(["notes"]));
          // Watchers start after the initial sync reports success; an edit
          // before they are up is not seen.
          yield* Effect.sleep("2 seconds");
          yield* project.write(
            "confect/tables/notes.ts",
            `${Project.table}console.log("WRAP_TABLE_EDIT");\n`,
          );
          yield* watching.waitFor("WRAP_TABLE_EDIT");
          yield* watching.waitFor(success);
          const afterTable = yield* fs.readFileString(schemaPath);
          expect(afterTable).toBe(wrapped(["notes"]));
          yield* project.write(
            "confect/notes.spec.ts",
            `${Project.spec}\nconsole.log("WRAP_SPEC_EDIT");\n`,
          );
          yield* watching.waitFor("WRAP_SPEC_EDIT");
          yield* watching.waitFor(success);
          const afterSpec = yield* fs.readFileString(schemaPath);
          expect(afterSpec).toBe(wrapped(["notes"]));
          yield* project.write(
            "confect/tables/tags.ts",
            `import { Table } from "@confect/core";
import * as Schema from "effect/Schema";
export default Table.make(() => Schema.Struct({ name: Schema.String }));
`,
          );
          yield* watching.waitFor(success);
          const added = yield* fs.readFileString(schemaPath);
          expect(added).toBe(wrapped(["notes", "tags"]));
          const registration = yield* fs.readFileString(
            `${project.root}/confect/_generated/registeredFunctions/notes.ts`,
          );
          expect(pipe(registration, String.split("\n"))[0]).toBe(
            'import "../prelude.js";',
          );
          yield* declare(false);
          yield* watching.waitFor(success);
          const unwrapped = yield* fs.readFileString(schemaPath);
          expect(unwrapped).toContain("notes: $Table.tableDefinition(notes),");
          expect(unwrapped).not.toContain("prelude");
          yield* declare(true);
          yield* watching.waitFor(success);
          const rewrapped = yield* fs.readFileString(schemaPath);
          expect(rewrapped).toBe(wrapped(["notes", "tags"]));
        }).pipe(Effect.scoped),
      { timeout: 90000 },
    );

    it.effect(
      "rewrites a crons.ts with reordered or stale wrappers on its first run and on a crons.ts edit",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const project = yield* Project.make;
          yield* project.write(
            "confect/authz.ts",
            'export const authz = { owner: "test/authz", format: 1, describe: () => null, generate: { file: "authz.ts", match: () => false, render: () => ({ contents: "export const crons = (jobs) => jobs;\\n", errors: [] }), wrapsCrons: true } };',
          );
          yield* project.write(
            "confect/app.ts",
            `import { App, Env } from "@confect/core";
import { authz } from "./authz";
export default App.make({ env: Env.make("host", {}), manifestSections: [{ key: "authz", section: authz }] });`,
          );
          const crons =
            'import { CronJobs } from "@confect/server";\nexport default CronJobs.make();\n';
          yield* project.write("confect/crons.ts", crons);
          const entry = (keys: ReadonlyArray<string>) =>
            `// Generated by \`confect codegen\` from confect/crons.ts. Do not edit.\nimport type { CronJobs } from "@confect/server";\n${Arr.join(
              Arr.map(
                keys,
                (key, index) =>
                  `import { crons as wrap${index} } from "../confect/_generated/${key}.js";\n`,
              ),
              "",
            )}import crons from "../confect/crons.js";\n\nconst wraps: ReadonlyArray<(crons: CronJobs.CronJobs) => CronJobs.CronJobs> = [${Arr.join(
              Arr.map(keys, (_, index) => `wrap${index}`),
              ", ",
            )}];\n\nexport default wraps.reduce<CronJobs.CronJobs>((jobs, wrap) => wrap(jobs), crons).convexCronJobs;\n`;
          const loosen = Effect.all([
            fs.makeDirectory(`${project.root}/confect/_generated`, {
              recursive: true,
            }),
            project.write(
              "confect/_generated/stale.ts",
              '// Generated by `confect codegen` from the manifest section "stale". Do not edit.\nexport const crons = (jobs) => jobs;\n',
            ),
            project.write("convex/crons.ts", entry(["stale", "authz"])),
          ]);
          yield* loosen;
          const watching = yield* project.start("dev");
          yield* watching.waitFor(success);
          const started = yield* fs.readFileString(
            `${project.root}/convex/crons.ts`,
          );
          expect(started).toBe(entry(["authz"]));
          yield* loosen;
          yield* project.write("confect/crons.ts", `${crons}// An edit.\n`);
          yield* watching.waitFor(success);
          const edited = yield* fs.readFileString(
            `${project.root}/convex/crons.ts`,
          );
          expect(edited).toBe(entry(["authz"]));
        }).pipe(Effect.scoped),
      { timeout: 60000 },
    );
  },
);

layer(NodeServices.layer, { excludeTestServices: true })(
  "built confect commands with a section that reads the deployment kind",
  (it) => {
    // Unsets any deployment variables the test runner's own shell sets.
    const noAmbient = {
      CONFECT_DEPLOYMENT_KIND: undefined,
      CONVEX_DEPLOY_KEY: undefined,
      CONVEX_DEPLOYMENT_TOKEN: undefined,
      CONVEX_DEPLOYMENT: undefined,
      CONVEX_SELF_HOSTED_URL: undefined,
      CONVEX_SELF_HOSTED_ADMIN_KEY: undefined,
    };
    const issuerProject = (envLocal: string | undefined) =>
      Effect.gen(function* () {
        const project = yield* Project.make;
        yield* project.write(
          "confect/app.ts",
          'import { App, Env } from "@confect/core";\nimport { issuer } from "./issuer";\nexport default App.make({ env: Env.make("host", {}), manifestSections: [{ key: "issuer", section: issuer }] });\n',
        );
        yield* project.write(
          "confect/issuer.ts",
          `const render = ({ deployment }) => ({ contents: \`export const deployment = \${JSON.stringify(deployment)};\\n\`, errors: [] });
const check = ({ deployment }) => deployment === "local" ? [] : [\`a test issuer needs a local deployment, not \${deployment}\`];
export const issuer = { owner: "test/issuer", format: 1, describe: () => null, generate: { file: "issuer.ts", match: () => false, render, verify: { match: () => false, check } } };`,
        );
        if (envLocal !== undefined)
          yield* project.write(".env.local", envLocal);
        return project;
      });

    it.effect(
      "hands the kind .env.local selects to the first sync and to a spec edit",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const project = yield* issuerProject(
            "CONVEX_DEPLOYMENT=local:confect-test\n",
          );
          const watching = yield* project.start("dev", [], noAmbient);
          yield* watching.waitFor(success);
          const rendered = yield* fs.readFileString(
            `${project.root}/confect/_generated/issuer.ts`,
          );
          expect(rendered).toContain('export const deployment = "local";');
          // Watchers start after the initial sync reports success; an edit
          // before they are up is not seen.
          yield* Effect.sleep("2 seconds");
          yield* Ref.set(watching.output, "");
          yield* project.write(
            "confect/notes.spec.ts",
            `${Project.spec}\nconsole.log("KIND_SPEC_EDIT");\n`,
          );
          yield* watching.waitFor("KIND_SPEC_EDIT");
          yield* watching.waitFor(success);
          const output = yield* Ref.get(watching.output);
          expect(output).not.toContain("a test issuer needs");
        }).pipe(Effect.scoped),
      { timeout: 45000 },
    );

    it.effect.each([
      ["the kind .env.local selects", "local:confect-test", [], {}, undefined],
      [
        "the kind it is given over .env.local",
        "local:confect-test",
        ["--deployment-kind", "cloud"],
        {},
        "not cloud",
      ],
      [
        "the kind CONFECT_DEPLOYMENT_KIND gives over .env.local",
        "local:confect-test",
        [],
        { CONFECT_DEPLOYMENT_KIND: "cloud" },
        "not cloud",
      ],
      [
        "unknown when the flag and CONFECT_DEPLOYMENT_KIND disagree",
        "local:confect-test",
        ["--deployment-kind", "local"],
        { CONFECT_DEPLOYMENT_KIND: "cloud" },
        "not unknown",
      ],
      [
        "unknown when an empty variable hides .env.local",
        "local:confect-test",
        [],
        { CONVEX_DEPLOYMENT: "" },
        "not unknown",
      ],
      ["unknown without any signal", undefined, [], {}, "not unknown"],
    ] as const)(
      "codegen hands verify %s",
      ([, deployment, args, env, refusal]) =>
        Effect.gen(function* () {
          const project = yield* issuerProject(
            deployment === undefined
              ? undefined
              : `CONVEX_DEPLOYMENT=${deployment}\n`,
          );
          const generated = yield* project.start("codegen", args, {
            ...noAmbient,
            ...env,
          });
          const exitCode = yield* generated.handle.exitCode;
          const output = yield* Ref.get(generated.output);
          if (refusal === undefined) expect(exitCode, output).toBe(0);
          else {
            expect(exitCode, output).not.toBe(0);
            expect(output).toContain(
              `a test issuer needs a local deployment, ${refusal}`,
            );
          }
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );
  },
);
