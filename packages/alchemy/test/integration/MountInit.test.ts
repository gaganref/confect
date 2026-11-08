import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as RealBackend from "./RealBackend";

// Runs the real pinned backend, as RealLocalBackend.test.ts does, on ports
// 3400-3499. Every push runs the real codegen and `convex deploy`.
const fixture = new URL("../fixtures/init-app", import.meta.url).pathname;
const modules = new URL("../../node_modules", import.meta.url).pathname;
const packages = new URL("../../..", import.meta.url).pathname;
const tsc = `${modules}/typescript/bin/tsc`;
const confect = `${packages}/cli/bin/confect.mjs`;
const prepare = { command: "confect", args: ["codegen"] };

const initial = {
  bulkEmail: { fromName: "School office", maxAttempts: 3 } as Sender,
  transactionalEmail: { fromName: "Receipts", maxAttempts: 2 } as Sender,
  bulkTarget: "record" as "record" | "gone",
  withGone: true,
};
interface Sender {
  readonly fromName: string;
  readonly maxAttempts?: number;
}
type Args = typeof initial;
type Row = Record<string, unknown> & { readonly _id: string };

/**
 * Run `node` with `args` in `cwd` and return its output.
 */
const node = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner.string(
      ChildProcess.make(process.execPath, args, { cwd, stdin: "ignore" }),
      { includeStderr: true },
    );
  }).pipe(Effect.orDie, Effect.provide(NodeServices.layer));

/**
 * A copy of the fixture, linked to the built packages, with its components
 * generated.
 */
const app = (root: string, name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = `${root}/${name}`;
    yield* RealBackend.copyApp(fixture, directory, {
      "node_modules/convex": `${modules}/convex`,
      "node_modules/effect": `${modules}/effect`,
      ...Object.fromEntries(
        ["cli", "core", "server"].map((dependency) => [
          `node_modules/@confect/${dependency}`,
          `${packages}/${dependency}`,
        ]),
      ),
    });
    for (const component of ["email"]) {
      yield* fs.makeDirectory(`${directory}/components/${component}/convex`);
      yield* node(
        directory,
        confect,
        "codegen",
        "--component-dir",
        `components/${component}/convex`,
      );
    }
    yield* fs.makeDirectory(`${directory}/convex`);
    // WORKAROUND: a host's first codegen bundles confect/app.ts before it
    // writes _generated/refs, which the mount files import, so it first runs
    // on a declaration without mounts. Goes when the F5 fix for a first
    // codegen whose mounts import the host's refs lands.
    const declaration = `${directory}/confect/app.ts`;
    const declared = yield* fs.readFileString(declaration);
    yield* fs.writeFileString(
      declaration,
      'import { App } from "@confect/core";\nimport env from "./env";\nexport default App.make({ env });\n',
    );
    yield* node(directory, confect, "codegen");
    yield* fs.writeFileString(declaration, declared);
    return directory;
  });

/**
 * What a scenario gets: a push that first writes the install args, an admin
 * call, a reader of each mount's stored config, and two app copies.
 */
const makeDeployment = (
  outputs: RealBackend.Outputs,
  apps: readonly [string, string],
  fs: FileSystem.FileSystem,
) => {
  const call = (functionPath: string, componentPath?: string, args?: unknown) =>
    RealBackend.call(outputs, functionPath, componentPath, args);
  return {
    apps,
    call,
    settings: (componentPath: string) =>
      call("install:settings", componentPath) as Effect.Effect<Row>,
    push: (
      cwd: string,
      args: Args,
      ...rest: [tag?: string, events?: Array<string>, probe?: RealBackend.Probe]
    ) =>
      fs
        .writeFileString(
          `${cwd}/confect/args.ts`,
          `export default ${JSON.stringify(args)};\n`,
        )
        .pipe(
          Effect.orDie,
          Effect.andThen(RealBackend.push(outputs, { cwd, prepare }, ...rest)),
        ),
  };
};

type Deployment = ReturnType<typeof makeDeployment>;

/**
 * Start a fresh local backend whose first push is the stack's own
 * `Convex.Code`, run the scenario, and stop the backend.
 */
const withDeployment = <A, E>(
  scenario: (deployment: Deployment) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const backend = yield* RealBackend.make({
      name: "init",
      ports: "3400-3499",
    });
    const apps = [
      yield* app(backend.root, "app-a"),
      yield* app(backend.root, "app-b"),
    ] as const;
    return yield* backend.session({ cwd: apps[0], prepare }, (outputs) =>
      scenario(makeDeployment(outputs, apps, fs)),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe.skipIf(process.platform === "win32")("mount init on a push", () => {
  it.live(
    "typechecks as pushed, stores each mount's config, keeps it on a repeated push, and keeps the previous config when init fails",
    () =>
      withDeployment(({ push, settings, apps: [appA] }) =>
        Effect.gen(function* () {
          const both = Effect.all({
            bulkEmail: settings("bulkEmail"),
            transactionalEmail: settings("transactionalEmail"),
          });
          expect(yield* node(appA, tsc, "-p", ".")).toBe("");
          const first = yield* both;
          expect(first.bulkEmail).toMatchObject(initial.bulkEmail);
          expect(first.bulkEmail.onEvent).toEqual(expect.any(String));
          expect(first.transactionalEmail).toMatchObject(
            initial.transactionalEmail,
          );

          expect(Result.isSuccess(yield* push(appA, initial))).toBe(true);
          expect(yield* both).toEqual(first);

          const trimmed = {
            ...initial,
            bulkEmail: { fromName: "School office" },
          };
          expect(Result.isSuccess(yield* push(appA, trimmed))).toBe(true);
          const removed = yield* settings("bulkEmail");
          expect(removed._id).toBe(first.bulkEmail._id);
          expect(Object.hasOwn(removed, "maxAttempts")).toBe(false);
          expect((yield* both).transactionalEmail).toEqual(
            first.transactionalEmail,
          );

          const failed = yield* push(appA, {
            ...trimmed,
            bulkEmail: { fromName: "FAIL_AFTER_WRITE" },
          });
          assert(Result.isFailure(failed));
          expect(failed.failure).toMatchObject({
            _tag: "MountInitFailed",
            mount: "bulkEmail",
            detail: expect.stringContaining("SyntheticInitAfterWrite"),
          });
          expect(yield* settings("bulkEmail")).toEqual(removed);
        }),
      ),
    600_000,
  );
});
