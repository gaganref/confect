import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as String from "effect/String";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";
import config from "../.oxlintrc.json" with { type: "json" };
import baselineJson from "./effectLintBaseline.json" with { type: "json" };
import effectPolicy from "../tsconfig.effect.json" with { type: "json" };

const baseline: Readonly<Record<string, Readonly<Record<string, number>>>> =
  baselineJson;
const overrides: ReadonlyArray<{
  readonly files: ReadonlyArray<string>;
  readonly rules: Readonly<Record<string, unknown>>;
}> = config.overrides;
const disabledRules: ReadonlyArray<string> = [
  "effecttsgo/missing-pipeable-signature",
  "effecttsgo/unstable-api-usage",
];
const effectRules = (() => {
  const require = createRequire(import.meta.url);
  const schema: unknown = require(
    fileURLToPath(
      new URL(
        "oxlint-schema.json",
        import.meta.resolve("@effect/tsgo/package.json"),
      ),
    ),
  );
  const declared = Schema.decodeUnknownEffect(
    Schema.Struct({
      definitions: Schema.Struct({
        DummyRuleMap: Schema.Struct({
          properties: Schema.Record(Schema.String, Schema.Unknown),
        }),
      }),
    }),
  )(schema).pipe(Effect.runSync);
  return Array.filter(
    Record.keys(declared.definitions.DummyRuleMap.properties),
    String.startsWith("effecttsgo/"),
  );
})();

// The baseline is the Effect lint debt the fork carried when upstream 10.6.0
// turned these rules on. It records each exempt file and its diagnostic count.
// An exemption is one single-rule `off` override listing literal paths.
const baselineOverrides = Array.filter(overrides, (override) => {
  const names = Record.keys(override.rules);
  return (
    names.length === 1 &&
    String.startsWith("effecttsgo/")(names[0]!) &&
    override.rules[names[0]!] === "off"
  );
});

test("enables every installed Effect rule except the explicit policy opt-outs", () => {
  expect(effectRules.length).toBeGreaterThan(0);
  const configuredRules: Readonly<Record<string, unknown>> = config.rules;
  for (const rule of effectRules) {
    expect(configuredRules[rule], rule).toBe(
      Array.contains(disabledRules, rule) ? "off" : "error",
    );
  }
  for (const override of overrides) {
    if (Array.contains(baselineOverrides, override)) continue;
    for (const rule of effectRules) {
      if (rule in override.rules) {
        expect(override.rules[rule], rule).toBe(
          Array.contains(disabledRules, rule) ? "off" : "error",
        );
      }
    }
  }
});

test("exempts from each Effect rule exactly the baselined files, by literal path", () => {
  const exempt: Record<string, ReadonlyArray<string>> = {};
  for (const override of baselineOverrides) {
    const rule = Record.keys(override.rules)[0]!;
    expect(exempt[rule], `one override per rule: ${rule}`).toBeUndefined();
    for (const file of override.files) {
      expect(/[*?[\]{}!]/.test(file), `${rule} names a pattern: ${file}`).toBe(
        false,
      );
    }
    exempt[rule] = Array.sort(override.files, String.Order);
  }
  expect(exempt).toEqual(
    Record.map(baseline, (files) =>
      Array.sort(Record.keys(files), String.Order),
    ),
  );
});

test(
  "exempt files carry exactly their baselined Effect diagnostics",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner;
      const repository = path.resolve(import.meta.dirname, "..");
      const directory = yield* fs.makeTempDirectoryScoped({
        directory: repository,
        prefix: "effect-baseline-",
      });
      // The probe keeps the shared settings and only the Effect rules, without
      // the baseline overrides. Other overrides leave Effect rules as the base
      // sets them, which the first test checks.
      const probe = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Unknown),
      )({
        extends: Array.map(config.extends, (preset) =>
          path.resolve(repository, preset),
        ),
        plugins: config.plugins,
        settings: config.settings,
        options: config.options,
        env: config.env,
        categories: Record.map(config.categories, () => "off"),
        rules: Record.filter(config.rules, (_value, rule) =>
          String.startsWith("effecttsgo/")(rule),
        ),
      });
      const probeConfig = path.join(directory, "oxlintrc.json");
      yield* fs.writeFileString(probeConfig, probe);
      const child = yield* spawner.spawn(
        // Bun truncates this wrapper's piped stdout at exit; Node flushes it.
        // The whole repository is linted, as `pnpm lint` does, because a run
        // over some files resolves some types differently and counts differ.
        ChildProcess.make(
          "node",
          [
            fileURLToPath(
              new URL(
                "dist/effect-tsgo.cjs",
                import.meta.resolve("@effect/tsgo/package.json"),
              ),
            ),
            "--tsrs-lint",
            "oxlint",
            "--config",
            probeConfig,
            "--format",
            "json",
            ...Array.flatMap(config.ignorePatterns, (pattern) => [
              "--ignore-pattern",
              pattern,
            ]),
            ".",
          ],
          { cwd: repository },
        ),
      );
      const output = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.mkString,
      );
      yield* child.exitCode;
      const report = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            diagnostics: Schema.Array(
              Schema.Struct({
                code: Schema.optional(Schema.String),
                filename: Schema.String,
              }),
            ),
            number_of_files: Schema.Finite,
          }),
        ),
      )(output);
      expect(report.number_of_files).toBeGreaterThan(0);
      const counts: Record<string, Record<string, number>> = {};
      for (const { code, filename } of report.diagnostics) {
        const rule = /^effecttsgo\((.+)\)$/.exec(code ?? "")?.[1];
        if (rule === undefined) continue;
        const byFile = (counts[`effecttsgo/${rule}`] ??= {});
        byFile[filename] = (byFile[filename] ?? 0) + 1;
      }
      expect(
        counts,
        "Above the baseline, new code in an exempt file breaks the rule: fix it. Below it, lower scripts/effectLintBaseline.json to the new count, and remove the file from the rule's .oxlintrc.json override at 0.",
      ).toEqual(baseline);
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.runPromise,
    ),
  { timeout: 120_000 },
);

test("disables compiler diagnostics without per-export unstable API grants", () => {
  for (const plugin of effectPolicy.compilerOptions.plugins) {
    expect(plugin.diagnostics).toBe(false);
    expect(plugin).not.toHaveProperty("allowedUnstableApis");
  }
});

test("allows unstable APIs without per-export grants", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner;
    const repository = path.resolve(import.meta.dirname, "..");
    const directory = yield* fs.makeTempDirectoryScoped({
      directory: repository,
      prefix: "effect-policy-",
    });
    const fixture = path.join(directory, "probe.ts");
    const tsconfig = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.Unknown),
    )({
      extends: path.join(repository, "tsconfig.effect.json"),
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        target: "ESNext",
        skipLibCheck: true,
      },
      files: ["probe.ts"],
    });
    yield* fs.writeFileString(path.join(directory, "tsconfig.json"), tsconfig);
    yield* fs.writeFileString(
      fixture,
      `import * as HttpClientRequest from "effect/http/HttpClientRequest";
void HttpClientRequest.get("https://example.com");
void HttpClientRequest.put("https://example.com");
`,
    );
    const child = yield* spawner.spawn(
      ChildProcess.make("node", [
        fileURLToPath(
          new URL(
            "dist/effect-tsgo.cjs",
            import.meta.resolve("@effect/tsgo/package.json"),
          ),
        ),
        "--tsrs-lint",
        "oxlint",
        "--config",
        path.join(repository, ".oxlintrc.json"),
        "--format",
        "json",
        fixture,
      ]),
    );
    const output = yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.mkString,
    );
    const exitCode = yield* child.exitCode;
    const report = yield* Schema.decodeEffect(
      Schema.fromJsonString(
        Schema.Struct({
          diagnostics: Schema.Array(
            Schema.Struct({ code: Schema.String, message: Schema.String }),
          ),
        }),
      ),
    )(output);
    expect<number>(exitCode).toBe(0);
    expect(report.diagnostics).toHaveLength(0);
  }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.runPromise,
  ));
