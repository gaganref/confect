import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { createRequire } from "node:module";

const oxlintManifestPath = createRequire(import.meta.url).resolve(
  "oxlint/package.json",
);

describe("require-collect-reason", () => {
  it.effect(
    "checks direct calls, pipes and aliases, accepting reasons and ranged reads",
    () =>
      Effect.gen(function* () {
        const code = `import { QueryStream as Q } from "@confect/server";
import * as S from "@confect/server/QueryStream";
import { collect as gather } from "@confect/server/QueryStream";
Q.collect(db.all());
db.all().pipe(Q.collect({ maximumRowsRead: 2000 }));
S.collect(db.all().pipe(Q.filter(Boolean)));
gather(db.all(undefined, "desc"));
// COLLECT: The institution calendar contains only its configured holidays.
Q.collect(db.all());
// COLLECT: A small reference table.
db.all().pipe(Q.collect);
Q.collect(db.all(q => q.eq("year", 2026)));
other.collect(db.all());
function shadow(Q) { Q.collect(db.all()); }
const all = db.all();
Q.collect(all);
// COLLECT:
Q.collect(db.all());
// COLLECT: This reason belongs to another statement.
const another = 1;
Q.collect(db.all());
db.all().pipe(Q.collect);

`;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const root = path.resolve(import.meta.dirname, "../../..");
        const manifest = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({ bin: Schema.Struct({ oxlint: Schema.String }) }),
          ),
        )(yield* fs.readFileString(oxlintManifestPath));
        const oxlint = path.resolve(
          path.dirname(oxlintManifestPath),
          manifest.bin.oxlint,
        );
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "confect-collect-",
        });
        const sourceDirectory = path.join(directory, "src");
        yield* fs.makeDirectory(sourceDirectory, { recursive: true });
        const file = path.join(sourceDirectory, "fixture.ts");
        const config = path.join(directory, "config.json");
        yield* fs.writeFileString(file, code);
        yield* fs.writeFileString(
          config,
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            jsPlugins: [path.join(root, "tools/oxlint-rules/src/index.ts")],
            categories: { correctness: "off" },
            rules: { "confect/require-collect-reason": "error" },
          }),
        );
        const handle = yield* spawner.spawn(
          ChildProcess.make(
            process.execPath,
            [oxlint, "--config", config, "--format", "json", file],
            { cwd: root, stdin: "ignore" },
          ),
        );
        const result = yield* Effect.all(
          {
            status: handle.exitCode,
            stdout: handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
            stderr: handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
          },
          { concurrency: "unbounded" },
        );
        expect(result.stderr).toBe("");
        const output = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              diagnostics: Schema.Array(Schema.Struct({ code: Schema.String })),
            }),
          ),
        )(result.stdout);
        const missing = 8;
        expect(output.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
          Array.from(
            { length: missing },
            () => "confect(require-collect-reason)",
          ),
        );
        expect(result.status).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
