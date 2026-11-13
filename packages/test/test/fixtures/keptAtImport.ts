/**
 * Globals a module keeps when it is imported, as an HTTP client or a scheduler
 * does. `IoBans.test.ts` imports this before any test backend exists, so these
 * are whatever `@confect/test/setup` left on `globalThis`.
 */
export const keptFetch = globalThis.fetch;
export const keptSetImmediate = globalThis.setImmediate;
