// A module that keeps the host's `Math.random` when a test file imports it,
// before any kernel code runs. `Randomness.test.ts` shows it stays the host's.
export const { random: keptAtImport } = Math;
