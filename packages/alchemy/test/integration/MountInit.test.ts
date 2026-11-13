import * as NodeServices from "../fixtures/NodeTestServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as RealBackend from "./RealBackend";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import { assertIs } from "../internal/assertIs";

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
  relay: { label: "Relay" },
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
 * generated, children first.
 */
const app = (root: string, name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = `${root}/${name}`;
    yield* RealBackend.copyApp(fixture, directory, {
      "node_modules/convex": `${modules}/convex`,
      "node_modules/effect": `${modules}/effect`,
      ...Rec.fromEntries(
        Arr.map(["cli", "core", "server"], (dependency) => [
          `node_modules/@confect/${dependency}`,
          `${packages}/${dependency}`,
        ]),
      ),
    });
    for (const component of ["email", "relay"]) {
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
 * What one clean push notes, in order.
 */
const steps = (tag: string) => [
  `${tag} attempt`,
  `${tag} acquire`,
  `${tag} code`,
  `${tag} init bulkEmail`,
  `${tag} init transactionalEmail`,
  `${tag} init relay`,
  `${tag} init relay/inbox`,
  `${tag} release`,
];

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
          const nodeResult = yield* node(appA, tsc, "-p", ".");
          expect(nodeResult).toBe("");
          const first = yield* both;
          expect(first.bulkEmail).toMatchObject(initial.bulkEmail);
          expect(first.bulkEmail.onEvent).toEqual(expect.any(String));
          expect(first.transactionalEmail).toMatchObject(
            initial.transactionalEmail,
          );

          const pushResult = yield* push(appA, initial);
          expect(Result.isSuccess(pushResult)).toBe(true);
          const bothValue = yield* both;
          expect(bothValue).toEqual(first);

          const trimmed = {
            ...initial,
            bulkEmail: { fromName: "School office" },
          };
          const pushResult2 = yield* push(appA, trimmed);
          expect(Result.isSuccess(pushResult2)).toBe(true);
          const removed = yield* settings("bulkEmail");
          expect(removed._id).toBe(first.bulkEmail._id);
          expect(Rec.has(removed, "maxAttempts")).toBe(false);
          expect((yield* both).transactionalEmail).toEqual(
            first.transactionalEmail,
          );

          const failed = yield* push(appA, {
            ...trimmed,
            bulkEmail: { fromName: "FAIL_AFTER_WRITE" },
          });
          assertIs(failed, Result.isFailure);
          expect(failed.failure).toMatchObject({
            _tag: "MountInitFailed",
            mount: "bulkEmail",
            detail: expect.stringContaining("SyntheticInitAfterWrite"),
          });
          const settingsResult = yield* settings("bulkEmail");
          expect(settingsResult).toEqual(removed);
        }),
      ),
    600_000,
  );

  it.live(
    "calls the host callback with stored config, runs nested mounts after their parent, stops at a failing mount, and refuses a deleted target",
    () =>
      withDeployment(({ push, call, settings, apps: [appA] }) =>
        Effect.gen(function* () {
          yield* call("install:send", "bulkEmail", { message: "Synthetic" });
          const sent = (yield* call("events:list")) as ReadonlyArray<Row>;
          expect(
            Arr.map(sent, ({ fromName, message }) => ({ fromName, message })),
          ).toEqual([{ fromName: "School office", message: "Synthetic" }]);

          const all = Effect.all({
            bulkEmail: settings("bulkEmail"),
            transactionalEmail: settings("transactionalEmail"),
            relay: settings("relay"),
            inbox: settings("relay/inbox"),
          });
          const first = yield* all;
          expect(first.relay).toMatchObject({ label: "Relay" });
          expect(first.inbox).toMatchObject({ fromName: "Relay inbox" });
          const events: Array<string> = [];
          const pushResult = yield* push(appA, initial, "A", events);
          expect(Result.isSuccess(pushResult)).toBe(true);
          expect(events).toEqual(steps("A"));
          const allValue = yield* all;
          expect(allValue).toEqual(first);

          const second = {
            ...initial,
            bulkEmail: { fromName: "School office v2" },
            relay: { label: "Relay v2" },
          };
          const stopped = yield* push(appA, {
            ...second,
            transactionalEmail: { fromName: "FAIL_AFTER_WRITE" },
          });
          assertIs(stopped, Result.isFailure);
          expect(stopped.failure).toMatchObject({
            message:
              "transactionalEmail: init failed; earlier mounts are applied, and the next push retries",
          });
          const partial = yield* all;
          expect(partial.bulkEmail.fromName).toBe("School office v2");
          expect(partial.transactionalEmail).toEqual(first.transactionalEmail);
          expect(partial.relay).toEqual(first.relay);
          const clean = {
            ...second,
            transactionalEmail: { fromName: "Receipts v2" },
          };
          const pushResult2 = yield* push(appA, clean);
          expect(Result.isSuccess(pushResult2)).toBe(true);
          const converged = yield* all;
          expect(converged.bulkEmail).toMatchObject(clean.bulkEmail);
          expect(converged.transactionalEmail).toMatchObject(
            clean.transactionalEmail,
          );
          expect(converged.relay).toMatchObject(clean.relay);
          expect(converged.inbox).toEqual(first.inbox);

          const gone = { ...clean, bulkTarget: "gone" as const };
          const pushResult3 = yield* push(appA, gone);
          expect(Result.isSuccess(pushResult3)).toBe(true);
          const target = yield* settings("bulkEmail");
          expect(target.onEvent).not.toBe(converged.bulkEmail.onEvent);
          const deleted: Array<string> = [];
          const refused = yield* push(
            appA,
            { ...gone, bulkEmail: { fromName: "Unapplied" }, withGone: false },
            "D",
            deleted,
          );
          assertIs(refused, Result.isFailure);
          expect(refused.failure).toMatchObject({
            _tag: "MountInitFailed",
            mount: "bulkEmail",
            detail: expect.stringContaining("Function handle not found"),
          });
          expect(deleted).toEqual([
            "D attempt",
            "D acquire",
            "D code",
            "D release",
          ]);
          const settingsResult = yield* settings("bulkEmail");
          expect(settingsResult).toEqual(target);
        }),
      ),
    600_000,
  );

  it.live(
    "holds a second push at the lock while the first is between its code and its init",
    () =>
      withDeployment(({ push, settings, apps: [appA, appB] }) =>
        Effect.gen(function* () {
          const events: Array<string> = [];
          const aCoded = yield* Deferred.make<void>();
          const bWaiting = yield* Deferred.make<void>();
          // A waits, after its code push, until B asks for the lock. Pushes
          // that cannot overlap time out here instead of hanging.
          const holdA = Deferred.succeed(aCoded, undefined).pipe(
            Effect.andThen(Deferred.await(bWaiting)),
            Effect.timeout("30 seconds"),
            Effect.orDie,
          );
          const [a, b] = yield* Effect.all(
            [
              push(appA, { ...initial, relay: { label: "A" } }, "A", events, {
                coded: holdA,
              }),
              Deferred.await(aCoded).pipe(
                Effect.andThen(
                  push(
                    appB,
                    { ...initial, relay: { label: "B" } },
                    "B",
                    events,
                    {
                      attempting: Deferred.succeed(bWaiting, undefined),
                    },
                  ),
                ),
              ),
            ],
            { concurrency: "unbounded" },
          );
          expect(Result.isSuccess(a) && Result.isSuccess(b)).toBe(true);
          const [attemptA, ...heldA] = steps("A");
          expect(events).toEqual([
            attemptA,
            heldA[0],
            heldA[1],
            "B attempt",
            ...heldA.slice(2),
            ...steps("B").slice(1),
          ]);
          expect((yield* settings("relay")).label).toBe("B");
        }),
      ),
    600_000,
  );
});
