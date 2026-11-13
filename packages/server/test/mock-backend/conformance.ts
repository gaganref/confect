/**
 * The convex-test lane's conformance exceptions as data, and the rule each
 * entry must meet. An exception is a mock-backend case that holds the test
 * kernel's behaviour where the Convex binary, and convex-test with it, does
 * otherwise on purpose. The lane (`convexTestLane.ts`) runs each excepted case
 * and requires it to fail there. A case that passes on convex-test fails the
 * lane, so the list only shrinks.
 */

export interface ConformanceException {
  readonly file: string;
  /**
   * One case's describe blocks and title, joined by " > ", exactly. A describe
   * block, a pattern or a whole file is refused.
   */
  readonly name: string;
  /**
   * The convex-test version the entry was checked against. An entry for another
   * version is refused, so a bump re-checks it.
   */
  readonly convexTest: string;
  /**
   * What the binary does instead of what the case asserts.
   */
  readonly binary: string;
  /**
   * Text the case's failure on convex-test contains, which shows the binary
   * behaviour. A failure without it is the case's own, and fails the lane.
   */
  readonly observed: string;
  readonly owner: string;
  /**
   * Where the binary behaviour is shown, by test and source.
   */
  readonly evidence: string;
}

export const exceptions: ReadonlyArray<ConformanceException> = [
  {
    file: "egress.test.ts",
    name: "action egress > a raw fetch in an action or a Node action dies with UndeclaredFetch naming the action and host",
    convexTest: "0.0.65",
    binary:
      "The binary performs a raw fetch in an action and a Node action, and the action returns the response. The test kernel refuses it with BackendRefusal UndeclaredFetch, so egress goes through a provider port and a run replays. This is the kernel's one deliberate departure (Frame ADR 0012, action egress row).",
    observed: "reached /ping",
    owner: "@confect/test kernel, build-order row 6 (action egress)",
    evidence:
      "packages/server/test/local-backend/egress.test.ts > action egress > an action and a Node action perform a raw fetch, on precompiled-2026-10-28-cccbade: each reaches a loopback server and returns its response. convex-backend cccbade4: an action's start_async_op starts the fetch as a task (crates/isolate/src/environment/action/mod.rs:1639-1645), which task_executor.rs:151 hands to run_fetch (action/fetch.rs:34); only a cloud proxy's 407 refuses a host (crates/http_client/src/lib.rs:131-134). Positive control: packages/test/test/Egress.test.ts > provider ports > a port call in an action is held as a command until the test answers it.",
  },
];

const glob = /[*?[\]{}]/;

/**
 * Why `entry` is refused, given the full names of every case in its file and
 * the installed convex-test version. Empty when it holds.
 */
export const refusals = (
  entry: ConformanceException,
  cases: ReadonlyArray<string>,
  convexTestVersion: string,
): ReadonlyArray<string> => {
  const refused: Array<string> = [];
  const label = `${entry.file} "${entry.name}"`;
  for (const field of [
    "file",
    "name",
    "convexTest",
    "binary",
    "observed",
    "owner",
    "evidence",
  ] as const) {
    if (entry[field].trim() === "") refused.push(`${label} has no ${field}.`);
  }
  if (glob.test(entry.name) || glob.test(entry.file)) {
    refused.push(`${label} is a pattern. Name one case exactly.`);
  }
  if (entry.convexTest !== convexTestVersion) {
    refused.push(
      `${label} was checked against convex-test ${entry.convexTest}, but ${convexTestVersion} is installed. Re-check it and update its version.`,
    );
  }
  if (cases.some((name) => name.startsWith(`${entry.name} > `))) {
    refused.push(`${label} names a describe block. Name one case exactly.`);
  } else if (!cases.includes(entry.name)) {
    refused.push(`${label} names no case the file has.`);
  }
  return refused;
};
