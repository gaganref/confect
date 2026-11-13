// oxlint-disable effecttsgo/async-function -- The fixtures are plain Convex HTTP actions, which are async as product code is.
import { describe, expect, it } from "@effect/vitest";
import {
  defineSchema,
  defineTable,
  httpActionGeneric,
  httpRouter,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
  type UserIdentity,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import * as Effect from "effect/Effect";
import { convexTest, type KernelControls } from "../src/internal/ConvexTest";

const schema = defineSchema({ hits: defineTable({ path: v.string() }) });

const hits = {
  add: makeFunctionReference<"mutation", { path: string }>("hits:add"),
  list: makeFunctionReference<"query", {}, Array<string>>("hits:list"),
};

const router = httpRouter();
router.route({
  path: "/echo",
  method: "POST",
  handler: httpActionGeneric(async (_ctx, request) => {
    const bytes = new Uint8Array(await request.arrayBuffer());
    return new Response(bytes, {
      status: 201,
      headers: {
        "x-method": request.method,
        "x-url": request.url,
        "x-signature": request.headers.get("X-Signature") ?? "none",
        "x-length": String(bytes.length),
      },
    });
  }),
});
router.route({
  path: "/echo",
  method: "GET",
  handler: httpActionGeneric(
    async (_ctx, request) =>
      new Response(`get ${new URL(request.url).search}`, {
        headers: { "x-route": "get" },
      }),
  ),
});
router.route({
  pathPrefix: "/files/",
  method: "GET",
  handler: httpActionGeneric(async (ctx, request) => {
    const path = new URL(request.url).pathname;
    await ctx.runMutation(hits.add, { path });
    return new Response(path);
  }),
});
router.route({
  path: "/whoami",
  method: "GET",
  handler: httpActionGeneric(async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    return new Response(identity?.subject ?? "anonymous");
  }),
});
router.route({
  path: "/fail",
  method: "GET",
  handler: httpActionGeneric(async () => {
    throw new Error("The route failed.");
  }),
});
router.route({
  path: "/fail-convex-error",
  method: "GET",
  handler: httpActionGeneric(async () => {
    throw new ConvexError({ code: "denied", attempt: 2 });
  }),
});

const modules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "http.ts": () => Promise.resolve({ default: router }),
  "hits.ts": () =>
    Promise.resolve({
      add: mutationGeneric({
        args: { path: v.string() },
        handler: (ctx, { path }) =>
          ctx.db.insert("hits", { path }).then(() => null),
      }),
      list: queryGeneric({
        args: {},
        handler: (ctx) =>
          ctx.db
            .query("hits")
            .collect()
            .then((rows) => rows.map((row) => row.path)),
      }),
    }),
};

interface HttpWorld extends KernelControls {
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>;
  readonly withIdentity: (identity: Partial<UserIdentity>) => HttpWorld;
}

const httpWorld = (): HttpWorld => convexTest(schema, modules);

const call = <A>(thunk: () => Promise<A>) => Effect.promise(thunk);

describe("HTTP routes", () => {
  it.effect(
    "a route gets the request's method, URL, headers and exact body bytes",
    () =>
      Effect.gen(function* () {
        const t = httpWorld();
        const body = Uint8Array.of(0x00, 0xff, 0x7b, 0x0a, 0xc3);
        const response = yield* call(() =>
          t.fetch("/echo?x=1&y=two", {
            method: "POST",
            headers: { "x-signature": "sha256=abc" },
            body,
          }),
        );
        expect(response.status).toBe(201);
        expect(Object.fromEntries(response.headers)).toMatchObject({
          "x-method": "POST",
          "x-url": "https://some.convex.site/echo?x=1&y=two",
          "x-signature": "sha256=abc",
          "x-length": "5",
        });
        expect(
          new Uint8Array(yield* call(() => response.arrayBuffer())),
        ).toStrictEqual(body);
      }),
  );

  it.effect(
    "the method picks the route, a query never does, and a prefix route takes the rest",
    () =>
      Effect.gen(function* () {
        const t = httpWorld();
        const get = yield* call(() => t.fetch("/echo?q=1"));
        expect(get.headers.get("x-route")).toBe("get");
        expect(yield* call(() => get.text())).toBe("get ?q=1");
        const file = yield* call(() => t.fetch("/files/a/b.txt"));
        expect(yield* call(() => file.text())).toBe("/files/a/b.txt");
        expect(yield* call(() => t.query(hits.list, {}))).toStrictEqual([
          "/files/a/b.txt",
        ]);
      }),
  );

  it.effect.each([
    { name: "a path no route has", path: "/missing", method: "GET" },
    {
      name: "a method the path has no route for",
      path: "/echo",
      method: "PUT",
    },
    {
      name: "the prefix itself without its slash",
      path: "/files",
      method: "GET",
    },
  ])("$name gets the binary's 404", ({ path, method }) =>
    Effect.gen(function* () {
      const t = httpWorld();
      const response = yield* call(() => t.fetch(path, { method }));
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toBe(
        "text/plain; charset=utf-8",
      );
      expect(yield* call(() => response.text())).toBe(
        "No matching routes found",
      );
    }),
  );

  it.effect("a deployment with no HTTP module answers every path 404", () =>
    Effect.gen(function* () {
      const t: HttpWorld = convexTest(schema, {
        "_generated/server.ts": () => Promise.resolve({}),
      });
      const response = yield* call(() => t.fetch("/echo"));
      expect(response.status).toBe(404);
    }),
  );

  it.effect("a HEAD request runs the GET route and gets no body", () =>
    Effect.gen(function* () {
      const t = httpWorld();
      const response = yield* call(() => t.fetch("/echo", { method: "HEAD" }));
      expect(response.status).toBe(200);
      expect(response.headers.get("x-route")).toBe("get");
      expect(yield* call(() => response.text())).toBe("");
    }),
  );

  it.effect("a route reads the identity its caller set", () =>
    Effect.gen(function* () {
      const t = httpWorld();
      const anonymous = yield* call(() => t.fetch("/whoami"));
      expect(yield* call(() => anonymous.text())).toBe("anonymous");
      const named = yield* call(() =>
        t.withIdentity({ subject: "caller" }).fetch("/whoami"),
      );
      expect(yield* call(() => named.text())).toBe("caller");
    }),
  );

  // The pinned binary's answers, from
  // `packages/server/test/local-backend/httpErrors.test.ts`.
  it.effect.each([
    {
      name: "an Error",
      path: "/fail",
      uncaught: "Uncaught Error: The route failed.",
      data: undefined,
    },
    {
      name: "a ConvexError",
      path: "/fail-convex-error",
      uncaught: 'Uncaught ConvexError: {"code":"denied","attempt":2}',
      data: { code: "denied", attempt: 2 },
    },
  ])(
    "a route that throws $name answers the binary's 500 JSON error body",
    ({ path, uncaught, data }) =>
      Effect.gen(function* () {
        const t = httpWorld();
        const response = yield* call(() => t.fetch(path));
        expect(response.status).toBe(500);
        expect(response.headers.get("content-type")).toBe("application/json");
        const body = (yield* call(() => response.json())) as Record<
          string,
          unknown
        >;
        expect(Object.keys(body)).toStrictEqual(
          data === undefined ? ["code", "trace"] : ["code", "trace", "data"],
        );
        expect(body["code"]).toMatch(
          new RegExp(
            `^\\[Request ID: [0-9a-f]{16}\\] Server Error: ${RegExp.escape(uncaught)}$`,
          ),
        );
        expect(body["trace"]).toMatch(
          new RegExp(`^${RegExp.escape(uncaught)}\\n(    at .*\\n)*$`),
        );
        expect(body["data"]).toStrictEqual(data);
      }),
  );

  it.effect("a path that does not start with / is refused", () =>
    Effect.gen(function* () {
      const t = httpWorld();
      const refused: unknown = yield* call(() =>
        t.fetch("echo").then(
          () => undefined,
          (error: unknown) => error,
        ),
      );
      expect(refused).toMatchObject({
        _tag: "InvalidFetchPath",
        path: "echo",
      });
    }),
  );
});
