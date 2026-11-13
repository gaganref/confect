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
import * as Table from "@confect/core/Table";
import * as DatabaseSchema from "@confect/server/DatabaseSchema";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { convexTest, type KernelControls } from "../src/internal/ConvexTest";
import * as MountedHttp from "../src/internal/MountedHttp";
import * as Redaction from "../src/internal/Redaction";

const schema = defineSchema({
  hits: defineTable({ path: v.string() }),
  vault: defineTable({ token: v.string() }),
});

// A secret the world keeps once a row holds it under a secret schema node, and
// that a route then throws in its error.
const canary = "canary-route-error-6b1d93c4";
const secrets = Redaction.policy({
  tables: {
    "": Redaction.tablesOf(
      DatabaseSchema.make({
        vault: Table.make(() =>
          Schema.Struct({ token: Schema.RedactedFromValue(Schema.String) }),
        )("vault"),
      }),
    ),
  },
});

const hits = {
  add: makeFunctionReference<"mutation", { path: string }>("hits:add"),
  list: makeFunctionReference<"query", {}, Array<string>>("hits:list"),
};

let reachedGate = () => {};
let gate: Promise<void> = Promise.resolve();

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
  path: "/echo",
  method: "OPTIONS",
  handler: httpActionGeneric(
    async (_ctx, request) =>
      new Response(`received ${(await request.arrayBuffer()).byteLength}`),
  ),
});
router.route({
  path: "/refused",
  method: "GET",
  handler: httpActionGeneric(async (ctx) => {
    await ctx.vectorSearch("hits", "by_embedding", { vector: [0] });
    return new Response("searched");
  }),
});
router.route({
  path: "/gated",
  method: "GET",
  handler: httpActionGeneric(async () => {
    reachedGate();
    await gate;
    return new Response("through");
  }),
});
router.route({
  path: "/leak",
  method: "GET",
  handler: httpActionGeneric(async () => {
    throw new ConvexError({ token: canary, note: `leaked ${canary}` });
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

const thrown = (run: () => unknown): unknown => {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
};

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

describe("HTTP request and response edges", () => {
  it.effect.each([
    {
      name: "a path no route has",
      path: "/missing",
      status: 404,
      type: "text/plain; charset=utf-8",
    },
    {
      name: "a route that throws",
      path: "/fail",
      status: 500,
      type: "application/json",
    },
  ])(
    "a HEAD request to $name gets its status and headers and no body",
    ({ path, status, type }) =>
      Effect.gen(function* () {
        const t = httpWorld();
        const response = yield* call(() => t.fetch(path, { method: "HEAD" }));
        expect(response.status).toBe(status);
        expect(response.headers.get("content-type")).toBe(type);
        expect(yield* call(() => response.text())).toBe("");
      }),
  );

  it.effect.each(["OPTIONS", "GET"])(
    "a %s request's body never reaches its route, as the binary discards it",
    (method) =>
      Effect.gen(function* () {
        const t = httpWorld();
        const response = yield* call(() =>
          t.fetch("/echo", { method, body: "discarded" }),
        );
        expect(response.status).toBe(200);
        expect(yield* call(() => response.text())).toBe(
          method === "OPTIONS" ? "received 0" : "get ",
        );
      }),
  );

  it.effect(
    "a kernel refusal inside a route surfaces as that refusal, not as a 500",
    () =>
      Effect.gen(function* () {
        const t = httpWorld();
        const refused = yield* call(() =>
          t.fetch("/refused").then(
            () => undefined,
            (error: unknown) => error,
          ),
        );
        expect(refused).toMatchObject({
          _tag: "RequiresBinary",
          operation: "vectorSearch",
        });
      }),
  );

  it.effect(
    "a backend serving a request refuses a snapshot until it answers",
    () =>
      Effect.gen(function* () {
        const t = httpWorld();
        const reached = Promise.withResolvers<void>();
        const released = Promise.withResolvers<void>();
        reachedGate = () => reached.resolve();
        gate = released.promise;
        const pending = t.fetch("/gated");
        yield* call(() => reached.promise);
        expect(thrown(() => t.exportSnapshot())).toMatchObject({
          _tag: "SnapshotWorldRunning",
        });
        released.resolve();
        expect(yield* call(() => pending.then((r) => r.text()))).toBe(
          "through",
        );
        expect(t.exportSnapshot()).toBeInstanceOf(Uint8Array);
      }),
  );
});

describe("mounted HTTP routes", () => {
  const mountedRouter = httpRouter();
  mountedRouter.route({
    path: "/ping",
    method: "OPTIONS",
    handler: httpActionGeneric(
      async (_ctx, request) =>
        new Response(`received ${(await request.arrayBuffer()).byteLength}`),
    ),
  });
  mountedRouter.route({
    path: "/refused",
    method: "GET",
    handler: httpActionGeneric(async (ctx) => {
      await ctx.vectorSearch("hits", "by_embedding", { vector: [0] });
      return new Response("searched");
    }),
  });
  mountedRouter.route({
    path: "/echo",
    method: "GET",
    handler: httpActionGeneric(
      async (_ctx, request) =>
        new Response(`received ${(await request.arrayBuffer()).byteLength}`),
    ),
  });
  mountedRouter.route({
    path: "/leak",
    method: "GET",
    handler: httpActionGeneric(async () => {
      throw new Error(`leaked ${canary}`);
    }),
  });
  const mounted = (t: any = convexTest(schema, modules)) => {
    const http = MountedHttp.make(
      [{ componentPath: "mail", httpPrefix: "/mail" }],
      t.registerComponent,
    );
    http.register("mail", defineSchema({}), {
      "_generated/server.ts": () => Promise.resolve({}),
      "http.ts": () => Promise.resolve({ default: mountedRouter }),
    });
    return (path: string, init?: RequestInit) => http.fetch(t, path, init);
  };

  it.effect.each(["GET", "HEAD"])(
    "a mounted %s request with a body reaches its route without it",
    (method) =>
      Effect.gen(function* () {
        const fetch = mounted();
        // A body on a GET or HEAD request is the case under test.
        const init: RequestInit = { method, body: "discarded" };
        const response = yield* call(() => fetch("/mail/echo", init));
        expect(response.status).toBe(200);
        expect(yield* call(() => response.text())).toBe(
          method === "GET" ? "received 0" : "",
        );
      }),
  );

  it.effect(
    "a mounted route's 500 body marks a kept secret its error carries",
    () =>
      Effect.gen(function* () {
        const t = convexTest({ schema, modules, redaction: secrets });
        const fetch = mounted(t);
        yield* call(() =>
          t.run((ctx: any) => ctx.db.insert("vault", { token: canary })),
        );
        const response = yield* call(() => fetch("/mail/leak"));
        const body = yield* call(() => response.text());
        expect(response.status).toBe(500);
        expect(body).not.toContain(canary);
        expect(body).toContain(Redaction.marker);
      }),
  );

  it.effect(
    "a mounted miss gets the binary's 404, and a HEAD one no body",
    () =>
      Effect.gen(function* () {
        const fetch = mounted();
        const miss = yield* call(() => fetch("/mail/missing"));
        expect(miss.status).toBe(404);
        expect(yield* call(() => miss.text())).toBe("No matching routes found");
        const head = yield* call(() =>
          fetch("/mail/missing", { method: "HEAD" }),
        );
        expect(head.status).toBe(404);
        expect(yield* call(() => head.text())).toBe("");
      }),
  );

  it.effect("a mounted OPTIONS request's body never reaches its route", () =>
    Effect.gen(function* () {
      const fetch = mounted();
      const response = yield* call(() =>
        fetch("/mail/ping", { method: "OPTIONS", body: "discarded" }),
      );
      expect(yield* call(() => response.text())).toBe("received 0");
    }),
  );

  it.effect(
    "a kernel refusal inside a mounted route surfaces as that refusal, not as a 500",
    () =>
      Effect.gen(function* () {
        const fetch = mounted();
        const refused = yield* call(() =>
          fetch("/mail/refused").then(
            () => undefined,
            (error: unknown) => error,
          ),
        );
        expect(refused).toMatchObject({
          _tag: "RequiresBinary",
          operation: "vectorSearch",
        });
      }),
  );
});

describe("HTTP route error reports", () => {
  it.effect("a route's 500 body marks a kept secret its error carries", () =>
    Effect.gen(function* () {
      const t: HttpWorld & { run: (handler: any) => Promise<unknown> } =
        convexTest({ schema, modules, redaction: secrets });
      yield* call(() =>
        t.run((ctx: any) => ctx.db.insert("vault", { token: canary })),
      );
      const response = yield* call(() => t.fetch("/leak"));
      const body = yield* call(() => response.text());
      expect(response.status).toBe(500);
      expect(body).not.toContain(canary);
      expect(body).toContain(Redaction.marker);
    }),
  );
});
