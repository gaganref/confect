// oxlint-disable effecttsgo/new-promise -- A side is a promise the unmodified client's legs return, which these sides stand in for.
/**
 * The sync probe's record writer, without a binary: whatever a leg's sides do,
 * the record a run leaves is that run's, and a side that fails or never
 * finishes leaves the record `incomplete` with the partial observations.
 */
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Each case writes its records into a directory of its own.
import * as Fs from "node:fs";
import * as Os from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- See above.
import * as Path from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Json from "../../../test/src/internal/Json";
import * as SyncProbe from "./SyncProbe";

const decodeJson = Json.parse;

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

const directory = () =>
  Fs.mkdtempSync(Path.join(Os.tmpdir(), "sync-probe-record-"));

const written = (dir: string, leg: string) =>
  decodeJson(Fs.readFileSync(Path.join(dir, `${leg}.json`), "utf8")) as {
    readonly verdict: SyncProbe.Verdict;
    readonly observations: Record<string, unknown>;
    readonly failure: { readonly side: string; readonly message: string };
  };

const leg = (
  dir: string,
  sides: Pick<Parameters<typeof SyncProbe.runLeg>[0], "binary" | "kernel">,
  deadline = 5_000,
) =>
  Effect.promise(() =>
    SyncProbe.runLeg({
      leg: "observable",
      binding,
      sources: {},
      deadline,
      holds: () => true,
      redact: (json) => json,
      directory: dir,
      ...sides,
    }),
  );

describe("sync probe records", () => {
  it.live(
    "a side that fails replaces an earlier agreeing record with an incomplete one holding both sides' partial observations",
    () =>
      Effect.gen(function* () {
        const dir = directory();
        const agreed = yield* leg(dir, {
          binary: () => Promise.resolve({ steps: 3 }),
          kernel: () => Promise.resolve({ steps: 3 }),
        });
        expect(agreed.verdict).toBe("agree");
        expect(written(dir, "observable").verdict).toBe("agree");

        const failed = yield* leg(dir, {
          binary: (progress) => {
            progress.observed = { steps: 1 };
            return Promise.reject(new Error("Invalid start version"));
          },
          kernel: () => Promise.resolve({ steps: 3 }),
        });
        expect(failed).toMatchObject({
          verdict: "incomplete",
          observations: { binary: { steps: 1 }, kernel: null },
          failure: { side: "binary", message: "Invalid start version" },
        });
        expect(written(dir, "observable")).toMatchObject({
          verdict: "incomplete",
          observations: { binary: { steps: 1 } },
        });
      }),
  );

  it.live(
    "a side that never finishes ends at its deadline with an incomplete record",
    () =>
      Effect.gen(function* () {
        const dir = directory();
        const record = yield* leg(
          dir,
          {
            binary: () => Promise.resolve({ steps: 3 }),
            kernel: (progress) => {
              progress.observed = { steps: 2 };
              return new Promise(() => undefined);
            },
          },
          100,
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
        const dir = directory();
        yield* leg(dir, {
          binary: () => Promise.resolve({ steps: 3 }),
          kernel: () => Promise.resolve({ steps: 3 }),
        });
        let release = () => undefined as void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const running = SyncProbe.runLeg({
          leg: "observable",
          binding,
          sources: {},
          deadline: 5_000,
          holds: () => true,
          redact: (json) => json,
          directory: dir,
          binary: () => gate.then(() => ({ steps: 3 })),
          kernel: () => Promise.resolve({ steps: 3 }),
        });
        expect(written(dir, "observable")).toMatchObject({
          verdict: "incomplete",
          failure: { side: "none" },
        });
        release();
        const record = yield* Effect.promise(() => running);
        expect(record.verdict).toBe("agree");
      }),
  );
});
