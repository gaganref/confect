// A module an action imports lazily. It draws from every random source at
// module scope, so it draws when the action first imports it, from the
// action's stream.
export const drawn = {
  // oxlint-disable-next-line effecttsgo/global-random -- The module draws at module scope when an action imports it lazily.
  random: Math.random(),
  bytes: Array.from(crypto.getRandomValues(new Uint8Array(2))),
  // oxlint-disable-next-line effecttsgo/crypto-random-uuid -- The module draws at module scope when an action imports it lazily.
  uuid: crypto.randomUUID(),
};
