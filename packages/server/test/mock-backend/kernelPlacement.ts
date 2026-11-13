import * as Array from "effect/Array";
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
  ...Array.map(
    [
      'mutation Blob transactions > preserves bytes, SHA256 and MIME type ""',
      "mutation Blob transactions > rolls back stored bytes and restores deleted files on failure",
    ],
    (name): Placement => ({
      file: "integration.test.ts",
      name,
      row: "binary",
      needs:
        "a file with no content type, which the binary and the kernel store with a null contentType that Confect's _storage schema refuses, where convex-test stores none",
    }),
  ),
  ...Array.map(
    [
      "preserves write accounting after caught limit failures: { filesWritten: 1 }",
      "preserves write accounting after caught limit failures: { fileWriteBytes: 4 }",
      "counts distinct reads and excludes caught failures: { filesRead: 1 }",
      "counts distinct reads and excludes caught failures: { fileReadBytes: 4 }",
    ],
    (name): Placement => ({
      file: "integration.test.ts",
      name: `mutation Blob transactions > ${name}`,
      row: 6,
      needs: "a deployment's transactionLimits option",
    }),
  ),
  {
    file: "integration.test.ts",
    name: "TestConfect JWT signing",
    row: 6,
    needs: "JWT signing and verification",
  },
  {
    file: "integration.test.ts",
    name: "DatabaseReader > uses the canonical Doc decoder for a text search",
    row: "binary",
    needs: "text search, which the kernel never simulates (RequiresBinary)",
  },
  {
    file: "integration.test.ts",
    name: "mock search compatibility",
    row: "binary",
    needs: "text search, which the kernel never simulates (RequiresBinary)",
  },
  {
    file: "integration.test.ts",
    name: "mock query compatibility > enforces search candidate limits without blocking early reads",
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
