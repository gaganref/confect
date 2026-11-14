import { getCallSites } from "node:util";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
/**
 * The convex-test lane's conformance exceptions as data, and the rule each
 * entry must meet. An exception is a mock-backend case that holds the test
 * kernel's behaviour where convex-test does otherwise: either the kernel
 * departs from the binary on purpose, as action egress does, or convex-test
 * departs from the binary, which the kernel follows, as for a route that
 * throws. The kernel lane runs every one as an ordinary case. The lane
 * (`convexTestLane.ts`) runs each excepted case and requires it to fail there
 * with the outcomes its entry expects, and with no error but its own
 * assertions. A case that passes on convex-test, fails for another reason or is
 * skipped fails the lane, so the list only shrinks.
 */

/**
 * What one function a case calls did: returned a value, or failed with an
 * error's tag (or name) and message.
 */
export type Outcome =
  | { readonly function: string; readonly returned: unknown }
  | {
      readonly function: string;
      readonly failed: { readonly tag: string; readonly message: string };
    };

const outcomesKey = "conformanceOutcomes";

/**
 * Record what each function an excepted case calls did, for the convex-test
 * lane to compare with its entry. A case records before it asserts.
 */
export const recordOutcomes = (
  task: { readonly meta: object },
  outcomes: ReadonlyArray<Outcome>,
) => {
  (task.meta as Record<string, unknown>)[outcomesKey] = outcomes;
};

const departureKey = "conformanceDeparture";

/**
 * The expected assertion of an excepted case, as the case ran it: its failure
 * message and the file that called {@link departs}.
 */
export interface Departure {
  readonly message: string;
  readonly file: string;
}

/**
 * Run the case's departure assertion, the one that fails on convex-test where
 * the binary's behaviour holds. Its failure is recorded with the file that made
 * the call, so the lane takes only that failure, raised from the case's own
 * body, for the departure.
 */
export const departs = (
  task: { readonly meta: object },
  assertion: () => void,
) => {
  try {
    assertion();
  } catch (error) {
    const caller = getCallSites(2)[1]?.scriptName ?? "";
    (task.meta as Record<string, unknown>)[departureKey] = {
      message: (error as { readonly message?: string }).message ?? "",
      file: pipe(
        caller,
        Str.replaceAll("\\", "/"),
        Str.split("/"),
        Arr.last,
        Option.getOrElse(() => ""),
      ),
    } satisfies Departure;
    throw error;
  }
};

export const recordedDeparture = (task: {
  readonly meta: object;
}): Departure | undefined =>
  (task.meta as Record<string, Departure | undefined>)[departureKey];

export const recordedOutcomes = (task: {
  readonly meta: object;
}): ReadonlyArray<Outcome> | undefined =>
  (task.meta as Record<string, ReadonlyArray<Outcome> | undefined>)[
    outcomesKey
  ];

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
   * What each function the case calls does on convex-test. A case that records
   * anything else fails the lane.
   */
  readonly outcomes: ReadonlyArray<Outcome>;
  /**
   * The message the case's departure assertion fails with on convex-test,
   * exactly. The case must fail with that one error, raised through
   * {@link departs} in its own body, and no other, so a failing hook or any
   * unrelated assertion fails the lane.
   */
  readonly departure: string;
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
    convexTest: "0.0.67",
    binary:
      "The binary performs a raw fetch in an action and a Node action, and the action returns the response. The test kernel refuses it with BackendRefusal UndeclaredFetch, so egress goes through a provider port and a run replays. This is the kernel's one deliberate departure (Frame ADR 0012, action egress row).",
    outcomes: [
      { function: "groups/egress:rawFetch", returned: "reached /ping" },
      { function: "egressNode:rawFetchNode", returned: "reached /ping" },
    ],
    departure:
      "expected [ { …(2) }, { …(2) } ] to deeply equal [ { …(2) }, { …(2) } ]",
    owner: "@confect/test kernel, build-order row 6 (action egress)",
    evidence:
      "packages/server/test/local-backend/egress.test.ts > action egress > an action and a Node action perform a raw fetch, on precompiled-2026-10-28-cccbade: each reaches a loopback server and returns its response. convex-backend cccbade4: an action's start_async_op starts the fetch as a task (crates/isolate/src/environment/action/mod.rs:1639-1645), which task_executor.rs:151 hands to run_fetch (action/fetch.rs:34); only a cloud proxy's 407 refuses a host (crates/http_client/src/lib.rs:131-134). Positive control: packages/test/test/Egress.test.ts > provider ports > a port call in an action is held as a command until the test answers it.",
  },
  {
    file: "egressModuleLoad.test.ts",
    name: 'action egress while a module loads > a "use node" module\'s top-level fetch dies with UndeclaredFetch naming the module and host',
    convexTest: "0.0.67",
    binary:
      "The binary's Node executor imports a \"use node\" module with Node's own fetch, so a fetch its top level starts while it loads reaches the host, and the action then runs. The test kernel refuses it with BackendRefusal UndeclaredFetch naming the module and the host, and the load, so the open, fails with it. Part of the action egress departure: kernel-run code reaches the network only through a provider port (Frame ADR 0012, action egress row).",
    outcomes: [
      { function: "egressNode:rawFetchNode", returned: "reached /ping" },
    ],
    departure:
      "expected { outcome: { …(2) }, hits: 2 } to deeply equal { outcome: { …(2) }, hits: +0 }",
    owner: "@confect/test kernel, build-order row 6 (action egress)",
    evidence:
      'packages/server/test/local-backend/ioBans.test.ts > I/O bans while a module loads > a "use node" module\'s top-level fetch is answered, where the kernel refuses it with UndeclaredFetch, on precompiled-2026-10-28-cccbade: the plain fixture\'s moduleLoadFetchNode module fetches the deployment\'s own /ok route and its action returns { status: 200, body: "ok" }. convex-backend: the Node executor sets up its globals and imports the module (npm-packages/node-executor/src/executor.ts:410), and setupGlobals sets require, exports, module, __dirname and __filename only (:70-81), so the module keeps Node\'s fetch. Kernel side: packages/test/test/IoBans.test.ts > module loads > a "use node" module\'s top-level fetch dies with UndeclaredFetch naming the module and its host, and never reaches it, while its timers run.',
  },
  {
    file: "httpRouteError.test.ts",
    name: "HTTP route errors > a root route that throws an Error answers the binary's 500 JSON error body",
    convexTest: "0.0.67",
    binary:
      'The binary answers 500, application/json, {"code":"[Request ID: <16 hex>] Server Error: Uncaught Error: <message>","trace":"Uncaught Error: <message>\\n    at …\\n"}. convex-test rejects the fetch with the thrown Error.',
    outcomes: [
      {
        function: "GET /convex-native/throws",
        failed: { tag: "Error", message: "The route failed." },
      },
    ],
    departure: "expected { …(2) } to deeply equal { …(2) }",
    owner: "@confect/test kernel, build-order row 6 (HTTP and signed ingress)",
    evidence:
      "packages/server/test/local-backend/httpErrors.test.ts > HTTP route errors on the binary > a route that throws an Error answers 500 with the redacted-error JSON body, on precompiled-2026-10-28-cccbade. convex-backend cccbade: Application::run_http_action sends RedactedJsError::to_http_response_parts (crates/application/src/lib.rs:1542-1548), which builds the body (crates/application/src/redaction.rs:143-160) through HttpActionResponsePart::from_json (crates/udf/src/http_action.rs:133-141).",
  },
  {
    file: "httpRouteConvexError.test.ts",
    name: "HTTP route errors > a root route that throws a ConvexError answers the binary's 500 JSON error body with its data",
    convexTest: "0.0.67",
    binary:
      "The binary answers 500, application/json, with code and trace naming Uncaught ConvexError and the error's JSON, and data holding the ConvexError's data. convex-test rejects the fetch with the thrown ConvexError.",
    outcomes: [
      {
        function: "GET /convex-native/throws-convex-error",
        failed: {
          tag: "ConvexError",
          message: '{"code":"denied","attempt":2}',
        },
      },
    ],
    departure: "expected { …(2) } to deeply equal { …(2) }",
    owner: "@confect/test kernel, build-order row 6 (HTTP and signed ingress)",
    evidence:
      "packages/server/test/local-backend/httpErrors.test.ts > HTTP route errors on the binary > a route that throws a ConvexError answers 500 with its data, on precompiled-2026-10-28-cccbade. convex-backend cccbade: custom_data_if_any adds data (crates/application/src/redaction.rs:156-158).",
  },
];

/**
 * One case a run collected: its file, relative to the mock-backend suite, its
 * full name, and the state it ended in.
 */
export interface CollectedCase {
  readonly file: string;
  readonly name: string;
  readonly state: string;
}

/**
 * The excepted cases a run did not run, read from the run's own results: an
 * entry whose exact file and full name the run never collected, or collected in
 * a state other than passed or failed. Every reason a case does not run looks
 * the same here, whether a path filter, a glob or literal exclusion in the
 * lane's config, a renamed case or a skip, so each fails the run.
 */
export const unrunExceptions = (
  entries: ReadonlyArray<ConformanceException>,
  collected: ReadonlyArray<CollectedCase>,
): ReadonlyArray<ConformanceException> =>
  Arr.filter(
    entries,
    (entry) =>
      !Arr.some(
        collected,
        ({ file, name, state }) =>
          file === entry.file &&
          name === entry.name &&
          (state === "passed" || state === "failed"),
      ),
  );

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
    "departure",
    "owner",
    "evidence",
  ] as const) {
    if (Str.isEmpty(Str.trim(entry[field])))
      refused.push(`${label} has no ${field}.`);
  }
  if (entry.outcomes.length === 0) {
    refused.push(`${label} expects no outcomes. Name each function it calls.`);
  }
  if (glob.test(entry.name) || glob.test(entry.file)) {
    refused.push(`${label} is a pattern. Name one case exactly.`);
  }
  if (entry.convexTest !== convexTestVersion) {
    refused.push(
      `${label} was checked against convex-test ${entry.convexTest}, but ${convexTestVersion} is installed. Re-check it and update its version.`,
    );
  }
  if (Arr.some(cases, Str.startsWith(`${entry.name} > `))) {
    refused.push(`${label} names a describe block. Name one case exactly.`);
  } else if (!cases.includes(entry.name)) {
    refused.push(`${label} names no case the file has.`);
  }
  return refused;
};
