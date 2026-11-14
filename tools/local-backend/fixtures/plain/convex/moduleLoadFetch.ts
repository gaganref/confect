import { actionGeneric, queryGeneric } from "convex/server";

/**
 * What this module's top-level `fetch` of the deployment's own `/ok` route
 * answers: its status and body, or the error it rejects with. The module has no
 * `"use node"` directive, so the binary imports it in its isolate, in the
 * environment of the function it runs: the query's, which refuses the fetch, or
 * the action's, which answers it. The test kernel refuses both (kernel boundary
 * `ActionModuleLoadFetch` in
 * `packages/server/test/mock-backend/kernelBoundaries.ts`).
 */
// oxlint-disable-next-line effecttsgo/global-fetch -- The module's top level calls the runtime's own fetch, which is what the probe measures.
const started = fetch(`${process.env["CONVEX_SITE_URL"]}/ok`).then(
  (response) =>
    response.text().then((body) => ({ status: response.status, body })),
  (error: Error) => ({ name: error.name, message: error.message }),
);

export const loaded = actionGeneric({ args: {}, handler: () => started });

export const loadedQuery = queryGeneric({ args: {}, handler: () => started });
