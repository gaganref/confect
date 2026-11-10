/**
 * Lane 1's inventory (`packages/test/RECHECK.md`) as data: the mock-backend
 * cases the kernel lane does not run yet, and the build-order row that first
 * supplies what each needs. Every other case runs on the kernel.
 *
 * A `name` is a case's describe blocks and title, joined as `kernelLane.ts`
 * joins them. A describe block's name places every case inside it. An entry
 * without a `name` places the whole file. An entry that matches no case fails
 * the lane, so the list only shrinks as rows land.
 */
export interface Placement {
  readonly file: string;
  readonly name?: string;
  readonly row: number | "binary";
  readonly needs: string;
}

export const placements: ReadonlyArray<Placement> = [
  { file: "http.test.ts", row: 6, needs: "HTTP routes, after storage" },
  {
    file: "integration.test.ts",
    name: "Storage",
    row: 6,
    needs: "storage",
  },
  {
    file: "integration.test.ts",
    name: "TransactionMetadata",
    row: 6,
    needs: "transaction limits",
  },
  {
    file: "integration.test.ts",
    name: "Scheduler",
    row: 5,
    needs: "the scheduler",
  },
  {
    file: "integration.test.ts",
    name: "DatabaseReader > uses the canonical Doc decoder across database read paths",
    row: "binary",
    needs: "text search, which the kernel never simulates (RequiresBinary)",
  },
  {
    file: "components.test.ts",
    name: "verifies app and generated component mutation JWTs against deployment JWKS",
    row: 6,
    needs: "JWT verification",
  },
  {
    file: "components.test.ts",
    name: "cancels component jobs from runAfter and runAt before they execute",
    row: 5,
    needs: "the scheduler",
  },
  ...[
    "fetches each mounted component with its site URL at construction",
    "routes mounted HTTP writes into the selected component database",
    "keeps query strings and headers at the exact mount path",
    "leaves unmounted paths and partial prefix matches to the root",
    "restores the site URL after construction fails and accepts another fetch",
    "preserves structured HTTP compatibility failures across the action boundary",
    "uses the default site URL when the application variable is empty",
    "loads component HTTP modules with convex-test's extension handling",
    "fetches an installation mounted at the root prefix",
  ].map((name): Placement => ({
    file: "components.test.ts",
    name,
    row: 6,
    needs: "HTTP routes, after storage",
  })),
  ...[
    "a component stores a host handle and calls it back through the scheduler and the runner",
    "a handle called with args outside the host's validator fails the component as a defect",
    "refuses to create a handle for a host function whose validators differ from the contract",
    "a profiled component action calls a decoded host callback",
  ].map((name): Placement => ({
    file: "components.test.ts",
    name,
    row: 5,
    needs: "stored function handles",
  })),
];
