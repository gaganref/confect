/**
 * The host's `Math` and `crypto`, captured once, when the kernel's modules load
 * and before the kernel installs anything. Every kernel-internal use reads
 * these and never `globalThis`, whose `Math` and `crypto` can be the kernel's
 * own wrappers: in a function's copy of the globals, or in place, when a test
 * left a global non-configurable but writable so the install assigned it. One
 * capture per test runtime, so every copy of this module shares the first.
 */
interface Captured {
  readonly Math: Math;
  readonly crypto: Crypto;
}

const key = Symbol.for("@confect/test/HostGlobals");

const captured: Captured = ((globalThis as { [key]?: Captured })[key] ??= {
  Math: globalThis.Math,
  crypto: globalThis.crypto,
});

export const math: Math = captured.Math;

export const crypto: Crypto = captured.crypto;
