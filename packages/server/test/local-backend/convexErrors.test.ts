/**
 * What the binary hands a function when another it calls throws a
 * `ConvexError`, compared with the test kernel running the same plain fixture
 * (`packages/test/test/Kernel.test.ts`, "nested ConvexError data"). The data
 * crosses the call as Convex JSON, and the caller's syscall wrapper decodes it
 * once, so an int64 or bytes reaches the caller as it was thrown.
 */
import { expect, layer } from "@effect/vitest";
import { makeFunctionReference } from "convex/server";
import { jsonToConvex, type JSONValue } from "convex/values";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Rec from "effect/Record";
import * as LocalBackend from "confect-local-backend/LocalBackend";
import { convexTest } from "../../../test/src/internal/ConvexTest";
import {
  payloads,
  type Caught,
  type Payload,
  type Target,
} from "../../../../tools/local-backend/fixtures/plain/convex/convexErrors";

const callers = {
  query: makeFunctionReference<"query", { payload: Payload }, Caught>(
    "convexErrors:queryCaller",
  ),
  mutation: makeFunctionReference<
    "mutation",
    { payload: Payload; target: "query" | "mutation" },
    Caught
  >("convexErrors:mutationCaller"),
  action: makeFunctionReference<
    "action",
    { payload: Payload; target: Target },
    Caught
  >("convexErrors:actionCaller"),
};

type Case =
  | { readonly caller: "query"; readonly target: "query" }
  | { readonly caller: "mutation"; readonly target: "query" | "mutation" }
  | { readonly caller: "action" | "HTTP action"; readonly target: Target };

/**
 * The calls a caller can make: a query only runs queries, and a mutation runs
 * queries and mutations.
 */
const cases: ReadonlyArray<Case> = [
  { caller: "query", target: "query" },
  { caller: "mutation", target: "query" },
  { caller: "mutation", target: "mutation" },
  { caller: "action", target: "query" },
  { caller: "action", target: "mutation" },
  { caller: "action", target: "action" },
  { caller: "HTTP action", target: "query" },
  { caller: "HTTP action", target: "mutation" },
  { caller: "HTTP action", target: "action" },
];

/**
 * A backend's three call entry points, and a GET of one of its HTTP routes
 * answering the route's JSON body.
 */
interface Calls {
  readonly query: (reference: any, args: any) => Effect.Effect<any>;
  readonly mutation: (reference: any, args: any) => Effect.Effect<any>;
  readonly action: (reference: any, args: any) => Effect.Effect<any>;
  readonly get: (path: string) => Effect.Effect<unknown>;
}

/**
 * What reaches `caller` when it calls a `target` that throws with `payload`
 * data. The HTTP route answers it as Convex JSON.
 */
const caughtIn = (
  calls: Calls,
  { caller, target }: Case,
  payload: Payload,
): Effect.Effect<Caught> => {
  switch (caller) {
    case "query":
      return calls.query(callers.query, { payload });
    case "mutation":
      return calls.mutation(callers.mutation, { payload, target });
    case "action":
      return calls.action(callers.action, { payload, target });
    case "HTTP action":
      return calls
        .get(`/nested-convex-error?payload=${payload}&target=${target}`)
        .pipe(Effect.map((json) => jsonToConvex(json as JSONValue) as Caught));
  }
};

/**
 * The same plain fixture on the test kernel.
 */
const kernel = (): Calls => {
  const t = convexTest(undefined, {
    "_generated/server.ts": () => Promise.resolve({}),
    "convexErrors.ts": () =>
      import("../../../../tools/local-backend/fixtures/plain/convex/convexErrors"),
    "http.ts": () =>
      import("../../../../tools/local-backend/fixtures/plain/convex/http"),
  });
  return {
    query: (reference, args) => Effect.promise(() => t.query(reference, args)),
    mutation: (reference, args) =>
      Effect.promise(() => t.mutation(reference, args)),
    action: (reference, args) =>
      Effect.promise(() => t.action(reference, args)),
    get: (path) =>
      Effect.promise(() =>
        t.fetch(path).then((response: Response) => response.json()),
      ),
  };
};

layer(Layer.mergeAll(LocalBackend.plainLayer, FetchHttpClient.layer), {
  timeout: "120 seconds",
})("nested ConvexError data on the binary", (it) => {
  it.effect.each(
    Arr.flatMap(Rec.keys(payloads) as ReadonlyArray<Payload>, (payload) =>
      Arr.map(cases, (c) => ({ ...c, payload })),
    ),
  )(
    "a ConvexError with $payload data thrown in a called $target reaches its $caller caller as that ConvexError and data, as on the test kernel",
    ({ payload, ...c }) =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        const http = yield* HttpClient.HttpClient;
        const binary = yield* caughtIn(
          {
            query: (reference, args) =>
              Effect.promise(() => client.query(reference, args)),
            mutation: (reference, args) =>
              Effect.promise(() => client.mutation(reference, args)),
            action: (reference, args) =>
              Effect.promise(() => client.action(reference, args)),
            get: (path) =>
              http
                .get(LocalBackend.siteUrl(path, LocalBackend.ports.plain))
                .pipe(
                  Effect.flatMap((response) => response.json),
                  Effect.orDie,
                ),
          },
          c,
          payload,
        );
        expect(binary).toEqual({
          convexError: true,
          data: payloads[payload](),
        });
        const onKernel = yield* caughtIn(kernel(), c, payload);
        expect(onKernel).toEqual(binary);
      }),
  );
});
