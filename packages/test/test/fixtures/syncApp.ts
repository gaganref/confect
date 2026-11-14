/**
 * The sync probe's app (`tools/local-backend/fixtures/sync`) on the test
 * kernel, and the kernel as a probe target.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import schema from "../../../../tools/local-backend/fixtures/sync/convex/schema";
import { convexTest, type KernelControls } from "../../src/internal/ConvexTest";
import * as Clock from "../../src/internal/Clock";
import type * as Kernel from "../../src/internal/Kernel";
import * as Redaction from "../../src/internal/Redaction";
import { provider } from "../../../../tools/local-backend/fixtures/minted";
import type { Target } from "./syncLegs";
import { withSources } from "./inlineSources";

const secretArgs = (fields: Record<string, Schema.Top>) => () =>
  Schema.Struct({ ...fields, secret: Schema.Redacted(Schema.String) });

/**
 * The secret arguments of the probe's app, as a test declares them through the
 * redaction policy.
 */
export const policy = Redaction.policy({
  functions: {
    "": {
      "sync:remember": { args: secretArgs({ name: Schema.String }) },
      "sync:reveal": { args: secretArgs({}) },
      "sync:peek": { args: secretArgs({}) },
      "sync:stash": { args: secretArgs({}) },
    },
  },
});

/**
 * The host clock, except that no two reads answer the same millisecond. The
 * app's time queries answer the time a run starts at. On a binary a rerun that
 * a client's message causes starts a network round trip after the run it
 * replaces. On the host clock the kernel's rerun can start inside that run's
 * millisecond, answer the same time, and send the client nothing new.
 */
export const distinctMillis = (): Kernel.KernelRuntime => {
  let latest = 0;
  const now = () => {
    latest = Math.max(Clock.hostNow(), latest + 1);
    return latest;
  };
  return { now, commitTs: () => BigInt(now()) * 1_000_000n };
};

/**
 * A fresh kernel backend running the probe's app, whose `auth.config` declares
 * the minted tokens' provider with `jwks`. Its clock is `distinctMillis` unless
 * `runtime` gives another.
 */
export const kernelApp = (
  jwks: string,
  options: {
    readonly redaction?: Redaction.Policy;
    readonly runtime?: Kernel.KernelRuntime;
    /**
     * Settles before the app's functions load, so a test can hold the backend's
     * first run open.
     */
    readonly loaded?: Promise<void>;
    /**
     * The binary's `MAX_CACHE_AGE` the backend's query cache keeps, in
     * milliseconds.
     */
    readonly queryCacheAge?: number;
  } = {},
): KernelControls =>
  convexTest({
    schema,
    ...withSources({
      "_generated/server.ts": () => Promise.resolve({}),
      "sync.ts": () =>
        (options.loaded ?? Promise.resolve()).then(
          () =>
            import("../../../../tools/local-backend/fixtures/sync/convex/sync"),
        ),
      "auth.config.ts": () =>
        Promise.resolve({ default: { providers: [{ ...provider, jwks }] } }),
    }),
    redaction: options.redaction ?? policy,
    runtime: options.runtime ?? distinctMillis(),
    ...(options.queryCacheAge === undefined
      ? {}
      : { queryCacheAge: options.queryCacheAge }),
  });

/**
 * `t`'s sync endpoint as a probe target. Its contention is the ledger's
 * increments that committed on a later attempt than their first.
 */
export const kernelTarget = (t: KernelControls): Target => {
  const endpoint = t.sync();
  return {
    name: "kernel",
    address: "http://127.0.0.1:9",
    WebSocket: endpoint.WebSocket as unknown as Target["WebSocket"],
    contention: (since) =>
      Effect.sync(
        () =>
          Arr.filter(
            endpoint.ledger(),
            (entry) =>
              entry.functionPath.udfPath === "sync:increment" &&
              entry.attempts > 1 &&
              entry.ts >= BigInt(since) * 1_000_000n,
          ).length,
      ),
  };
};
