import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "@effect/vitest";
import * as LocalBackend from "confect-local-backend/LocalBackend";
import { makeFunctionReference } from "convex/server";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Str from "effect/String";

/**
 * The push check contract: `@confect/server/PushCheck` relies on Convex calling
 * each function's `exportArgs`, marked `@internal`, while it analyzes a push
 * and never while it serves a call. This suite pins that on the pinned local
 * backend, through the `convex dev` watcher, with the Convex wording an author
 * sees. A Convex upgrade that breaks it fails here.
 *
 * Each target's `confect/verdict.ts` names the entry whose analysis its checks
 * refuse (`tools/local-backend/fixtures/guard/checks.ts`). A case writes a
 * refusing verdict with a new version, reads what the watcher printed for the
 * push, checks the deployment still serves the last version, and restores the
 * verdict.
 */

const fixture = "../../../../tools/local-backend/fixtures/guard";

const verdicts = {
  host: "confect/verdict.ts",
  component: "components/guarded/confect/verdict.ts",
} as const;

const passing = '{ version: 1, refuse: "none" }';

const READY_LINE = "Convex functions ready!";

const writeVerdict = (target: keyof typeof verdicts, verdict: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.resolve(import.meta.dirname, fixture, verdicts[target]);
    const contents = yield* fs.readFileString(file);
    yield* fs.writeFileString(
      file,
      Str.replace(/Verdict = \{[^}]*\}/, `Verdict = ${verdict}`)(contents),
    );
  });

const query = (path: string) =>
  Effect.flatMap(LocalBackend.LocalBackend, ({ client }) =>
    Effect.promise(() =>
      client.query(makeFunctionReference<"query", {}, number>(path), {}),
    ),
  );

const mutation = (path: string) =>
  Effect.flatMap(LocalBackend.LocalBackend, ({ client }) =>
    Effect.promise(() =>
      client.mutation(makeFunctionReference<"mutation", {}, number>(path), {}),
    ),
  );

const action = (path: string) =>
  Effect.flatMap(LocalBackend.LocalBackend, ({ client }) =>
    Effect.promise(() =>
      client.action(makeFunctionReference<"action", {}, number>(path), {}),
    ),
  );

const route = (path: string) =>
  HttpClient.get(LocalBackend.siteUrl(path, LocalBackend.ports.guard)).pipe(
    Effect.flatMap((response) => response.text),
    Effect.orDie,
  );

/**
 * The version each entry serves: the isolate's, the Node executor's, the
 * component's and the HTTP router's.
 */
const served = Effect.all({
  isolate: query("probe:version"),
  node: action("probeNode:version"),
  component: query("probe:componentVersion"),
  http: route("/guard/version"),
});

const firstVersion = { isolate: 1, node: 1, component: 1, http: "1" };

/**
 * Every entry serves the first version.
 */
const servesFirstVersion = Effect.map(served, (versions) =>
  expect(versions).toEqual(firstVersion),
);

/**
 * Push `verdict` to `target` through the watcher, and the watcher's lines for
 * that push once one matches `printed`. The passing verdict is pushed back
 * after `use`, failing or not.
 */
const refusing = <A, E, R>(
  target: keyof typeof verdicts,
  verdict: string,
  printed: string,
  use: (output: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const backend = yield* LocalBackend.LocalBackend;
    return yield* Effect.acquireUseRelease(
      Effect.gen(function* () {
        const mark = yield* backend.outputMark;
        yield* writeVerdict(target, verdict);
        // Short enough that a push that never refuses leaves the release
        // time to restore the verdict within the case's timeout.
        const lines = yield* backend.awaitOutput(
          mark,
          Str.includes(printed),
          "45 seconds",
        );
        return Arr.join(lines, "\n");
      }),
      use,
      () =>
        Effect.gen(function* () {
          const mark = yield* backend.outputMark;
          yield* writeVerdict(target, passing);
          yield* backend.awaitOutput(mark, Str.includes(READY_LINE));
        }).pipe(Effect.orDie),
    );
  });

/**
 * The guard backend, started from passing verdicts, so a run that stopped
 * before restoring one cannot refuse this run's first push.
 */
const guardBackend = Layer.unwrap(
  Effect.all([
    writeVerdict("host", passing),
    writeVerdict("component", passing),
  ]).pipe(Effect.as(LocalBackend.guardLayer)),
).pipe(Layer.provide(NodeServices.layer));

// `excludeTestServices` keeps the live clock, which the watcher's output is
// polled on.
layer(Layer.mergeAll(guardBackend, NodeServices.layer, FetchHttpClient.layer), {
  timeout: "240 seconds",
  excludeTestServices: true,
})("push checks on the local backend", (it) => {
  it.effect(
    "serving a call runs no check, in the isolate, Node, a component or HTTP",
    () =>
      Effect.gen(function* () {
        yield* servesFirstVersion;
        // Every call evaluates its module graph afresh, so each reads the checks
        // that graph ran: none, as only push analysis calls `exportArgs`.
        const isolate = yield* Effect.all([
          query("probe:checkRuns"),
          mutation("probe:touch"),
          action("probe:act"),
          query("probe:componentCheckRuns"),
          route("/guard/checkRuns"),
        ]);
        expect(isolate).toEqual([0, 0, 0, 0, "0"]);
        // The Node executor keeps one process, so it may reuse a graph across
        // calls; a call still adds no run.
        const node = yield* Effect.all([
          action("probeNode:checkRuns"),
          action("probeNode:checkRuns"),
        ]);
        expect(node).toEqual([0, 0]);
      }),
    { timeout: 180_000 },
  );

  it.effect(
    "a refusal in the isolate's analysis refuses the push, naming the check, the function and the declaration",
    () =>
      refusing(
        "host",
        '{ version: 2, refuse: "isolate" }',
        'host declaration "refused-in-isolate"',
        (output) =>
          Effect.gen(function* () {
            expect(output).toContain("Hit an error while pushing:");
            // Analysis calls `exportArgs` in export name order and stops at
            // the first throw.
            expect(output).toContain(
              'Uncaught PushRefused: Push check "functions" refused the source while Convex analyzed probe:act: host declaration "refused-in-isolate" in confect/verdict.ts is refused',
            );
            yield* servesFirstVersion;
          }),
      ),
    { timeout: 180_000 },
  );

  it.effect(
    "a refusal in a Node action's analysis refuses the push, naming the check, the function and the declaration",
    () =>
      refusing(
        "host",
        '{ version: 2, refuse: "node" }',
        'host declaration "refused-in-node"',
        (output) =>
          Effect.gen(function* () {
            expect(output).toContain(
              'Failed to analyze probeNode.js: Push check "functions" refused the source while Convex analyzed probeNode:checkRuns: host declaration "refused-in-node" in confect/verdict.ts is refused',
            );
            yield* servesFirstVersion;
          }),
      ),
    { timeout: 180_000 },
  );

  it.effect(
    "a refusal in a component's analysis refuses the host's push",
    () =>
      refusing(
        "component",
        '{ version: 2, refuse: "isolate" }',
        'component declaration "refused-in-isolate"',
        (output) =>
          Effect.gen(function* () {
            expect(output).toContain("Hit an error while pushing:");
            expect(output).toContain(
              'Uncaught PushRefused: Push check "functions" refused the source while Convex analyzed probe:checkRuns: component declaration "refused-in-isolate" in confect/verdict.ts is refused',
            );
            yield* servesFirstVersion;
          }),
      ),
    { timeout: 180_000 },
  );

  it.effect(
    "a refusal in the HTTP router's analysis refuses the push, though Convex discards its message",
    () =>
      refusing(
        "host",
        '{ version: 2, refuse: "router" }',
        "The `getRoutes()` method of Router did not return the expected type",
        (output) =>
          Effect.gen(function* () {
            expect(output).toContain("(no value returned)");
            expect(output).not.toContain("refused-in-router");
            yield* servesFirstVersion;
          }),
      ),
    { timeout: 180_000 },
  );

  it.effect(
    "the restored source pushes and serves again",
    () =>
      Effect.gen(function* () {
        yield* servesFirstVersion;
        const backend = yield* LocalBackend.LocalBackend;
        const mark = yield* backend.outputMark;
        yield* writeVerdict("host", '{ version: 3, refuse: "none" }');
        yield* backend.awaitOutput(mark, Str.includes(READY_LINE));
        const pushed = yield* query("probe:version");
        expect(pushed).toBe(3);
        const restored = yield* backend.outputMark;
        yield* writeVerdict("host", passing);
        yield* backend.awaitOutput(restored, Str.includes(READY_LINE));
        yield* servesFirstVersion;
      }),
    { timeout: 180_000 },
  );
});
