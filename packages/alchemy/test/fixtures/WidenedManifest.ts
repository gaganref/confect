import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { pipe } from "effect/Function";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

/**
 * What a widened check also returns: a refusal of the shape it returns now with
 * a reason no mapper handles, or one of a tag no mapper knows.
 *
 * @stability unstable
 */
export type Widening = "reason" | "refusal";

const extra = {
  reason:
    'Failure extends infer F ? (F extends unknown ? Omit<F, "reason"> & { readonly reason: "Novel" } : never) : never',
  refusal:
    '{ readonly _tag: "NovelRefusal"; readonly reason: "Novel"; readonly mount: string; readonly slot: string; readonly message: string }',
} as const;

const Config = Schema.fromJsonString(Schema.Unknown);

/**
 * Compile `target`, a file of the package at `packageRoot`, with the
 * Effect-enabled `tsrs`, reading `@confect/core` from source and, when
 * `widened` names one, a `Manifest` whose check of that name also returns the
 * widening. Answers the diagnostics reported in `target`.
 *
 * @stability unstable
 */
export const diagnosticsOf = (
  packageRoot: string,
  target: string,
  widened?: { readonly check: string; readonly widening: Widening },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner;
    const repo = path.resolve(packageRoot, "../..");
    const core = path.join(repo, "packages/core/src");
    const directory = yield* fs.makeTempDirectoryScoped({
      directory: path.join(packageRoot, "test/fixtures"),
      prefix: "widened-",
    });
    const real = yield* Schema.encodeEffect(Config)(
      path.join(core, "Manifest"),
    );
    const shim = path.join(directory, "Manifest.ts");
    yield* fs.writeFileString(
      shim,
      widened === undefined
        ? `export * from ${real};\n`
        : Arr.join(
            [
              `export * from ${real};`,
              `import type * as Real from ${real};`,
              'import type * as Result from "effect/Result";',
              `type Check = typeof Real.${widened.check};`,
              "type Success = Result.Result.Success<ReturnType<Check>>;",
              "type Failure = Result.Result.Failure<ReturnType<Check>>;",
              `export declare const ${widened.check}: (...args: Parameters<Check>) => Result.Result<Success, Failure | (${extra[widened.widening]})>;`,
              "",
            ],
            "\n",
          ),
    );
    const config = path.join(directory, "tsconfig.json");
    const settings = yield* Schema.encodeEffect(Config)({
      extends: path.join(packageRoot, "tsconfig.json"),
      compilerOptions: {
        noEmit: true,
        types: ["node"],
        // Oxlint owns Effect diagnostics; only TypeScript's are read here.
        plugins: [{ name: "@effect/language-service", diagnostics: false }],
        paths: {
          "@confect/core/Manifest": [shim],
          "@confect/core/*": [path.join(core, "*")],
          "@confect/core": [path.join(core, "index.ts")],
        },
      },
      files: [path.join(packageRoot, target)],
    });
    yield* fs.writeFileString(config, settings);
    const manifest = yield* path.fromFileUrl(
      new URL(import.meta.resolve("@effect/tsgo/package.json")),
    );
    const effectTsgo = path.dirname(manifest);
    const output = yield* spawner.string(
      ChildProcess.make(
        process.execPath,
        [
          path.join(effectTsgo, "dist", "effect-tsgo.cjs"),
          "tsrs",
          "--project",
          config,
          "--pretty",
          "false",
        ],
        { cwd: packageRoot },
      ),
    );
    return pipe(
      output,
      Str.split("\n"),
      Arr.filter((line) => pipe(line, Str.startsWith(`${target}(`))),
    );
  }).pipe(Effect.scoped);
