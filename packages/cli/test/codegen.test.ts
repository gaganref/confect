import { Table } from "@confect/core";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { assert, expect, layer } from "@effect/vitest";
import { vi } from "vitest";
import * as esbuild from "esbuild";
import * as Bundler from "@confect/cli/Bundler";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as String from "effect/String";
import {
  codegenHandler,
  generateWithSnapshot,
  updateDeclarations,
} from "@confect/cli/confect/codegen";
import * as GenerationSnapshot from "@confect/cli/GenerationSnapshot";
import { SpecModulePath } from "@confect/cli/SpecModulePath";
import { TableModulePath } from "@confect/cli/TableModulePath";
import { ImplModulePath } from "@confect/cli/ImplModulePath";
import { ConfectDirectory } from "@confect/cli/ConfectDirectory";
import { ConvexDirectory } from "@confect/cli/ConvexDirectory";
import { ProjectRoot } from "@confect/cli/ProjectRoot";
import {
  discover as discoverTables,
  validate as validateTables,
} from "@confect/cli/TableModule";
import {
  HandWrittenConvexFileError,
  InvalidDeclarationError,
} from "@confect/cli/CodegenError";
import * as Project from "./integration/Project";

vi.mock("esbuild", (importOriginal) =>
  importOriginal<typeof esbuild>().then((original) => ({
    ...original,
    build: vi.fn(original.build),
  })),
);

layer(Layer.mergeAll(NodePath.layer, NodeFileSystem.layer))(
  "codegenHandler",
  (it) => {
    it.effect.each([
      "schema.spec.ts",
      "http.spec.ts",
      "crons.spec.ts",
      "bad-dir/notes.spec.ts",
      "notes/bad-name.spec.ts",
      "notes/..spec.ts",
      "notes/...spec.ts",
    ])(
      "rejects invalid group path %s before replacing the Convex schema",
      (file) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const project = yield* Project.make;
          yield* fs.makeDirectory(
            path.dirname(path.join(project.root, "confect", file)),
            { recursive: true },
          );
          const prefix = "../".repeat(file.split("/").length - 1) || "./";
          const name = path.basename(file, ".spec.ts");
          yield* project.write(
            `confect/${file}`,
            Project.spec.replaceAll('"./_generated/', `"${prefix}_generated/`),
          );
          yield* project.write(
            `confect/${file.replace(/\.spec\.ts$/, ".impl.ts")}`,
            Project.impl
              .replaceAll('"./_generated/', `"${prefix}_generated/`)
              .replace('"./notes.spec"', `"./${name}.spec"`),
          );
          const previousSchema = "export default {};\n";
          yield* project.write("convex/schema.ts", previousSchema);
          const result = yield* project
            .provide(codegenHandler)
            .pipe(Effect.result);
          assert(Result.isFailure(result));
          expect(result.failure).toMatchObject({
            _tag: "SnapshotError",
            reason: "NoncanonicalPath",
            relativePath: file,
          });
          expect(
            yield* fs.readFileString(
              path.join(project.root, "convex/schema.ts"),
            ),
          ).toBe(previousSchema);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "notifies Convex after explicit codegen even when generated contents are unchanged",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const project = yield* Project.make;
          yield* project.provide(codegenHandler);
          const before = yield* project.generatedFiles;
          const schema = path.join(project.root, "convex/schema.ts");
          const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe(1000));
          yield* fs.utimes(schema, timestamp, timestamp);
          yield* TestClock.setTime(2000);
          expect(
            yield* Project.writtenFiles(project.provide(codegenHandler)),
          ).toEqual([]);
          expect(yield* project.generatedFiles).toEqual(before);
          expect(
            Option.getOrThrow((yield* fs.stat(schema)).mtime).getTime(),
          ).toBe(2000);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "updates a spec without evaluating unrelated modules and matches full generation",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const project = yield* Project.make;
          yield* project.write("confect/other.spec.ts", Project.spec);
          yield* project.write(
            "confect/other.impl.ts",
            Project.impl.replace('"./notes.spec"', '"./other.spec"'),
          );
          const { snapshot } = yield* project.provide(generateWithSnapshot);
          yield* project.write(
            "confect/notes.spec.ts",
            Project.spec.replace('name: "list"', 'name: "latest"'),
          );
          yield* project.write(
            "confect/notes.impl.ts",
            Project.impl.replace('"list"', '"latest"'),
          );
          const bundle = yield* Effect.acquireRelease(
            Effect.sync(() => vi.spyOn(Bundler, "bundle")),
            (spy) => Effect.sync(() => spy.mockRestore()),
          );
          const next = yield* project.provide(
            updateDeclarations(
              snapshot,
              [
                {
                  _tag: "Spec",
                  relativePath: SpecModulePath.make("notes.spec.ts"),
                },
              ],
              [],
            ),
          );
          expect(
            bundle.mock.calls.map(([entry]) =>
              path.relative(project.root, entry),
            ),
          ).toEqual([
            path.join("confect", "notes.spec.ts"),
            path.join("confect", "notes.impl.ts"),
          ]);
          expect(
            [...GenerationSnapshot.functionPaths(next)]
              .map((fn) => fn.name)
              .sort(),
          ).toEqual(["latest", "list"]);
          expect(
            [...GenerationSnapshot.functionPaths(snapshot)].map(
              (fn) => fn.name,
            ),
          ).toEqual(["list", "list"]);
          const incremental = yield* project.generatedFiles;
          expect(
            yield* Project.writtenFiles(project.provide(codegenHandler)),
          ).toEqual([]);
          expect(yield* project.generatedFiles).toEqual(incremental);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "checks global parent collisions before validating an updated implementation",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const project = yield* Project.make;
          yield* fs.makeDirectory(path.join(project.root, "confect", "notes"));
          yield* project.write(
            "confect/notes/archived.spec.ts",
            Project.spec.replace('"./_generated/', '"../_generated/'),
          );
          yield* project.write(
            "confect/notes/archived.impl.ts",
            Project.impl
              .replaceAll('"./_generated/', '"../_generated/')
              .replace('"./notes.spec"', '"./archived.spec"'),
          );
          const { snapshot } = yield* project.provide(generateWithSnapshot);
          const before = yield* project.generatedFiles;
          yield* project.write(
            "confect/notes.spec.ts",
            Project.spec.replace('name: "list"', 'name: "archived"'),
          );
          const result = yield* project
            .provide(
              updateDeclarations(
                snapshot,
                [
                  {
                    _tag: "Spec",
                    relativePath: SpecModulePath.make("notes.spec.ts"),
                  },
                ],
                [],
              ),
            )
            .pipe(Effect.result);
          assert(Result.isFailure(result));
          expect(result.failure).toMatchObject({
            _tag: "ParentChildNameCollisionError",
            parentSpecPath: "notes.spec.ts",
            childSpecPath: "notes/archived.spec.ts",
            collisionName: "archived",
          });
          expect(yield* project.generatedFiles).toEqual(before);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "updates runtime and removes the last function with fresh-generation parity",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const project = yield* Project.make;
          let { snapshot } = yield* project.provide(generateWithSnapshot);
          yield* project.write(
            "confect/notes.spec.ts",
            Project.spec
              .replace("GroupSpec.make()", "GroupSpec.makeNode()")
              .replace(
                "FunctionSpec.publicQuery",
                "FunctionSpec.publicNodeAction",
              ),
          );
          yield* project.write(
            "confect/notes.impl.ts",
            `import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import schema from "./_generated/schema";
import spec from "./notes.spec";
export default GroupImpl.make(schema, spec).pipe(Layer.provide(FunctionImpl.make(schema, spec, "list", () => Effect.succeed([]))), GroupImpl.finalize);
`,
          );
          snapshot = yield* project.provide(
            updateDeclarations(
              snapshot,
              [
                {
                  _tag: "Spec",
                  relativePath: SpecModulePath.make("notes.spec.ts"),
                },
              ],
              [],
            ),
          );
          const nodeOutputs = yield* project.generatedFiles;
          expect(nodeOutputs[path.join("convex", "notes.ts")]).toContain(
            '"use node"',
          );
          expect(
            yield* Project.writtenFiles(project.provide(codegenHandler)),
          ).toEqual([]);
          expect(yield* project.generatedFiles).toEqual(nodeOutputs);
          yield* project.write(
            "confect/notes.spec.ts",
            'import { GroupSpec } from "@confect/core"; export default GroupSpec.makeNode();\n',
          );
          yield* project.write("confect/notes.impl.ts", Project.emptyImpl);
          const empty = yield* project.provide(
            updateDeclarations(
              snapshot,
              [
                {
                  _tag: "Spec",
                  relativePath: SpecModulePath.make("notes.spec.ts"),
                },
              ],
              [],
            ),
          );
          expect([...GenerationSnapshot.functionPaths(empty)]).toEqual([]);
          const removedOutputs = yield* project.generatedFiles;
          expect(
            Object.hasOwn(removedOutputs, path.join("convex", "notes.ts")),
          ).toBe(false);
          expect(
            yield* Project.writtenFiles(project.provide(codegenHandler)),
          ).toEqual([]);
          expect(yield* project.generatedFiles).toEqual(removedOutputs);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "validates changed tables before affected implementations without rewriting declarations",
      () =>
        Effect.gen(function* () {
          const project = yield* Project.make;
          const { snapshot } = yield* project.provide(generateWithSnapshot);
          yield* project.write(
            "confect/tables/notes.ts",
            "export default {};\n",
          );
          const failed = yield* project
            .provide(
              updateDeclarations(
                snapshot,
                [
                  {
                    _tag: "Table",
                    relativePath: TableModulePath.make("tables/notes.ts"),
                  },
                ],
                [ImplModulePath.make("notes.impl.ts")],
              ),
            )
            .pipe(Effect.result);
          assert(Result.isFailure(failed));
          expect(failed.failure._tag).toBe("InvalidTableDefaultExportError");
          yield* project.write(
            "confect/tables/notes.ts",
            Project.table.replace(
              "text: Schema.String",
              "text: Schema.String, archived: Schema.Boolean",
            ),
          );
          const before = yield* project.generatedFiles;
          yield* project.provide(
            updateDeclarations(
              snapshot,
              [
                {
                  _tag: "Table",
                  relativePath: TableModulePath.make("tables/notes.ts"),
                },
              ],
              [ImplModulePath.make("notes.impl.ts")],
            ),
          );
          expect(yield* project.generatedFiles).toEqual(before);
          expect(
            yield* Project.writtenFiles(project.provide(codegenHandler)),
          ).toEqual([]);
          expect(yield* project.generatedFiles).toEqual(before);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "shares one build per evaluation phase without changing generated output",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const project = yield* Project.make;
          yield* project.write("confect/tables/labels.ts", Project.table);
          for (const name of ["other", "another"]) {
            yield* project.write(`confect/${name}.spec.ts`, Project.spec);
            yield* project.write(
              `confect/${name}.impl.ts`,
              Project.impl.replace('"./notes.spec"', `"./${name}.spec"`),
            );
          }
          const run = codegenHandler.pipe(
            Effect.provideService(ProjectRoot, {
              get: Effect.succeed(project.root),
            }),
            Effect.provideService(ConfectDirectory, {
              get: Effect.succeed(path.join(project.root, "confect")),
            }),
            Effect.provideService(ConvexDirectory, {
              get: Effect.succeed(path.join(project.root, "convex")),
            }),
          );
          vi.mocked(esbuild.build).mockClear();
          expect(yield* Project.writtenFiles(run)).not.toEqual([]);
          const batchedOutputs = yield* project.generatedFiles;
          expect(
            vi
              .mocked(esbuild.build)
              .mock.calls.map(
                ([options]) => Object.keys(options?.entryPoints ?? {}).length,
              )
              .filter((count) => count > 1),
          ).toEqual([2, 3, 3]);
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              vi
                .spyOn(Bundler, "withBatch")
                .mockImplementation(
                  <A, E, R>(
                    _entries: ReadonlyArray<string>,
                    effect: Effect.Effect<A, E, R>,
                  ) => effect,
                ),
            ),
            (spy) => Effect.sync(() => spy.mockRestore()),
          );
          expect(yield* Project.writtenFiles(run)).toEqual([]);
          expect(yield* project.generatedFiles).toEqual(batchedOutputs);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "bounds spec and impl phases without overlapping them",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const project = yield* Project.make;
          for (const index of Array.range(0, 7)) {
            yield* project.write(
              `confect/group${index}.spec.ts`,
              'import { GroupSpec } from "@confect/core"; export default GroupSpec.make();',
            );
            yield* project.write(
              `confect/group${index}.impl.ts`,
              `import { GroupImpl } from "@confect/server";
import databaseSchema from "./_generated/schema";
import spec from "./group${index}.spec";
export default GroupImpl.make(databaseSchema, spec).pipe(GroupImpl.finalize);`,
            );
          }
          const active = { spec: 0, impl: 0 };
          const maximum = { spec: 0, impl: 0 };
          let completedSpecs = 0;
          const original = Bundler.bundle;
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              vi.spyOn(Bundler, "bundle").mockImplementation((entry) =>
                Effect.gen(function* () {
                  const phase = entry.endsWith(".spec.ts")
                    ? "spec"
                    : entry.endsWith(".impl.ts")
                      ? "impl"
                      : undefined;
                  if (phase === undefined) return yield* original(entry);
                  if (phase === "impl") expect(completedSpecs).toBe(9);
                  active[phase]++;
                  maximum[phase] = Math.max(maximum[phase], active[phase]);
                  yield* Effect.yieldNow;
                  return yield* original(entry).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        active[phase]--;
                        if (phase === "spec") completedSpecs++;
                      }),
                    ),
                  );
                }),
              ),
            ),
            (spy) => Effect.sync(() => spy.mockRestore()),
          );
          yield* codegenHandler.pipe(
            Effect.provideService(ProjectRoot, {
              get: Effect.succeed(project.root),
            }),
            Effect.provideService(ConfectDirectory, {
              get: Effect.succeed(path.join(project.root, "confect")),
            }),
            Effect.provideService(ConvexDirectory, {
              get: Effect.succeed(path.join(project.root, "convex")),
            }),
          );
          expect(maximum).toEqual({ spec: 4, impl: 4 });
          expect(completedSpecs).toBe(9);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "does not bundle the same spec twice during one codegen pass",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const project = yield* Project.make;
          const bundle = yield* Effect.acquireRelease(
            Effect.sync(() => vi.spyOn(Bundler, "bundle")),
            (spy) => Effect.sync(() => spy.mockRestore()),
          );
          yield* codegenHandler.pipe(
            Effect.provideService(ProjectRoot, {
              get: Effect.succeed(project.root),
            }),
            Effect.provideService(ConfectDirectory, {
              get: Effect.succeed(path.join(project.root, "confect")),
            }),
            Effect.provideService(ConvexDirectory, {
              get: Effect.succeed(path.join(project.root, "convex")),
            }),
          );
          const specBuilds = bundle.mock.calls.filter(
            ([entry]) =>
              entry === path.join(project.root, "confect/notes.spec.ts"),
          );
          expect(specBuilds).toHaveLength(1);
          expect(bundle.mock.calls.map(([entry]) => entry)).not.toContain(
            path.join(project.root, "confect/_generated/spec.ts"),
          );
        }).pipe(Effect.scoped),
    );

    it.effect(
      "bootstraps dependent modules once without relying on stale output",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const project = yield* Project.make;
          const confect = path.join(project.root, "confect");
          const run = codegenHandler.pipe(
            Effect.provideService(ProjectRoot, {
              get: Effect.succeed(project.root),
            }),
            Effect.provideService(ConfectDirectory, {
              get: Effect.succeed(confect),
            }),
            Effect.provideService(ConvexDirectory, {
              get: Effect.succeed(path.join(project.root, "convex")),
            }),
          );
          expect(yield* Project.writtenFiles(run)).not.toEqual([]);
          expect(yield* Project.writtenFiles(run)).toEqual([]);
          yield* fs.remove(path.join(confect, "_generated"), {
            recursive: true,
          });
          expect(yield* Project.writtenFiles(run)).not.toEqual([]);
          expect(yield* Project.writtenFiles(run)).toEqual([]);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );
  },
);

const fixtureConfect = `${import.meta.dirname}/../../server/test/mock-backend/fixtures/confect`;

const CodegenLayer = Layer.mergeAll(
  NodePath.layer,
  NodeFileSystem.layer,
  Layer.succeed(
    ConfectDirectory,
    ConfectDirectory.of({ get: Effect.succeed(fixtureConfect) }),
  ),
);

layer(CodegenLayer)("TableModule.validate", (it) => {
  it.effect("bounds table bundling to four concurrent builds", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let active = 0;
      let maximum = 0;
      const bundle = yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(Bundler, "bundle").mockImplementation(() =>
            Effect.gen(function* () {
              active++;
              maximum = Math.max(maximum, active);
              if (active === 4) yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              active--;
              return {
                module: { default: Table.make(() => Schema.Struct({})) },
                metafile: { inputs: {}, outputs: {} },
              };
            }),
          ),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      const fiber = yield* validateTables(
        Array.range(0, 8).map((index) => ({
          relativePath: `tables/t${index}.ts`,
          tableName: `t${index}`,
        })),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* Effect.yieldNow;
      expect(active).toBe(4);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(fiber);
      expect(maximum).toBe(4);
      expect(bundle).toHaveBeenCalledTimes(9);
    }).pipe(Effect.scoped),
  );
});

layer(CodegenLayer)("TableModule.discover", (it) => {
  it.effect("discovers the fixture tables", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const tables = yield* discoverTables;
      expect(tables.map((t) => t.tableName).sort()).toEqual([
        "events",
        "notes",
        "tags",
        "users",
      ]);
      for (const table of tables) {
        expect(String.startsWith(`tables${path.sep}`)(table.relativePath)).toBe(
          true,
        );
      }
    }),
  );

  it.effect(
    "rejects a `confect/tables/*.ts` file that does not default-export an UnnamedTable",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stowedPath = path.join(fixtureConfect, "tables", "stowed.ts");

        yield* Effect.gen(function* () {
          yield* fs.writeFileString(stowedPath, "export default {};\n");
          const tables = yield* discoverTables;
          const result = yield* Effect.result(validateTables(tables));

          assert(Result.isFailure(result));
          expect(result.failure._tag).toBe("InvalidTableDefaultExportError");
        }).pipe(Effect.ensuring(fs.remove(stowedPath).pipe(Effect.orDie)));
      }),
  );

  // Each rejected filename exercises a different validator branch:
  //   - "user-profiles.ts" violates the JS identifier pattern (dash).
  //   - "_internal.ts" starts with `_`, which is reserved for Convex system
  //     tables and excluded by `validateConfectTableIdentifier` even though
  //     `_internal` is a legal JS identifier.
  //   - "import.ts" is a legal-looking identifier but a reserved JS keyword,
  //     so emitting it as a binding in generated files would fail to parse.
  it.effect.each(["user-profiles.ts", "_internal.ts", "import.ts"])(
    "rejects table filename %s",
    (filename) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const invalidPath = path.join(fixtureConfect, "tables", filename);

        yield* Effect.gen(function* () {
          yield* fs.writeFileString(invalidPath, "export default {};\n");
          const result = yield* Effect.result(discoverTables);

          assert(Result.isFailure(result));
          expect(result.failure._tag).toBe("InvalidTableFilenameError");
        }).pipe(Effect.ensuring(fs.remove(invalidPath).pipe(Effect.orDie)));
      }),
  );

  // Names are derived from the basename alone, but the directory is scanned
  // recursively—so two files in different subdirectories can resolve to the
  // same table name. That must fail loudly rather than racing on a shared
  // generated wrapper path/emitting duplicate schema bindings. Two distinct
  // colliding names are seeded so we can assert that *all* collisions are
  // captured in a single pass, not just the first.
  it.effect("rejects every set of files that resolve to the same name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped();
      const tablesDir = path.join(tempDir, "tables");
      yield* fs.makeDirectory(path.join(tablesDir, "a"), { recursive: true });
      yield* fs.makeDirectory(path.join(tablesDir, "b"), { recursive: true });
      yield* fs.writeFileString(
        path.join(tablesDir, "a", "notes.ts"),
        "export default {};\n",
      );
      yield* fs.writeFileString(
        path.join(tablesDir, "b", "notes.ts"),
        "export default {};\n",
      );
      yield* fs.writeFileString(
        path.join(tablesDir, "a", "users.ts"),
        "export default {};\n",
      );
      yield* fs.writeFileString(
        path.join(tablesDir, "b", "users.ts"),
        "export default {};\n",
      );

      const result = yield* Effect.result(
        discoverTables.pipe(
          Effect.provide(
            Layer.succeed(
              ConfectDirectory,
              ConfectDirectory.of({ get: Effect.succeed(tempDir) }),
            ),
          ),
        ),
      );

      assert(Result.isFailure(result));
      assert(result.failure._tag === "DuplicateTableNameError");
      const byName = Object.fromEntries(
        result.failure.collisions.map((c) => [
          c.tableName,
          [...c.tablePaths].sort(),
        ]),
      );
      expect(byName).toEqual({
        notes: [
          path.join("tables", "a", "notes.ts"),
          path.join("tables", "b", "notes.ts"),
        ],
        users: [
          path.join("tables", "a", "users.ts"),
          path.join("tables", "b", "users.ts"),
        ],
      });
    }).pipe(Effect.scoped),
  );

  it.effect("returns an empty array when there is no tables/ directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped();

      const tables = yield* discoverTables.pipe(
        Effect.provide(
          Layer.succeed(
            ConfectDirectory,
            ConfectDirectory.of({ get: Effect.succeed(tempDir) }),
          ),
        ),
      );

      expect(tables).toEqual([]);
    }).pipe(Effect.scoped),
  );

  // The "tables/ exists but has no .ts files" branch in `listTableFiles`
  // is structurally distinct from the missing-directory branch above
  // (different early return path) and deserves its own regression test;
  // both branches collapse to an empty result, which the codegen pipeline
  // promotes into a `⚠` warning at the call site (see `warnIfNoTables`).
  it.effect(
    "returns an empty array when tables/ exists but has no .ts files",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped();
        const tablesDir = path.join(tempDir, "tables");
        yield* fs.makeDirectory(tablesDir);
        yield* fs.writeFileString(path.join(tablesDir, ".gitkeep"), "");
        yield* fs.writeFileString(
          path.join(tablesDir, "README.md"),
          "tables go here\n",
        );

        const tables = yield* discoverTables.pipe(
          Effect.provide(
            Layer.succeed(
              ConfectDirectory,
              ConfectDirectory.of({ get: Effect.succeed(tempDir) }),
            ),
          ),
        );

        expect(tables).toEqual([]);
      }).pipe(Effect.scoped),
  );
});

const declarationProject = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const project = yield* Project.make;
  yield* fs.makeDirectory(
    path.join(project.root, "components/counter/convex"),
    {
      recursive: true,
    },
  );
  yield* project.write(
    "components/counter/convex/convex.config.ts",
    `import { defineComponent } from "convex/server";
import { v } from "convex/values";
export default defineComponent("counter", { env: { REQUIRED: v.string(), MARKER: v.optional(v.string()) } });
`,
  );
  yield* project.write(
    "components/counter/api.ts",
    `import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
export const CounterApi = HttpApi.make("counter").add(
  HttpApiGroup.make("health").add(HttpApiEndpoint.get("health", "/health", { success: Schema.String })),
);
`,
  );
  yield* project.write(
    "confect/env.ts",
    `import { Env } from "@confect/core";
export default Env.make("host", {
  MARKER: Env.optional(Env.string()),
  API_KEY: Env.secret(),
  MODE: Env.literals(["live", "test"]),
});
`,
  );
  yield* project.write(
    "confect/app.ts",
    `import { App } from "@confect/core";
import counter from "../components/counter/convex/convex.config";
import { CounterApi } from "../components/counter/api";
import env from "./env";
export default App.make({
  env,
  mounts: {
    first: App.mount(counter, { httpPrefix: "/first", api: CounterApi, env: { REQUIRED: "first-required", MARKER: env.MARKER } }),
    second: App.mount(counter, { env: { REQUIRED: env.API_KEY } }),
  },
});
`,
  );
  yield* project.write(
    "confect/auth.ts",
    `import { Auth } from "@confect/core";
import app from "./app";
export default Auth.make(app, {
  providers: [
    { type: "customJwt", applicationID: "host", issuer: Auth.siteUrl(), jwks: Auth.siteUrl(app.mounts.first, "/jwks.json"), algorithm: "RS256" },
    { domain: "https://login.example.test", applicationID: "host" },
  ],
});
`,
  );
  const http = (routePath: string) => `import { Http } from "@confect/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
const Api = HttpApi.make("host").add(
  HttpApiGroup.make("meta").add(HttpApiEndpoint.get("status", ${JSON.stringify(routePath)}, { success: Schema.String })),
);
const handlers = HttpApiBuilder.group(Api, "meta", (h) => h.handle("status", () => Effect.succeed("ok")));
export default Http.make({ api: Api, handlers });
`;
  yield* project.write("confect/http.ts", http("/status"));
  const run = codegenHandler.pipe(
    Effect.provideService(ProjectRoot, { get: Effect.succeed(project.root) }),
    Effect.provideService(ConfectDirectory, {
      get: Effect.succeed(path.join(project.root, "confect")),
    }),
    Effect.provideService(ConvexDirectory, {
      get: Effect.succeed(path.join(project.root, "convex")),
    }),
  );
  const read = (file: string) =>
    fs.readFileString(path.join(project.root, file));
  const exists = (file: string) => fs.exists(path.join(project.root, file));
  return { ...project, run, read, exists, http };
});

const expectedConvexConfig = `// Generated by \`confect codegen\` from confect/app.ts. Do not edit.
import { defineApp } from "convex/server";
import { v } from "convex/values";
import counter from "../components/counter/convex/convex.config";

const app = defineApp({
  env: {
    MARKER: v.optional(v.string()),
    API_KEY: v.string(),
    MODE: v.union(v.literal("live"), v.literal("test")),
  },
});

app.use(counter, {
  name: "first",
  httpPrefix: "/first",
  env: {
    REQUIRED: "first-required",
    MARKER: app.env.MARKER,
  },
});

app.use(counter, {
  name: "second",
  env: {
    REQUIRED: app.env.API_KEY,
  },
});

export default app;
`;

const expectedAuthConfig = `// Generated by \`confect codegen\` from confect/auth.ts. Do not edit.
import type { AuthConfig } from "convex/server";

export default {
  providers: [
    {
      type: "customJwt",
      applicationID: "host",
      issuer: \`\${process.env.CONVEX_SITE_URL}\`,
      jwks: \`\${process.env.CONVEX_SITE_URL}/first/jwks.json\`,
      algorithm: "RS256",
    },
    {
      domain: "https://login.example.test",
      applicationID: "host",
    },
  ],
} satisfies AuthConfig;
`;

const expectedManifest = (
  digest: string,
) => `// Generated by \`confect codegen\` from confect/env.ts and confect/app.ts. Do not edit.

export default {
  "name": "host",
  "env": {
    "MARKER": {
      "kind": "string",
      "optional": true
    },
    "API_KEY": {
      "kind": "secret",
      "optional": false
    },
    "MODE": {
      "kind": "literals",
      "values": [
        "live",
        "test"
      ],
      "optional": false
    }
  },
  "http": {
    "mounts": {
      "first": "/first"
    }
  },
  "digest": "${digest}"
} as const;
`;

const expectedHttp = `// Generated by \`confect codegen\` from confect/http.ts. Do not edit.
import { HttpRouter } from "@confect/server";
import schema from "../confect/_generated/schema";
import http from "../confect/http";

export default HttpRouter.forSchema(schema)(http.routes, { api: http.api });
`;

const digestOf = (manifest: string) =>
  /"digest": "(sha256:[0-9a-f]{64})"/.exec(manifest)?.[1] ?? "missing";

layer(Layer.mergeAll(NodePath.layer, NodeFileSystem.layer))(
  "codegenHandler with a backend declaration",
  (it) => {
    it.effect(
      "writes the Convex config, auth config, HTTP router and manifest from confect/",
      () =>
        Effect.gen(function* () {
          const project = yield* declarationProject;
          expect(yield* Project.writtenFiles(project.run)).not.toEqual([]);
          expect(yield* project.read("convex/convex.config.ts")).toBe(
            expectedConvexConfig,
          );
          expect(yield* project.read("convex/auth.config.ts")).toBe(
            expectedAuthConfig,
          );
          expect(yield* project.read("convex/http.ts")).toBe(expectedHttp);
          const manifest = yield* project.read(
            "confect/_generated/manifest.ts",
          );
          expect(manifest).toBe(expectedManifest(digestOf(manifest)));
          expect(
            yield* project.read("confect/_generated/components.ts"),
          ).toContain('"first": import(');
          const testing = yield* project.read("confect/_generated/testing.ts");
          expect(testing).toContain('import schema from "./schema"');
          expect(testing).toContain('"first": component0');
          expect(testing).toContain('"second": component0');
          expect(testing).toContain("components/counter/convex/schema");
          expect(testing).toContain("() => import(");
          expect(
            yield* project.read("confect/_generated/schema.ts"),
          ).not.toContain("testing");
          expect(yield* Project.writtenFiles(project.run)).toEqual([]);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "keeps a root HTTP mount valid in the generated test app",
      () =>
        Effect.gen(function* () {
          const project = yield* declarationProject;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fs.remove(path.join(project.root, "confect/http.ts"));
          yield* project.write(
            "components/counter/convex/http.ts",
            "export default {};\n",
          );
          yield* project.write(
            "confect/app.ts",
            (yield* project.read("confect/app.ts")).replace(
              'httpPrefix: "/first"',
              'httpPrefix: "/"',
            ),
          );
          yield* project.run;
          expect(
            yield* project.read("confect/_generated/testing.ts"),
          ).toContain('httpPrefix: "/"');
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "changes the manifest digest when a declaration input changes",
      () =>
        Effect.gen(function* () {
          const project = yield* declarationProject;
          yield* project.run;
          const before = digestOf(
            yield* project.read("confect/_generated/manifest.ts"),
          );
          yield* project.write(
            "components/counter/api.ts",
            `${yield* project.read("components/counter/api.ts")}// edited\n`,
          );
          yield* project.run;
          const after = digestOf(
            yield* project.read("confect/_generated/manifest.ts"),
          );
          expect(after).not.toBe(before);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "rejects an app route under a mount's HTTP prefix",
      () =>
        Effect.gen(function* () {
          const project = yield* declarationProject;
          yield* project.write(
            "confect/http.ts",
            project.http("/first/status"),
          );
          expect(yield* Effect.flip(project.run)).toEqual(
            new InvalidDeclarationError({
              declarationPath: "confect/http.ts",
              reason:
                'The app route GET /first/status is under the HTTP prefix /first of the mount "first". Convex would let it shadow the component\'s routes; move it or change the prefix.',
            }),
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "rejects overlapping mount prefixes without a confect/http.ts",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const project = yield* declarationProject;
          yield* fs.remove(path.join(project.root, "confect/http.ts"));
          yield* project.write(
            "confect/app.ts",
            (yield* project.read("confect/app.ts")).replace(
              "env: { REQUIRED: env.API_KEY }",
              'httpPrefix: "/first/nested", env: { REQUIRED: env.API_KEY }',
            ),
          );
          expect(yield* Effect.flip(project.run)).toEqual(
            new InvalidDeclarationError({
              declarationPath: "confect/app.ts",
              reason:
                'The mounts "first" (/first) and "second" (/first/nested) have overlapping HTTP prefixes.',
            }),
          );
          expect(yield* project.exists("confect/_generated/manifest.ts")).toBe(
            false,
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "refuses to overwrite a hand-written convex.config.ts",
      () =>
        Effect.gen(function* () {
          const project = yield* declarationProject;
          const handWritten = `import { defineApp } from "convex/server";\nexport default defineApp();\n`;
          yield* project.write("convex/convex.config.ts", handWritten);
          expect(yield* Effect.flip(project.run)).toEqual(
            new HandWrittenConvexFileError({
              convexPath: "convex/convex.config.ts",
              declarationPath: "confect/app.ts",
            }),
          );
          expect(yield* project.read("convex/convex.config.ts")).toBe(
            handWritten,
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "refuses to overwrite a hand-written auth.config.ts",
      () =>
        Effect.gen(function* () {
          const project = yield* declarationProject;
          const handWritten = "export default { providers: [] };\n";
          yield* project.write("convex/auth.config.ts", handWritten);
          expect(yield* Effect.flip(project.run)).toEqual(
            new HandWrittenConvexFileError({
              convexPath: "convex/auth.config.ts",
              declarationPath: "confect/auth.ts",
            }),
          );
          expect(yield* project.read("convex/auth.config.ts")).toBe(
            handWritten,
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "reports an app.ts mistake against app.ts when auth.ts exists",
      () =>
        Effect.gen(function* () {
          const project = yield* declarationProject;
          yield* project.write(
            "confect/app.ts",
            (yield* project.read("confect/app.ts")).replace(
              "first: App.mount",
              '"first-mount": App.mount',
            ),
          );
          yield* project.write(
            "confect/auth.ts",
            (yield* project.read("confect/auth.ts")).replace(
              "app.mounts.first",
              'app.mounts["first-mount"]',
            ),
          );
          expect(yield* Effect.flip(project.run)).toEqual(
            new InvalidDeclarationError({
              declarationPath: "confect/app.ts",
              reason:
                '"first-mount" is not a valid mount name; use letters, digits and underscores, starting with a letter or underscore.',
            }),
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "replaces the auth.config.ts re-export an earlier codegen wrote",
      () =>
        Effect.gen(function* () {
          const project = yield* declarationProject;
          yield* project.write(
            "convex/auth.config.ts",
            'import auth from "../confect/auth";\n\nexport default auth;\n',
          );
          yield* project.run;
          expect(yield* project.read("convex/auth.config.ts")).toBe(
            expectedAuthConfig,
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "removes the generated HTTP router when confect/http.ts is deleted",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const project = yield* declarationProject;
          yield* project.run;
          yield* fs.remove(path.join(project.root, "confect/http.ts"));
          yield* project.run;
          expect(yield* project.exists("convex/http.ts")).toBe(false);
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "removes the manifest when the backend opts out",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const project = yield* declarationProject;
          yield* project.run;
          for (const file of ["app.ts", "auth.ts", "http.ts"]) {
            yield* fs.remove(path.join(project.root, "confect", file));
          }
          yield* project.run;
          expect(yield* project.exists("confect/_generated/manifest.ts")).toBe(
            false,
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );

    it.effect(
      "removes the manifest when the declaration stops producing one",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const project = yield* declarationProject;
          yield* project.run;
          yield* fs.remove(path.join(project.root, "confect/auth.ts"));
          yield* fs.remove(path.join(project.root, "confect/http.ts"));
          yield* project.write(
            "confect/app.ts",
            'export default { env: "not an app" };\n',
          );
          expect((yield* Effect.flip(project.run))._tag).toBe(
            "InvalidDeclarationError",
          );
          expect(yield* project.exists("confect/_generated/manifest.ts")).toBe(
            false,
          );
        }).pipe(Effect.scoped),
      { timeout: 30000 },
    );
  },
);
