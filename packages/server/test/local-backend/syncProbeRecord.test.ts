/**
 * The sync probe's record writer, without a binary: whatever a leg's sides do,
 * the record a run leaves is that run's, and a side that fails or never
 * finishes leaves the record `incomplete` with the partial observations.
 */
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Each case writes its records into a temporary directory of its own, which `runLeg` writes with Node's fs.
import * as Fs from "node:fs";
import * as Os from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- See above.
import * as Path from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as SyncProbe from "./SyncProbe";

const binding: SyncProbe.Binding = {
  worktree: "/worktree",
  revision: "0000000000000000000000000000000000000000",
  dirty: false,
  binary: {
    version: "precompiled-test",
    sha256: "0000000000000000000000000000000000000000000000000000000000000000",
  },
  ports: { cloud: 1, site: 2 },
  pid: 1,
};

const Written = Schema.fromJsonString(
  Schema.Struct({
    verdict: Schema.Literals(["agree", "disagree", "incomplete"]),
    observations: Schema.Record(Schema.String, Schema.Unknown),
    failure: Schema.NullOr(
      Schema.Struct({ side: Schema.String, message: Schema.String }),
    ),
  }),
);

const directory = Effect.sync(() =>
  Fs.mkdtempSync(Path.join(Os.tmpdir(), "sync-probe-record-")),
);

/**
 * The record a leg left under `dir`, as written.
 */
const written = (dir: string) =>
  Effect.sync(() =>
    Fs.readFileSync(Path.join(dir, "observable.json"), "utf8"),
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Written)), Effect.orDie);

const leg = (
  dir: string,
  sides: Pick<Parameters<typeof SyncProbe.runLeg>[0], "binary" | "kernel">,
  deadline = Duration.seconds(5),
) =>
  SyncProbe.runLeg({
    leg: "observable",
    binding,
    sources: {},
    deadline,
    holds: () => true,
    redact: (json) => json,
    directory: dir,
    ...sides,
  });

const finished = { steps: 3 };

describe("sync probe records", () => {
  it.live(
    "a side that fails replaces an earlier agreeing record with an incomplete one holding both sides' partial observations",
    () =>
      Effect.gen(function* () {
        const dir = yield* directory;
        const agreed = yield* leg(dir, {
          binary: () => Effect.succeed(finished),
          kernel: () => Effect.succeed(finished),
        });
        expect(agreed.verdict).toBe("agree");
        const before = yield* written(dir);
        expect(before.verdict).toBe("agree");

        const failed = yield* leg(dir, {
          binary: (progress) =>
            Effect.sync(() => {
              progress.observed = { steps: 1 };
            }).pipe(
              Effect.andThen(Effect.die(new Error("Invalid start version"))),
            ),
          kernel: () => Effect.succeed(finished),
        });
        expect(failed).toMatchObject({
          verdict: "incomplete",
          observations: { binary: { steps: 1 }, kernel: null },
          failure: { side: "binary", message: "Invalid start version" },
        });
        const after = yield* written(dir);
        expect(after).toMatchObject({
          verdict: "incomplete",
          observations: { binary: { steps: 1 } },
        });
      }),
  );

  it.live(
    "a side that never finishes ends at its deadline with an incomplete record",
    () =>
      Effect.gen(function* () {
        const dir = yield* directory;
        const record = yield* leg(
          dir,
          {
            binary: () => Effect.succeed(finished),
            kernel: (progress) =>
              Effect.sync(() => {
                progress.observed = { steps: 2 };
              }).pipe(Effect.andThen(Effect.never)),
          },
          Duration.millis(100),
        );
        expect(record).toMatchObject({
          verdict: "incomplete",
          observations: { kernel: { steps: 2 }, binary: null },
          failure: { side: "kernel" },
        });
        expect(record.failure?.message).toContain("100 ms");
      }),
  );

  it.live(
    "while a leg runs its record is incomplete, so an earlier verdict never stands for it",
    () =>
      Effect.gen(function* () {
        const dir = yield* directory;
        yield* leg(dir, {
          binary: () => Effect.succeed(finished),
          kernel: () => Effect.succeed(finished),
        });
        const gate = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        const running = yield* Effect.forkChild(
          leg(dir, {
            binary: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(gate)),
                Effect.as(finished),
              ),
            kernel: () => Effect.succeed(finished),
          }),
        );
        yield* Deferred.await(started);
        const during = yield* written(dir);
        expect(during).toMatchObject({
          verdict: "incomplete",
          failure: { side: "none" },
        });
        yield* Deferred.succeed(gate, undefined);
        const record = yield* Fiber.join(running);
        expect(record.verdict).toBe("agree");
      }),
  );
});
