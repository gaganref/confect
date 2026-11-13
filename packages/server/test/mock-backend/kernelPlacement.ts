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
  {
    file: "integration.test.ts",
    name: "DatabaseReader > uses the canonical Doc decoder for a text search",
    row: "binary",
    needs: "text search, which the kernel never simulates (RequiresBinary)",
  },
  {
    file: "components.test.ts",
    name: "verifies app and generated component mutation JWTs against deployment JWKS",
    row: 6,
    needs: "JWT verification",
  },
];
