import { Preflight } from "@confect/test";
import * as DatabaseSchema from "@confect/server/DatabaseSchema";
import * as PushCheck from "@confect/server/PushCheck";
import * as Table from "@confect/server/Table";
import { describe, expect, it } from "@effect/vitest";
import {
  defineSchema,
  httpActionGeneric,
  httpRouter,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { convexTest as upstreamConvexTest } from "convex-test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { convexTest as kernelConvexTest } from "../src/internal/ConvexTest";

/**
 * One evaluated module graph of a backend that registers a push check: its
 * database schema, made once as its generated `_generated/schema` module makes
 * it, a check registered for it, and functions and a router that run the checks
 * registered for it, as the library's builders guard them.
 */
const graph = (refusals: ReadonlyArray<string> = []) => {
  const schema = DatabaseSchema.make({});
  const runs = { count: 0 };
  PushCheck.register(
    schema,
    PushCheck.make("authz", () => {
      runs.count++;
      return refusals;
    }),
  );
  const functions = {
    read: PushCheck.guardCopy(
      queryGeneric({ args: {}, handler: () => "read" }),
      schema,
      "read",
    ),
    write: PushCheck.guardCopy(
      mutationGeneric({ args: {}, handler: () => "written" }),
      schema,
      "write",
    ),
  };
  const router = httpRouter();
  router.route({
    path: "/hello",
    method: "GET",
    handler: httpActionGeneric(() => Promise.resolve(new Response("hi"))),
  });
  const modules = {
    "_generated/server.ts": () => Promise.resolve({}),
    "tasks.ts": () => Promise.resolve(functions),
    "http.ts": () =>
      Promise.resolve({ default: PushCheck.guardRouter(router, schema) }),
  };
  return { modules, runs, schema };
};

const refs = {
  read: makeFunctionReference<"query", {}, string>("tasks:read"),
  write: makeFunctionReference<"mutation", {}, string>("tasks:write"),
};

const refusal = "two permissions are named tasks.read: give each its own name";

/**
 * What these cases call on a backend, on either harness.
 */
interface Harness {
  readonly query: (ref: typeof refs.read, args: {}) => Promise<string>;
  readonly mutation: (ref: typeof refs.write, args: {}) => Promise<string>;
  readonly fetch: (path: string) => Promise<Response>;
}

type Modules = Record<string, () => Promise<unknown>>;

const harnesses: ReadonlyArray<{
  readonly name: string;
  readonly make: (modules: Modules) => Harness;
}> = [
  {
    name: "convex-test",
    make: (modules) => upstreamConvexTest(defineSchema({}), modules as never),
  },
  {
    name: "the kernel",
    make: (modules) => kernelConvexTest(defineSchema({}), modules as never),
  },
];

describe.each(harnesses)("on $name", ({ make }) => {
  it.effect("calls run the checks once per evaluated module graph", () =>
    Effect.gen(function* () {
      const { modules, runs } = graph();
      const t = make(modules);
      // A second backend over the same graph shares its verdict.
      const again = make(modules);
      const answers = yield* Effect.promise(() =>
        Promise.all([
          t.query(refs.read, {}),
          t.query(refs.read, {}),
          t.mutation(refs.write, {}),
          again.query(refs.read, {}),
        ]),
      );
      expect(answers).toEqual(["read", "read", "written", "read"]);
      expect(runs.count).toBe(1);
    }),
  );

  it.effect("a refused source fails every call with the refusal", () =>
    Effect.gen(function* () {
      const { modules, runs } = graph([refusal]);
      const t = make(modules);
      for (const call of [
        () => t.query(refs.read, {}),
        () => t.mutation(refs.write, {}),
      ]) {
        const failure = yield* Effect.promise(() =>
          call().then(
            () => undefined,
            (error: unknown) => error,
          ),
        );
        expect(String(failure)).toContain(
          `Push check "authz" refused the source while Convex analyzed `,
        );
        expect(String(failure)).toContain(refusal);
      }
      expect(runs.count).toBe(1);
    }),
  );

  it.effect(
    "an HTTP request runs no check, so a kit runs the preflight before the first call",
    () =>
      Effect.gen(function* () {
        const { modules, runs } = graph([refusal]);
        const t = make(modules);
        const response = yield* Effect.promise(() => t.fetch("/hello"));
        expect(response.status).toBe(200);
        expect(runs.count).toBe(0);
        const exit = yield* Effect.exit(Preflight.run(modules));
        expect(exit).toStrictEqual(
          Exit.fail(
            PushCheck.PushRefused.make({
              check: "authz",
              refusals: [refusal],
            }),
          ),
        );
      }),
  );
});

describe("run", () => {
  it.effect(
    "runs each check the modules carry once per run, apart from the memo",
    () =>
      Effect.gen(function* () {
        const { modules, runs } = graph();
        yield* Preflight.run(modules);
        expect(runs.count).toBe(1);
        yield* Preflight.run(modules);
        expect(runs.count).toBe(2);
        // The memo the analysis path reads is apart: a call still runs it once.
        const t: Harness = kernelConvexTest(defineSchema({}), modules as never);
        yield* Effect.promise(() => t.query(refs.read, {}));
        expect(runs.count).toBe(3);
      }),
  );

  it.effect(
    "given the backend's schema, refuses checks no function or router runs",
    () =>
      Effect.gen(function* () {
        const schema = DatabaseSchema.make({});
        PushCheck.register(
          schema,
          PushCheck.make("authz", () => []),
        );
        const exit = yield* Effect.exit(
          Preflight.run(
            {
              "_generated/server.ts": () => Promise.resolve({}),
              "crons.ts": () => Promise.resolve({ default: {} }),
            },
            { schema },
          ),
        );
        expect(exit).toStrictEqual(
          Exit.fail(Preflight.NoPushEntry.make({ checks: ["authz"] })),
        );
        // A backend whose entries run its checks passes, or refuses with them.
        const passing = graph();
        yield* Preflight.run(passing.modules, { schema: passing.schema });
        const refused = graph([refusal]);
        const refusedExit = yield* Effect.exit(
          Preflight.run(refused.modules, { schema: refused.schema }),
        );
        expect(refusedExit).toStrictEqual(
          Exit.fail(
            PushCheck.PushRefused.make({ check: "authz", refusals: [refusal] }),
          ),
        );
      }),
  );

  it.effect(
    "given the backend's schema, refuses a table its deploy checks refuse",
    () =>
      Effect.gen(function* () {
        const notes = Table.make(() =>
          Schema.Struct({ text: Schema.String }),
        ).deployCheck((table) => [`${table.tableName} is refused`])("notes");
        const { modules } = graph();
        const exit = yield* Effect.exit(
          Preflight.run(modules, { schema: DatabaseSchema.make({ notes }) }),
        );
        expect(exit).toStrictEqual(
          Exit.fail(
            Table.TableRefused.make({
              tableName: "notes",
              refusals: ["notes is refused"],
            }),
          ),
        );
        // Without the schema it cannot see the table.
        yield* Preflight.run(modules);
      }),
  );

  it.effect("passes modules that carry no check", () =>
    Preflight.run({
      "_generated/server.ts": () => Promise.resolve({}),
      "plain.ts": () =>
        Promise.resolve({
          read: queryGeneric({ args: {}, handler: () => null }),
          answer: 42,
        }),
    }),
  );
});
