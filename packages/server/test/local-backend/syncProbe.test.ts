/**
 * The three-leg sync protocol probe: the unmodified `convex` client runs each
 * leg against a binary this run started and against the test kernel's `Sync`,
 * and the normalised observations must agree. Each leg writes its record, bound
 * to the binary's process and checksum, the ports, the worktree and the
 * sources, under `.sync-probe/`, with every secret marked. The record is
 * `incomplete` until the leg finishes, and stays so, with partial observations,
 * if a side fails or passes its deadline.
 *
 * The binding reads `/proc`, so the probe runs on Linux only. Elsewhere it is
 * skipped, with the reason in its name, before any backend starts.
 */
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The fixture project's directory, for the CLI that reads its logs.
import * as Path from "node:path";
import { describe, expect, it, layer } from "@effect/vitest";
import * as LocalBackend from "confect-local-backend/LocalBackend";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { mint } from "../../../test/test/fixtures/minted";
import { kernelApp, kernelTarget } from "../../../test/test/fixtures/syncApp";
import * as Legs from "../../../test/test/fixtures/syncLegs";
import * as SyncProbe from "./SyncProbe";

import * as Json from "../../../test/src/internal/Json";

const encodeJson = Json.stringify;

const fixture = Path.join(
  import.meta.dirname,
  "../../../../tools/local-backend/fixtures/sync",
);

const secret = "probe-canary-5d81e2";

/**
 * The binary's `MAX_CACHE_AGE` under the harness's reduced UDF timeouts, which
 * the kernel's query cache keeps too.
 */
const cacheAge = Duration.toMillis(LocalBackend.maxCacheAge);

/**
 * How long one side of a leg may take, every step's own deadline included.
 */
const deadline = 120_000;

const binaryTarget: Legs.Target = {
  name: "binary",
  address: LocalBackend.cloudUrl(LocalBackend.ports.sync),
  WebSocket: globalThis.WebSocket as unknown as Legs.Target["WebSocket"],
  contention: (since) => SyncProbe.contention(fixture, since),
};

/**
 * Run `leg` on the binary and on a fresh kernel through `SyncProbe.runLeg`, and
 * answer the record it wrote.
 */
const probe = (
  leg: string,
  run: (target: Legs.Target, progress: Legs.Progress) => Promise<unknown>,
  jwks: string,
  holds: (observation: unknown) => boolean = () => true,
) =>
  Effect.gen(function* () {
    const binding = SyncProbe.bind({
      cloud: LocalBackend.ports.sync,
      site: LocalBackend.ports.sync + 1,
    });
    const t = kernelApp(jwks, { queryCacheAge: cacheAge });
    return yield* Effect.promise(() =>
      SyncProbe.runLeg({
        leg,
        binding,
        sources: SyncProbe.sources(binding.worktree),
        deadline,
        binary: (progress) => run(binaryTarget, progress),
        kernel: (progress) => run(kernelTarget(t), progress),
        holds,
        redact: t.sync().redact,
      }),
    );
  });

const tokens = (backend: LocalBackend.LocalBackend["Service"]) =>
  Effect.gen(function* () {
    const millis = yield* Clock.currentTimeMillis;
    const { jwks, cases, signDeclared } = yield* mint(
      Math.floor(millis / 1000),
    );
    yield* backend.setEnv("TEST_AUTH_JWKS", jwks);
    yield* backend.redeploy;
    const other = yield* signDeclared({ sub: "other", role: "teacher" });
    return {
      jwks,
      tokens: {
        person: Option.getOrThrow(
          Arr.findFirst(cases, (c) => c.name === "valid control"),
        ).token,
        other,
      },
    };
  });

const same = (a: unknown, b: unknown) =>
  encodeJson(SyncProbe.canonical(a)) === encodeJson(SyncProbe.canonical(b));

if (!SyncProbe.supported) {
  describe.skip(`sync protocol probe against a runner-started binary: skipped on ${process.platform}, since its record binds the binary's process through /proc, which only Linux has`, () => {
    it("leg 1, leg 2 and leg 3", () => undefined);
  });
} else {
  layer(LocalBackend.syncLayer, {
    timeout: "600 seconds",
    excludeTestServices: true,
  })("sync protocol probe against a runner-started binary", (test) => {
    test.effect(
      "leg 1, the observable protocol: per-socket values, mutation outcomes, terminal views and a time query an expired cache entry answers anew agree, and the record holds no secret",
      () =>
        Effect.gen(function* () {
          const backend = yield* LocalBackend.LocalBackend;
          const { jwks, tokens: minted } = yield* tokens(backend);
          const millis = yield* Clock.currentTimeMillis;
          const run = `observable-${millis}`;
          const record = yield* probe(
            "observable",
            (target, progress) =>
              Legs.observable(target, run, minted, secret, {
                cacheAge,
                progress,
              }),
            jwks,
            (observed) =>
              (observed as { readonly rejections: ReadonlyArray<string> })
                .rejections.length === 0,
          );
          expect(record.verdict, encodeJson(record)).toBe("agree");
          expect(record.binding.pid).toBeGreaterThan(0);
          expect(record.binding.binary.sha256).toMatch(/^[0-9a-f]{64}$/);
          expect(record.binding).not.toHaveProperty("url");
          const written = encodeJson(record);
          expect(written).not.toContain(secret);
          expect(written).toContain("[redacted]");
        }),
    );

    test.effect(
      "leg 2, the OCC counter: both sides contend, and each counter ends at the increments that succeeded",
      () =>
        Effect.gen(function* () {
          const millis = yield* Clock.currentTimeMillis;
          const run = `occ-${millis}`;
          const record = yield* probe(
            "occ",
            (target, progress) => Legs.occ(target, run, { progress }),
            "",
            (observed) => same(observed, { contended: true, consistent: true }),
          );
          expect(record.verdict, encodeJson(record)).toBe("agree");
        }),
    );

    test.effect(
      "leg 3, client acceptance: the unmodified client accepts every message on both, through a lost response and a reconnect",
      () =>
        Effect.gen(function* () {
          const backend = yield* LocalBackend.LocalBackend;
          const { jwks, tokens: minted } = yield* tokens(backend);
          const millis = yield* Clock.currentTimeMillis;
          const run = `acceptance-${millis}`;
          const record = yield* probe(
            "acceptance",
            (target, progress) =>
              Legs.acceptance(target, run, minted, { progress }),
            jwks,
            (observed) => same(observed, Legs.accepted),
          );
          expect(record.verdict, encodeJson(record)).toBe("agree");
        }),
    );
  });
}
