/**
 * The host's `Math` and `crypto`, and the `Request` and `Response` the I/O
 * guards build and patch with, captured once, when the kernel's modules load
 * and before the kernel installs anything. Every kernel-internal use reads
 * these and never `globalThis`, whose `Math` and `crypto` can be the kernel's
 * own wrappers: in a function's copy of the globals, or in place, when a test
 * left a global non-configurable but writable so the install assigned it, and
 * whose `Request` a test can stub. One capture per test runtime, so every copy
 * of this module shares the first. Each is captured on its own, so a copy of
 * this module that adds one fills it in beside an earlier copy's capture.
 */
interface Captured {
  Math?: Math;
  crypto?: Crypto;
  Request?: typeof Request;
  Response?: typeof Response;
}

const key = Symbol.for("@confect/test/HostGlobals");

const captured: Captured = ((globalThis as { [key]?: Captured })[key] ??= {});
captured.Math ??= globalThis.Math;
captured.crypto ??= globalThis.crypto;
captured.Request ??= globalThis.Request;
captured.Response ??= globalThis.Response;

export const math: Math = captured.Math;

export const crypto: Crypto = captured.crypto;

/**
 * The host's `Request`, which the I/O guards build a refused `fetch`'s request
 * with and whose prototype's `formData` they guard.
 */
export const request: typeof Request = captured.Request;

/**
 * The host's `Response`, whose prototype's `formData` the I/O guards guard.
 */
export const response: typeof Response = captured.Response;
