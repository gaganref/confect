"use node";

import { actionGeneric } from "convex/server";

/**
 * What this `"use node"` module's top-level `fetch` of the deployment's own
 * `/ok` route answers: its status and body, or the error it rejects with. The
 * binary's Node executor imports it with Node's own `fetch`. The test kernel
 * refuses the same call with `UndeclaredFetch` (the action egress conformance
 * exception in `packages/server/test/mock-backend/conformance.ts`).
 */
// oxlint-disable-next-line effecttsgo/global-fetch -- The module's top level calls the runtime's own fetch, which is what the probe measures.
const started = fetch(`${process.env["CONVEX_SITE_URL"]}/ok`).then(
  (response) =>
    response.text().then((body) => ({ status: response.status, body })),
  (error: Error) => ({ name: error.name, message: error.message }),
);

export const loaded = actionGeneric({ args: {}, handler: () => started });
