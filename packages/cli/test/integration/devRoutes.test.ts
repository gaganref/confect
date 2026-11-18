import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Project from "./Project";

const success = "Generated files are up-to-date";

type Backend = "app" | "component";

interface Route {
  readonly name: string;
  readonly method: string;
  readonly path: string;
}

const app = (backend: Backend) => `import { App, Env } from "@confect/core";
export default App.make({ ${backend === "component" ? 'kind: "component", ' : ""}env: Env.make("routed", {}) });
`;

const http = (
  guard: string,
  marker: string,
) => `import { Guard, Http } from "@confect/core";
export const guard = ${guard};
console.log("${marker}");
export default Http.make({ ${guard === "undefined" ? "" : "guard"} });
`;

const echoSpec = (
  routes: ReadonlyArray<Route>,
  marker: string,
) => `import { FunctionSpec, GroupSpec } from "@confect/core";
import * as Schema from "effect/Schema";
import { echoArgs } from "./schemas/echo";
console.log("${marker}");
export default GroupSpec.make()${Arr.join(
  Arr.map(
    routes,
    ({ name, method, path }) =>
      `.addFunction(FunctionSpec.httpAction({ name: "${name}", method: "${method}", path: "${path}", args: () => echoArgs, returns: () => Schema.String }))`,
  ),
  "",
)};
`;

const echoImpl = (
  routes: ReadonlyArray<Route>,
) => `import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import databaseSchema from "./_generated/schema";
import echo from "./echo.spec";
export default GroupImpl.make(databaseSchema, echo).pipe(${Arr.join(
  Arr.map(
    routes,
    ({ name }) =>
      `Layer.provide(FunctionImpl.make(databaseSchema, echo, "${name}", () => Effect.succeed("said"))), `,
  ),
  "",
)}GroupImpl.finalize);
`;

const echoSchema = (fields: string, marker: string) =>
  `import * as Schema from "effect/Schema";
console.log("${marker}");
export const echoArgs = { ${fields} };
`;

const notesSchema = (fields: string, marker: string) =>
  `import * as Schema from "effect/Schema";
console.log("${marker}");
export const listArgs = { ${fields} };
`;

const notesSpec = pipe(
  Project.spec,
  Str.replace(
    'import notes from "./_generated/tables/notes";',
    'import notes from "./_generated/tables/notes";\nimport { listArgs } from "./schemas/notes";',
  ),
  Str.replace('name: "list",', 'name: "list", args: () => listArgs,'),
);

const say: Route = { name: "say", method: "POST", path: "/echo" };

/**
 * Every file under `confect/_generated` and `convex`, by its path from the
 * project root, with its text and modification time.
 */
const generated = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const files = yield* Effect.forEach(
      ["confect/_generated", "convex"],
      (directory) =>
        Effect.flatMap(
          fs.readDirectory(path.join(root, directory), { recursive: true }),
          (entries) =>
            Effect.forEach(entries, (entry) => {
              const file = path.join(directory, entry);
              return Effect.flatMap(fs.stat(path.join(root, file)), (info) =>
                info.type === "File"
                  ? Effect.map(
                      fs.readFileString(path.join(root, file)),
                      (text) => [
                        [
                          file,
                          {
                            text,
                            modified: Option.getOrUndefined(info.mtime),
                          },
                        ] as const,
                      ],
                    )
                  : Effect.succeed([]),
              );
            }),
        ),
    );
    return Rec.fromEntries(Arr.flatten(Arr.flatten(files)));
  });

const texts = (files: Record<string, { readonly text: string }>) =>
  Rec.map(files, ({ text }) => text);

/**
 * The operations the dev loop planned in this output, in order.
 */
const operations = (output: string) =>
  Arr.map(
    Arr.fromIterable(
      pipe(
        output,
        Str.matchAll(/Planned development sync .*operation: '(\w+)'/g),
      ),
    ),
    (match) => match[1],
  );

const routedProject = (backend: Backend) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const make = Effect.gen(function* () {
      const project = yield* Project.make;
      yield* fs.makeDirectory(path.join(project.root, "confect", "schemas"));
      if (backend === "component")
        yield* project.write(
          "package.json",
          '{"name":"@fx/routed","type":"module"}',
        );
      return project;
    });
    const project = yield* make;
    yield* project.write("confect/app.ts", app(backend));
    yield* project.write("confect/http.ts", http("Guard.none", "HTTP:0"));
    yield* project.write(
      "confect/schemas/echo.ts",
      echoSchema("text: Schema.String", "ECHO_SCHEMA:0"),
    );
    yield* project.write(
      "confect/schemas/notes.ts",
      notesSchema("", "NOTES_SCHEMA:0"),
    );
    yield* project.write("confect/notes.spec.ts", notesSpec);
    yield* project.write("confect/echo.impl.ts", echoImpl([say]));
    yield* project.write("confect/echo.spec.ts", echoSpec([say], "ECHO:0"));
    const args = backend === "component" ? ["--component-dir", "convex"] : [];
    const watching = yield* project.start("dev", [
      ...args,
      "--log-level",
      "debug",
    ]);
    yield* watching.waitFor(success);

    /**
     * What a fresh `confect codegen` writes from this project's sources, in a
     * project that has never been generated.
     */
    const fresh = Effect.gen(function* () {
      const other = yield* make;
      const sources = yield* fs.readDirectory(
        path.join(project.root, "confect"),
        { recursive: true },
      );
      for (const source of sources) {
        if (pipe(source, Str.split(path.sep)).includes("_generated")) continue;
        const from = path.join(project.root, "confect", source);
        if ((yield* fs.stat(from)).type !== "File") continue;
        yield* fs.makeDirectory(
          path.dirname(path.join(other.root, "confect", source)),
          { recursive: true },
        );
        yield* fs.copyFile(from, path.join(other.root, "confect", source));
      }
      const once = yield* other.start("codegen", args);
      yield* once.waitFor(success);
      const exitCode = yield* once.handle.exitCode;
      expect(Number(exitCode)).toBe(0);
      const files = yield* generated(other.root);
      return texts(files);
    });

    /**
     * Apply an edit, wait for the watcher to settle on it, and return the
     * operations it planned and the files it left.
     */
    const edit = (
      files: ReadonlyArray<readonly [string, string]>,
      marker: string,
      settled: string = success,
    ) =>
      Effect.gen(function* () {
        yield* Ref.set(watching.output, "");
        for (const [file, text] of files) yield* project.write(file, text);
        yield* watching.waitFor(marker);
        yield* watching.waitFor(settled);
        const output = yield* Ref.get(watching.output);
        return {
          planned: operations(output),
          files: yield* generated(project.root),
        };
      });

    const routes = (list: ReadonlyArray<Route>, marker: string) =>
      edit(
        [
          ["confect/echo.impl.ts", echoImpl(list)],
          ["confect/echo.spec.ts", echoSpec(list, marker)],
        ],
        marker,
      );

    return { project, fresh, edit, routes };
  });

const OpenApiPaths = Schema.fromJsonString(
  Schema.Struct({
    paths: Schema.Record(
      Schema.String,
      Schema.Record(Schema.String, Schema.Unknown),
    ),
  }),
);

const openApiPaths = (files: Record<string, { readonly text: string }>) =>
  Option.match(
    Option.fromUndefinedOr(files["confect/_generated/openapi.json"]),
    {
      onNone: () => Effect.undefined,
      onSome: ({ text }) =>
        Effect.map(Schema.decodeEffect(OpenApiPaths)(text), (document) =>
          Rec.map(document.paths, Rec.keys),
        ),
    },
  );

layer(NodeServices.layer, { excludeTestServices: true })(
  "built confect dev with route specs",
  (it) => {
    it.effect.each(["app", "component"] as const)(
      "keeps a %s's route files equal to a fresh full run's through each route edit, without a full run",
      (backend) =>
        Effect.gen(function* () {
          const { fresh, routes } = yield* routedProject(backend);
          const shout: Route = {
            name: "shout",
            method: "POST",
            path: "/shout",
          };
          const steps = [
            { edit: "add a route", list: [say, shout] },
            {
              edit: "edit its path",
              list: [say, { ...shout, path: "/yell" }],
            },
            {
              edit: "edit its method",
              list: [say, { ...shout, path: "/yell", method: "PUT" }],
            },
            {
              edit: "rename it",
              list: [say, { name: "holler", method: "PUT", path: "/yell" }],
            },
          ];
          for (const [index, step] of steps.entries()) {
            const { planned, files } = yield* routes(
              step.list,
              `ECHO:${index + 1}`,
            );
            const paths = yield* openApiPaths(files);
            expect(
              {
                edit: step.edit,
                full: planned.includes("Generate"),
                paths,
                files: texts(files),
              },
              step.edit,
            ).toEqual({
              edit: step.edit,
              full: false,
              paths: Rec.fromEntries(
                Arr.map(step.list, (route) => [
                  route.path,
                  [Str.toLowerCase(route.method)],
                ]),
              ),
              files: yield* fresh,
            });
          }
          const removed = yield* routes([], "ECHO:last");
          expect({
            full: removed.planned.includes("Generate"),
            routes: Rec.has(removed.files, "confect/_generated/routes.ts"),
            openApi: Rec.has(removed.files, "confect/_generated/openapi.json"),
            files: texts(removed.files),
          }).toEqual({
            full: false,
            routes: false,
            openApi: false,
            files: yield* fresh,
          });
        }).pipe(Effect.scoped),
      { timeout: 240000 },
    );

    it.effect.each(["app", "component"] as const)(
      "refreshes a %s's openapi.json for a schema a route uses, and leaves every route file untouched for one it doesn't",
      (backend) =>
        Effect.gen(function* () {
          const { fresh, edit } = yield* routedProject(backend);
          const used = yield* edit(
            [
              [
                "confect/schemas/echo.ts",
                echoSchema(
                  "text: Schema.String, loud: Schema.Boolean",
                  "ECHO_SCHEMA:1",
                ),
              ],
            ],
            "ECHO_SCHEMA:1",
          );
          const openApi = used.files["confect/_generated/openapi.json"]?.text;
          expect({
            full: used.planned.includes("Generate"),
            loud: pipe(openApi ?? "", Str.includes('"loud"')),
            files: texts(used.files),
          }).toEqual({ full: false, loud: true, files: yield* fresh });
          const unused = yield* edit(
            [
              [
                "confect/schemas/notes.ts",
                notesSchema(
                  "limit: Schema.optionalKey(Schema.Number)",
                  "NOTES_SCHEMA:1",
                ),
              ],
            ],
            "NOTES_SCHEMA:1",
          );
          const routeFiles = [
            "confect/_generated/routes.ts",
            "confect/_generated/openapi.json",
            "convex/http.ts",
          ];
          expect({
            full: unused.planned.includes("Generate"),
            untouched: Arr.map(routeFiles, (file) => unused.files[file]),
            files: texts(unused.files),
          }).toEqual({
            full: false,
            untouched: Arr.map(routeFiles, (file) => used.files[file]),
            files: yield* fresh,
          });
        }).pipe(Effect.scoped),
      { timeout: 120000 },
    );

    it.effect.each(["app", "component"] as const)(
      "follows a %s's guard in confect/http.ts, refusing routes without one and recovering",
      (backend) =>
        Effect.gen(function* () {
          const { fresh, edit } = yield* routedProject(backend);
          const named = yield* edit(
            [
              [
                "confect/http.ts",
                http('Guard.make("probe", (inner) => inner)', "HTTP:1"),
              ],
            ],
            "HTTP:1",
          );
          const afterNamed = yield* fresh;
          expect(texts(named.files)).toEqual(afterNamed);
          yield* edit(
            [["confect/http.ts", http("undefined", "HTTP:2")]],
            "HTTP:2",
            "is a route spec, so it needs a guard",
          );
          const restored = yield* edit(
            [["confect/http.ts", http("Guard.none", "HTTP:3")]],
            "HTTP:3",
          );
          const afterRestored = yield* fresh;
          expect(texts(restored.files)).toEqual(afterRestored);
        }).pipe(Effect.scoped),
      { timeout: 120000 },
    );
  },
);
