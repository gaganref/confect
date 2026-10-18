/// <reference types="vite/client" />

import * as componentTesting from "./fixtures/componentTesting";
import * as mounts from "../local-backend/fixtures/confect/componentBindings";
import counterConvexSchema from "../local-backend/fixtures/components/counter/convex/schema";
import innerConvexSchema from "../local-backend/fixtures/components/inner/convex/schema";
import middleConvexSchema from "../local-backend/fixtures/components/middle/convex/schema";
import parentConvexSchema from "../local-backend/fixtures/components/parent/convex/schema";
import type { ClassProbe } from "../local-backend/fixtures/components/counter/confect/authoring.spec";
import hostRefs from "../local-backend/fixtures/confect/_generated/refs";
import { Rejected as CounterRejected } from "../local-backend/fixtures/components/counter/confect/counter.spec";
import localConvexSchema from "../local-backend/fixtures/confect/_generated/convexSchema";
import localRefs from "../local-backend/fixtures/confect/_generated/refs";
import localSchema from "../local-backend/fixtures/confect/_generated/schema";
import type { Ref } from "@confect/core";
import { Component } from "@confect/core";
import {
  DatabaseSchema,
  MutationRunner,
  QueryRunner,
  RegisteredConvexFunction,
} from "@confect/server";
// Keep the server/test workspace dependency graph acyclic, as in mock-backend/TestConfect.ts.
import { TestConfect } from "../../../test/src";
import { expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { convexTest } from "convex-test";
import {
  componentsGeneric,
  defineSchema,
  httpRouter,
  type FunctionReference,
} from "convex/server";
import * as Effect from "effect/Effect";
import * as Array from "effect/Array";
import * as Result from "effect/Result";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import contract from "../../../cli/test/fixtures/authored-component/confect/_generated/component";
import componentSchema from "../../../cli/test/fixtures/authored-component/convex/schema";

// The wire API shape Convex generates: component IDs are strings, not host IDs.
type CounterApi<ComponentName extends string> = {
  counter: {
    create: FunctionReference<
      "mutation",
      "internal",
      { count: string },
      string,
      ComponentName
    >;
    list: FunctionReference<
      "query",
      "internal",
      {},
      Array<{ _id: string; _creationTime: number; count: string }>,
      ComponentName
    >;
    reject: FunctionReference<"mutation", "internal", {}, null, ComponentName>;
  };
};
const components = componentsGeneric() as unknown as {
  first: CounterApi<"first">;
  second: CounterApi<"second">;
};
const first = Component.bind(contract, components.first);
const second = Component.bind(contract, components.second);
const hostSchema = DatabaseSchema.make({});
const hostConvexSchema = defineSchema({});
const hostModules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "groups/componentAuthoring.ts": () =>
    import("../local-backend/fixtures/convex/groups/componentAuthoring"),
};
const componentModules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "counter.ts": () =>
    import("../../../cli/test/fixtures/authored-component/convex/counter"),
};

it.effect(
  "runs a generated component through vanilla Convex and scoped Confect runners",
  () =>
    Effect.gen(function* () {
      const t = convexTest(hostConvexSchema, hostModules);
      t.registerComponent("first", componentSchema, componentModules);
      t.registerComponent("second", componentSchema, componentModules);
      const wireId = yield* Effect.promise(() =>
        t.mutation(components.first.counter.create, { count: "2" }),
      );
      const wireDocs = yield* Effect.promise(() =>
        t.query(components.first.counter.list),
      );
      expect(wireDocs).toEqual([
        { _id: wireId, _creationTime: expect.any(Number), count: "2" },
      ]);

      const result = yield* Effect.promise(() =>
        t.run((ctx) =>
          // oxlint-disable-next-line effecttsgo/run-effect-inside-effect -- Convex invokes this callback in its transaction context; the handler needs its own per-call services.
          Effect.runPromise(
            Effect.gen(function* () {
              const mutation = yield* MutationRunner.MutationRunner;
              const query = yield* QueryRunner.QueryRunner;
              const id = yield* mutation.runMutation(second.counter.create, {
                count: 7,
              });
              const failure = yield* Effect.result(
                mutation.runMutation(first.counter.reject),
              );
              expect(Result.isFailure(failure)).toBe(true);
              if (Result.isFailure(failure))
                expect(failure.failure).toMatchObject({
                  _tag: "Rejected",
                  id: expect.any(String),
                });
              // Catching a typed component error must not commit its failed subtransaction.
              return {
                id,
                first: yield* query.runQuery(first.counter.list),
                second: yield* query.runQuery(second.counter.list),
              };
            }).pipe(
              Effect.provide(
                RegisteredConvexFunction.mutationLayer(hostSchema, ctx),
              ),
            ),
          ),
        ),
      );
      expect(Array.map(result.first, (row) => row.count)).toEqual([2]);
      expect(result.second).toEqual([
        { _id: result.id, _creationTime: expect.any(Number), count: 7 },
      ]);
      const own: Ref.Returns<typeof second.counter.create> = result.id;
      // @ts-expect-error Component installations have different ID types.
      const wrong: Ref.Returns<typeof first.counter.create> = result.id;
      void [own, wrong];
    }),
);

it.effect("registers components with TestConfect", () =>
  Effect.gen(function* () {
    const t = yield* TestConfect.TestConfect<typeof hostSchema>();
    yield* t.registerComponent("first", componentSchema, componentModules);
    yield* t.mutation(first.counter.create, { count: 11 });
    expect(
      Array.map(yield* t.query(first.counter.list), (row) => row.count),
    ).toEqual([11]);
  }).pipe(
    Effect.provide(
      TestConfect.layer(hostSchema, hostConvexSchema, hostModules),
    ),
  ),
);

const counterModules = import.meta.glob([
  "../local-backend/fixtures/components/counter/convex/**/*.ts",
  "!../local-backend/fixtures/components/counter/convex/**/*.*.*",
]);
const innerModules = import.meta.glob([
  "../local-backend/fixtures/components/inner/convex/**/*.ts",
  "!../local-backend/fixtures/components/inner/convex/**/*.*.*",
]);
const middleModules = import.meta.glob([
  "../local-backend/fixtures/components/middle/convex/**/*.ts",
  "!../local-backend/fixtures/components/middle/convex/**/*.*.*",
]);
const parentModules = import.meta.glob([
  "../local-backend/fixtures/components/parent/convex/**/*.ts",
  "!../local-backend/fixtures/components/parent/convex/**/*.*.*",
]);

const registerGraph = Effect.gen(function* () {
  const t = yield* TestConfect.TestConfect<typeof hostSchema>();
  yield* t.registerComponent("first", counterConvexSchema, counterModules);
  yield* t.registerComponent("second", counterConvexSchema, counterModules);
  for (const mount of ["left", "right"]) {
    yield* t.registerComponent(mount, parentConvexSchema, parentModules);
    yield* t.registerComponent(
      `${mount}/child`,
      counterConvexSchema,
      counterModules,
    );
    yield* t.registerComponent(
      `${mount}/deep`,
      middleConvexSchema,
      middleModules,
    );
    yield* t.registerComponent(
      `${mount}/deep/child`,
      innerConvexSchema,
      innerModules,
    );
    yield* t.registerComponent(
      `${mount}/deep/child/child`,
      counterConvexSchema,
      counterModules,
    );
  }
  return t;
});

it.effect("keeps nominal class methods after component and host decoding", () =>
  Effect.gen(function* () {
    const t = yield* registerGraph;
    const own: ClassProbe = yield* t.query(mounts.first.authoring.probe, {
      value: "component",
    });
    const host: ClassProbe = yield* t.query(
      hostRefs.public.groups.componentAuthoring.probe,
      { value: "host" },
    );
    expect([own.render(), host.render()]).toEqual([
      "class:component",
      "class:host",
    ]);
    expect(
      yield* t.query(hostRefs.public.groups.componentAuthoring.render, {
        value: "shared",
      }),
    ).toBe("class:shared");
  }).pipe(
    Effect.provide(
      TestConfect.layer(hostSchema, hostConvexSchema, hostModules),
    ),
  ),
);

it.effect(
  "isolates two installations through three nested child bindings",
  () =>
    Effect.gen(function* () {
      const t = yield* registerGraph;
      yield* t.mutation(mounts.left.parent.deepCreate, {
        run: "nested",
        count: 23,
      });
      yield* t.mutation(mounts.right.parent.deepCreate, {
        run: "nested",
        count: 29,
      });
      const leftRows = yield* t.query(mounts.left.parent.deepList, {
        run: "nested",
      });
      const rightRows = yield* t.query(mounts.right.parent.deepList, {
        run: "nested",
      });
      expect(leftRows).toEqual([23]);
      expect(rightRows).toEqual([29]);
      expect(yield* t.query(mounts.left.parent.deepLocation)).toBe(
        "left/deep/child/child",
      );
      expect(yield* t.query(mounts.right.parent.deepLocation)).toBe(
        "right/deep/child/child",
      );
    }).pipe(
      Effect.provide(
        TestConfect.layer(hostSchema, hostConvexSchema, hostModules),
      ),
    ),
);

it.effect(
  "decodes a declared tagged class and rolls back only the failed component call",
  () =>
    Effect.gen(function* () {
      const t = yield* registerGraph;
      yield* t.mutation(mounts.first.counter.create, {
        run: "rollback",
        count: 5,
      });
      const failure = yield* Effect.result(
        t.mutation(mounts.first.counter.reject, { run: "rollback" }),
      );
      expect(Result.isFailure(failure)).toBe(true);
      if (Result.isFailure(failure)) {
        expect(failure.failure).toBeInstanceOf(CounterRejected);
        expect(failure.failure).toMatchObject({
          _tag: "Rejected",
          run: "rollback",
          id: expect.any(String),
        });
      }
      expect(
        (yield* t.query(mounts.first.counter.list, { run: "rollback" })).map(
          (row) => row.count,
        ),
      ).toEqual([5]);
      expect(
        yield* t.query(mounts.second.counter.list, { run: "rollback" }),
      ).toEqual([]);
    }).pipe(
      Effect.provide(
        TestConfect.layer(hostSchema, hostConvexSchema, hostModules),
      ),
    ),
);

it.effect(
  "cancels component jobs from runAfter and runAt before they execute",
  () =>
    Effect.gen(function* () {
      vi.useFakeTimers();
      const t = yield* registerGraph;
      const ids = yield* t.mutation(mounts.first.counter.scheduleAndCancel, {
        run: "cancel",
      });
      expect(ids).toEqual({
        after: expect.any(String),
        at: expect.any(String),
        control: expect.any(String),
      });
      yield* t.finishAllScheduledFunctions(() => vi.runAllTimers());
      expect(
        (yield* t.query(mounts.first.counter.list, { run: "cancel" })).map(
          (doc) => doc.count,
        ),
      ).toEqual([17]);
      expect(
        yield* t.query(mounts.second.counter.list, { run: "cancel" }),
      ).toEqual([]);
      const failure = yield* Effect.exit(
        t.mutation(mounts.first.counter.cancel, { id: "invalid-scheduled-id" }),
      );
      expect(Exit.isFailure(failure)).toBe(true);
      if (Exit.isFailure(failure))
        expect(Cause.pretty(failure.cause)).toContain(
          "Invalid argument `id`, expected ID value but got 'invalid-scheduled-id'",
        );
    }).pipe(
      Effect.ensuring(Effect.sync(() => vi.useRealTimers())),
      Effect.provide(
        TestConfect.layer(hostSchema, hostConvexSchema, hostModules),
      ),
    ),
);

it.effect(
  "paginates a component QueryStream across three pages in its own installation",
  () =>
    Effect.gen(function* () {
      const t = yield* registerGraph;
      for (const count of [1, 2, 3, 4, 5])
        yield* t.mutation(mounts.first.counter.create, { run: "pages", count });
      yield* t.mutation(mounts.second.counter.create, {
        run: "pages",
        count: 99,
      });
      const firstPage = yield* t.query(mounts.first.counter.page, {
        run: "pages",
        cursor: null,
        numItems: 2,
      });
      const secondPage = yield* t.query(mounts.first.counter.page, {
        run: "pages",
        cursor: firstPage.continueCursor,
        numItems: 2,
      });
      const lastPage = yield* t.query(mounts.first.counter.page, {
        run: "pages",
        cursor: secondPage.continueCursor,
        numItems: 2,
      });
      expect(
        [firstPage, secondPage, lastPage].map((page) =>
          page.page.map((doc) => doc.count),
        ),
      ).toEqual([[1, 2], [3, 4], [5]]);
      expect([firstPage.isDone, secondPage.isDone, lastPage.isDone]).toEqual([
        false,
        false,
        true,
      ]);
      expect(
        (yield* t.query(mounts.second.counter.list, { run: "pages" })).map(
          (row) => row.count,
        ),
      ).toEqual([99]);
    }).pipe(
      Effect.provide(
        TestConfect.layer(hostSchema, hostConvexSchema, hostModules),
      ),
    ),
);

it.effect(
  "registers a component kit before the TestConfect layer resolves",
  () =>
    Effect.gen(function* () {
      const t = yield* TestConfect.TestConfect<typeof hostSchema>();
      yield* t.mutation(first.counter.create, { count: 17 });
      expect(
        Array.map(yield* t.query(first.counter.list), (row) => row.count),
      ).toEqual([17]);
    }).pipe(
      Effect.provide(
        TestConfect.layer(hostSchema, hostConvexSchema, hostModules, {
          register: (registerComponent) =>
            componentTesting.register(registerComponent, "first"),
        }),
      ),
    ),
);

const mountedLayer = TestConfect.layer(
  hostSchema,
  hostConvexSchema,
  {
    ...hostModules,
    "http.ts": () => Promise.resolve({ default: httpRouter() }),
  },
  {
    register: (registerComponent) => {
      for (const name of ["first", "second", "first/child"]) {
        componentTesting.register(registerComponent, name);
      }
    },
    httpMounts: [
      { componentPath: "first", httpPrefix: "/email" },
      { componentPath: "second", httpPrefix: "/other" },
      { componentPath: "first/child", httpPrefix: "/email/nested" },
    ],
  },
);

it.effect(
  "fetches each mounted component with its site URL at construction",
  () =>
    Effect.gen(function* () {
      vi.stubEnv("CONVEX_SITE_URL", "https://app.convex.site");
      const t = yield* TestConfect.TestConfect<typeof hostSchema>();
      const responses = yield* Effect.forEach(
        ["/email/ping", "/other/ping", "/email/nested/ping"],
        (path) => t.withIdentity({ subject: "caller" }).fetch(path),
        { concurrency: "unbounded" },
      );
      expect(responses.map((response) => response.status)).toEqual([
        200, 200, 200,
      ]);
      expect(
        yield* Effect.promise(() =>
          Promise.all(responses.map((response) => response.json())),
        ),
      ).toEqual([
        { siteUrl: "https://app.convex.site/email" },
        { siteUrl: "https://app.convex.site/other" },
        { siteUrl: "https://app.convex.site/email/nested" },
      ]);
      // oxlint-disable-next-line effecttsgo/process-env-in-effect -- Check the process-global override was restored after the HTTP boundary.
      expect(process.env.CONVEX_SITE_URL).toBe("https://app.convex.site");
    }).pipe(
      Effect.provide(mountedLayer),
      Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
    ),
);

it.effect(
  "routes mounted HTTP writes into the selected component database",
  () =>
    Effect.gen(function* () {
      const t = yield* TestConfect.TestConfect<typeof hostSchema>();
      const response = yield* t.fetch("/email/record", {
        method: "POST",
        body: "31",
      });
      expect(response.status).toBe(204);
      expect(
        Array.map(yield* t.query(first.counter.list), (row) => row.count),
      ).toEqual([31]);
      expect(yield* t.query(second.counter.list)).toEqual([]);
    }).pipe(Effect.provide(mountedLayer)),
);

it.effect("keeps query strings and headers at the exact mount path", () =>
  Effect.gen(function* () {
    const t = yield* TestConfect.TestConfect<typeof hostSchema>();
    const response = yield* t.fetch("/other?key=value", {
      headers: { "x-test": "present" },
    });
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.json())).toEqual({
      siteUrl: "https://some.convex.site/other",
      url: "?key=value",
      originalUrl: "https://some.convex.site/other?key=value",
      header: "present",
    });
  }).pipe(Effect.provide(mountedLayer)),
);

it.effect("leaves unmounted paths and partial prefix matches to the root", () =>
  Effect.gen(function* () {
    const t = yield* TestConfect.TestConfect<typeof hostSchema>();
    const mounted = yield* t.fetch("/email/ping");
    vi.stubEnv("CONVEX_SITE_URL", "invalid-site-url");
    const responses = yield* Effect.forEach(
      ["/missing/ping", "/emails/ping", "/ping"],
      (path) => t.fetch(path),
    );
    expect([
      mounted.status,
      ...responses.map((response) => response.status),
    ]).toEqual([200, 404, 404, 404]);
  }).pipe(
    Effect.provide(mountedLayer),
    Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
  ),
);

it.effect(
  "restores the site URL after construction fails and accepts another fetch",
  () =>
    Effect.gen(function* () {
      vi.stubEnv("CONVEX_SITE_URL", "https://failure.convex.site");
      const t = yield* TestConfect.TestConfect<typeof hostSchema>();
      yield* t.registerComponent("first", componentSchema, {
        ...componentTesting.modules,
        "http.ts": () =>
          Promise.reject({
            _tag: "HttpConstructionFailure",
            message: "HTTP fixture construction failed",
          }),
      });
      const failed = yield* Effect.exit(t.fetch("/email/ping"));
      expect(Exit.isFailure(failed)).toBe(true);
      if (Exit.isFailure(failed)) {
        expect(Cause.squash(failed.cause)).toMatchObject({
          _tag: "HttpConstructionFailure",
        });
      }
      const response = yield* t.fetch("/other/ping");
      expect(yield* Effect.promise(() => response.json())).toEqual({
        siteUrl: "https://failure.convex.site/other",
      });
      // oxlint-disable-next-line effecttsgo/process-env-in-effect -- The adapter must restore the actual process variable after a rejected module loader.
      expect(process.env.CONVEX_SITE_URL).toBe("https://failure.convex.site");
    }).pipe(
      Effect.provide(
        TestConfect.layer(hostSchema, hostConvexSchema, hostModules, {
          register: (registerComponent) =>
            componentTesting.register(registerComponent, "second"),
          httpMounts: [
            { componentPath: "first", httpPrefix: "/email" },
            { componentPath: "second", httpPrefix: "/other" },
          ],
        }),
      ),
      Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
    ),
);

it.effect(
  "preserves structured HTTP compatibility failures across the action boundary",
  () =>
    Effect.gen(function* () {
      const t = yield* TestConfect.TestConfect<typeof hostSchema>();
      const result = yield* Effect.exit(t.fetch("/email/ping"));
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(Cause.squash(result.cause)).toMatchObject({
          _tag: "ComponentHttpError",
          componentPath: "first",
          message:
            "This Convex version does not expose invokeHttpAction for HTTP tests.",
        });
      }
    }).pipe(
      Effect.provide(
        TestConfect.layer(hostSchema, hostConvexSchema, hostModules, {
          register: (registerComponent) =>
            registerComponent("first", componentSchema, {
              ...componentTesting.modules,
              "http.ts": () =>
                Promise.resolve({
                  default: { lookup: () => [{ isHttp: true }, "GET", "/ping"] },
                }),
            }),
          httpMounts: [{ componentPath: "first", httpPrefix: "/email" }],
        }),
      ),
    ),
);

it.effect(
  "uses the default site URL when the application variable is empty",
  () =>
    Effect.gen(function* () {
      vi.stubEnv("CONVEX_SITE_URL", "");
      const t = yield* TestConfect.TestConfect<typeof hostSchema>();
      const response = yield* t.fetch("/email/ping");
      expect(yield* Effect.promise(() => response.json())).toEqual({
        siteUrl: "https://some.convex.site/email",
      });
    }).pipe(
      Effect.provide(mountedLayer),
      Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
    ),
);

it.effect(
  "loads component HTTP modules with convex-test's extension handling",
  () =>
    Effect.gen(function* () {
      const t = yield* TestConfect.TestConfect<typeof hostSchema>();
      const response = yield* t.fetch("/email/ping");
      expect(yield* Effect.promise(() => response.json())).toEqual({
        siteUrl: "https://some.convex.site/email",
      });
    }).pipe(
      Effect.provide(
        TestConfect.layer(hostSchema, hostConvexSchema, hostModules, {
          register: (registerComponent) =>
            registerComponent(
              "first",
              componentSchema,
              Object.fromEntries(
                Object.entries(componentTesting.modules).map(([path, load]) => [
                  path === "http.ts" ? "http.mjs" : path,
                  load,
                ]),
              ),
            ),
          httpMounts: [{ componentPath: "first", httpPrefix: "/email" }],
        }),
      ),
    ),
);

it.effect("fetches an installation mounted at the root prefix", () =>
  Effect.gen(function* () {
    const t = yield* TestConfect.TestConfect<typeof hostSchema>();
    const response = yield* t.fetch("/ping");
    expect(yield* Effect.promise(() => response.json())).toEqual({
      siteUrl: "https://some.convex.site",
    });
  }).pipe(
    Effect.provide(
      TestConfect.layer(hostSchema, hostConvexSchema, hostModules, {
        register: (registerComponent) =>
          componentTesting.register(registerComponent, "first"),
        httpMounts: [{ componentPath: "first", httpPrefix: "/" }],
      }),
    ),
  ),
);

const localHostModules = import.meta.glob([
  "../local-backend/fixtures/convex/**/*.ts",
  "../local-backend/fixtures/convex/**/*.js",
  "!../local-backend/fixtures/convex/**/*.*.*",
]);
const LocalHost = TestConfect.TestConfect<typeof localSchema>();
const callbacks = localRefs.public.groups.callbacks;
const localHostLayer = TestConfect.layer(
  localSchema,
  localConvexSchema,
  localHostModules,
);

it.effect(
  "a component stores a host handle and calls it back through the scheduler and the runner",
  () =>
    Effect.gen(function* () {
      const t = yield* LocalHost;
      yield* t.registerComponent("first", counterConvexSchema, counterModules);
      vi.useFakeTimers();
      const id = yield* t.mutation(callbacks.send, { run: "callbacks" });
      yield* t.finishAllScheduledFunctions(() => vi.runAllTimers());
      expect(yield* t.query(callbacks.events, { run: "callbacks" })).toEqual([
        "sent",
      ]);
      expect(yield* t.query(callbacks.get, { id })).toEqual({
        run: "callbacks",
        status: "sent",
      });

      expect(
        yield* t.mutation(callbacks.setStatus, { id, status: "delivered" }),
      ).toBeNull();
      expect(
        yield* t.mutation(callbacks.setStatus, { id, status: "bounced" }),
      ).toBe("host refuses bounced for callbacks");
      // The component's catch path commits its patch; the host's failed
      // call rolls back the event it recorded before rejecting.
      expect(yield* t.query(callbacks.get, { id })).toEqual({
        run: "callbacks",
        status: "bounced",
      });
      expect(yield* t.query(callbacks.events, { run: "callbacks" })).toEqual([
        "sent",
        "delivered",
      ]);
    }).pipe(
      Effect.ensuring(Effect.sync(() => vi.useRealTimers())),
      Effect.provide(localHostLayer),
    ),
);

it.effect(
  "a handle called with args outside the host's validator fails the component as a defect",
  () =>
    Effect.gen(function* () {
      const t = yield* LocalHost;
      yield* t.registerComponent("first", counterConvexSchema, counterModules);
      const id = yield* t.mutation(callbacks.send, { run: "breach" });
      expect(yield* t.mutation(callbacks.breach, { id })).toBe("defect");
      expect(yield* t.mutation(callbacks.sameHandle, { id })).toBe(true);
    }).pipe(Effect.provide(localHostLayer)),
);

it.effect(
  "refuses to create a handle for a host function whose validators differ from the contract",
  () =>
    Effect.gen(function* () {
      const t = yield* LocalHost;
      expect(yield* t.mutation(callbacks.createMismatched, {})).toEqual({
        outcome: "failure",
        message: `The host function does not satisfy callback contract "counter/onReported": its args compile to {"kind":"object","fields":{"state":{"kind":"string"}}}, the contract's to {"kind":"object","fields":{"status":{"kind":"string"}}}.`,
      });
    }).pipe(Effect.provide(localHostLayer)),
);
