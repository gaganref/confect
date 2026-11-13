/**
 * The three-leg sync protocol probe: the unmodified `convex` client runs each
 * leg against a binary this run started and against the test kernel's `Sync`,
 * and the normalised observations must agree. Each leg writes its record, bound
 * to the binary's process and checksum, the ports, the worktree and the
 * sources, under `.sync-probe/`, with every secret marked. A disagreement
 * records both sides' observations and stops the leg.
 */
// oxlint-disable effecttsgo/prefer-schema-over-json -- Observations are compared as canonical JSON text, as a record writes them.
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The fixture project's directory, for the CLI that reads its logs.
import * as Path from "node:path";
import { expect, layer } from "@effect/vitest";
import type { JSONValue } from "convex/values";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { mint } from "../../../test/test/fixtures/minted";
import { kernelApp, kernelTarget } from "../../../test/test/fixtures/syncApp";
import * as Legs from "../../../test/test/fixtures/syncLegs";
import * as LocalBackend from "./LocalBackend";
import * as SyncProbe from "./SyncProbe";

const fixture = Path.join(import.meta.dirname, "fixtures/sync");

const secret = "probe-canary-5d81e2";

const binaryTarget: Legs.Target = {
  name: "binary",
  address: LocalBackend.cloudUrl(LocalBackend.ports.sync),
  WebSocket: globalThis.WebSocket as unknown as Legs.Target["WebSocket"],
  contention: (since) => SyncProbe.contention(fixture, since),
};

const canonical = (json: unknown): unknown =>
  Array.isArray(json)
    ? json.map(canonical)
    : json !== null && typeof json === "object"
      ? Object.fromEntries(
          Object.keys(json)
            .sort()
            .map((key) => [
              key,
              canonical((json as Record<string, unknown>)[key]),
            ]),
        )
      : json;

/**
 * Run `leg` on the binary and on a fresh kernel, compare, and write the record.
 * `holds` is what both sides must also show on their own.
 */
const probe = (
  leg: string,
  run: (
    target: Legs.Target,
    kernel: ReturnType<typeof kernelApp>,
  ) => Promise<unknown>,
  jwks: string,
  holds: (observation: unknown) => boolean = () => true,
) =>
  Effect.gen(function* () {
    const binding = SyncProbe.bind({
      cloud: LocalBackend.ports.sync,
      site: LocalBackend.ports.sync + 1,
    });
    const t = kernelApp(jwks);
    const binary = yield* Effect.promise(() => run(binaryTarget, t));
    const kernel = yield* Effect.promise(() => run(kernelTarget(t), t));
    const agree =
      JSON.stringify(canonical(kernel)) === JSON.stringify(canonical(binary)) &&
      holds(kernel) &&
      holds(binary);
    const record = SyncProbe.write(
      {
        leg,
        verdict: agree ? "agree" : "disagree",
        binding,
        sources: SyncProbe.sources(binding.worktree),
        observations: {
          kernel: kernel as JSONValue,
          binary: binary as JSONValue,
        },
      },
      t.sync().redact,
    );
    return record as unknown as SyncProbe.ProbeRecord;
  });

const tokens = (backend: LocalBackend.LocalBackend["Service"]) =>
  Effect.gen(function* () {
    const { jwks, cases, signDeclared } = yield* mint(
      Math.floor((yield* Clock.currentTimeMillis) / 1000),
    );
    yield* backend.setEnv("TEST_AUTH_JWKS", jwks);
    yield* backend.redeploy;
    return {
      jwks,
      tokens: {
        person: cases.find((c) => c.name === "valid control")!.token,
        other: yield* signDeclared({ sub: "other", role: "teacher" }),
      },
    };
  });

layer(LocalBackend.syncLayer, {
  timeout: "300 seconds",
  excludeTestServices: true,
})("sync protocol probe against a runner-started binary", (it) => {
  it.effect(
    "leg 1, the observable protocol: per-socket values, mutation outcomes and terminal views agree, and the record holds no secret",
    () =>
      Effect.gen(function* () {
        const { jwks, tokens: minted } = yield* tokens(
          yield* LocalBackend.LocalBackend,
        );
        const run = `observable-${yield* Clock.currentTimeMillis}`;
        const record = yield* probe(
          "observable",
          (target) => Legs.observable(target, run, minted, secret),
          jwks,
          (observed) =>
            (observed as { readonly rejections: ReadonlyArray<string> })
              .rejections.length === 0,
        );
        expect(record.verdict, JSON.stringify(record.observations)).toBe(
          "agree",
        );
        expect(record.binding.pid).toBeGreaterThan(0);
        expect(record.binding.binary.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(record.binding).not.toHaveProperty("url");
        const written = JSON.stringify(record);
        expect(written).not.toContain(secret);
        expect(written).toContain("[redacted]");
      }),
  );

  it.effect(
    "leg 2, the OCC counter: both sides contend, and each counter ends at the increments that succeeded",
    () =>
      Effect.gen(function* () {
        const run = `occ-${yield* Clock.currentTimeMillis}`;
        const record = yield* probe(
          "occ",
          (target) => Legs.occ(target, run),
          "",
          (observed) =>
            JSON.stringify(observed) ===
            JSON.stringify({ contended: true, consistent: true }),
        );
        expect(record.verdict, JSON.stringify(record.observations)).toBe(
          "agree",
        );
      }),
  );

  it.effect(
    "leg 3, client acceptance: the unmodified client accepts every message on both, through a lost response and a reconnect",
    () =>
      Effect.gen(function* () {
        const { jwks, tokens: minted } = yield* tokens(
          yield* LocalBackend.LocalBackend,
        );
        const run = `acceptance-${yield* Clock.currentTimeMillis}`;
        const record = yield* probe(
          "acceptance",
          (target) => Legs.acceptance(target, run, minted),
          jwks,
          (observed) =>
            JSON.stringify(canonical(observed)) ===
            JSON.stringify(canonical(Legs.accepted)),
        );
        expect(record.verdict, JSON.stringify(record.observations)).toBe(
          "agree",
        );
      }),
  );
});
