import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Option from "effect/Option";
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
  },
);
