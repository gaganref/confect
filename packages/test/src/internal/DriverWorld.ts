import * as Context from "effect/Context";
import * as Clock from "./Clock.js";
import type * as Invocation from "./Invocation.js";

/**
 * Mulberry32: a stream uniform on [0, 1) from a 32-bit seed. The kernel holds
 * no generator, so a driver supplies the stream, of the type a test world gives
 * its handlers.
 */
export const seeded = (seed: number): (() => number) => {
  let state = Math.trunc(seed) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

/**
 * The world a driver gives a kernel backend of its own: no services, the host's
 * clock, which the kernel's clock follows, and a stream seeded `seed`.
 * `TestConfect.layer`'s kernel target and the mock-backend kernel lane's shim
 * both open their backends with one.
 */
export const make = (name: string, seed: number): Invocation.World => ({
  name,
  services: Context.empty(),
  clock: Clock.hostNow,
  random: seeded(seed),
});
