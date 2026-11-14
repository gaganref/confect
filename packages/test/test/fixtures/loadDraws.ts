// A module that draws from every random source while it loads.
// `loadDrawReplay.ts` registers it on the test kernel and prints what it drew.
export const drawn = {
  // oxlint-disable-next-line effecttsgo/global-random -- The module draws at module scope while it loads, as a pushed Convex module may.
  mathRandom: [Math.random(), Math.random()],
  getRandomValues: Array.from(crypto.getRandomValues(new Uint8Array(8))),
  // oxlint-disable-next-line effecttsgo/crypto-random-uuid -- The module draws at module scope while it loads, as a pushed Convex module may.
  randomUUID: crypto.randomUUID(),
};
