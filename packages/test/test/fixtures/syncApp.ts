/**
 * The sync probe's app (`packages/server/test/local-backend/fixtures/sync`) on
 * the test kernel, and the kernel as a probe target.
 */
import * as Schema from "effect/Schema";
import schema from "../../../server/test/local-backend/fixtures/sync/convex/schema";
import { convexTest, type KernelControls } from "../../src/internal/ConvexTest";
import type * as Kernel from "../../src/internal/Kernel";
import * as Redaction from "../../src/internal/Redaction";
import { provider } from "./minted";
import type { Target } from "./syncLegs";

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
 * A fresh kernel backend running the probe's app, whose `auth.config` declares
 * the minted tokens' provider with `jwks`.
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
  } = {},
): KernelControls =>
  convexTest({
    schema,
    modules: {
      "_generated/server.ts": () => Promise.resolve({}),
      "sync.ts": () =>
        (options.loaded ?? Promise.resolve()).then(
          () =>
            import("../../../server/test/local-backend/fixtures/sync/convex/sync"),
        ),
      "auth.config.ts": () =>
        Promise.resolve({ default: { providers: [{ ...provider, jwks }] } }),
    },
    redaction: options.redaction ?? policy,
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
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
      Promise.resolve(
        endpoint
          .ledger()
          .filter(
            (entry) =>
              entry.functionPath.udfPath === "sync:increment" &&
              entry.attempts > 1 &&
              entry.ts >= BigInt(since) * 1_000_000n,
          ).length,
      ),
  };
};
