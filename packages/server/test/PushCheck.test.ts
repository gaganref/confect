import * as PushCheck from "@confect/server/PushCheck";
import { describe, expect, it } from "@effect/vitest";
import {
  actionGeneric,
  httpActionGeneric,
  httpRouter,
  internalActionGeneric,
  internalMutationGeneric,
  internalQueryGeneric,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";

const nodeAction = Symbol.for("@confect/server/NodeAction");

/**
 * A check that counts its runs and refuses with `refusals`.
 */
const counted = (name: string, refusals: ReadonlyArray<string> = []) => {
  const runs = { count: 0 };
  const check = PushCheck.make(name, () => {
    runs.count++;
    return refusals;
  });
  return { check, runs };
};

const functions = () => ({
  publicQuery: queryGeneric({ args: { a: v.string() }, handler: () => null }),
  internalQuery: internalQueryGeneric({ args: {}, handler: () => null }),
  publicMutation: mutationGeneric({ args: {}, handler: () => null }),
  internalMutation: internalMutationGeneric({ args: {}, handler: () => null }),
  publicAction: Object.defineProperty(
    actionGeneric({ args: {}, handler: () => Promise.resolve(null) }),
    nodeAction,
    { value: true },
  ),
  internalAction: internalActionGeneric({
    args: {},
    handler: () => Promise.resolve(null),
  }),
});

type Names = keyof ReturnType<typeof functions>;
const names = Rec.keys(functions()) as ReadonlyArray<Names>;

const exportArgs = (value: unknown) =>
  (value as { readonly exportArgs: () => string }).exportArgs();

const thrown = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("make", () => {
  it("makes a push check that runs nothing until asked", () => {
    const { check, runs } = counted("authz");
    expect(PushCheck.isPushCheck(check)).toBe(true);
    expect(PushCheck.isPushCheck({ name: "authz", check: () => [] })).toBe(
      false,
    );
    expect(check.name).toBe("authz");
    expect(runs.count).toBe(0);
  });
});

describe("verify", () => {
  it("runs the check every time, apart from the analysis memo", () => {
    const { check, runs } = counted("authz");
    expect(Result.isSuccess(PushCheck.verify(check))).toBe(true);
    expect(Result.isSuccess(PushCheck.verify(check))).toBe(true);
    expect(runs.count).toBe(2);
  });

  it("fails with a refusal naming the check and each declaration", () => {
    const { check } = counted("authz", [
      "two permissions are named tasks.read: give each its own name",
      "role editor has no level",
    ]);
    const failure = PushCheck.verify(check).pipe(
      Result.flip,
      Result.getOrThrow,
    );
    expect(failure).toMatchObject({
      _tag: "PushRefused",
      check: "authz",
      refusals: [
        "two permissions are named tasks.read: give each its own name",
        "role editor has no level",
      ],
    });
    expect(failure.message).toBe(`Push check "authz" refused the source:
- two permissions are named tasks.read: give each its own name
- role editor has no level`);
  });
});

describe("guardFunctions", () => {
  it("runs the checks once per check across every function's exportArgs, then delegates", () => {
    const originals = functions();
    const first = counted("first");
    const second = counted("second");
    const guarded = PushCheck.guardFunctions(
      originals,
      [first.check, second.check],
      "tasks/list",
    );
    for (const name of names) {
      expect(exportArgs(guarded[name])).toBe(exportArgs(originals[name]));
      expect(exportArgs(guarded[name])).toBe(exportArgs(originals[name]));
    }
    expect(first.runs.count).toBe(1);
    expect(second.runs.count).toBe(1);
  });

  it("runs a check made by another evaluation of the module graph again", () => {
    // Each evaluation of a generated section file makes its own check, so the
    // memo holds one verdict per evaluated graph.
    const graphOne = counted("authz");
    const graphTwo = counted("authz");
    exportArgs(
      PushCheck.guardFunctions(functions(), [graphOne.check], "a").publicQuery,
    );
    exportArgs(
      PushCheck.guardFunctions(functions(), [graphTwo.check], "a").publicQuery,
    );
    expect(graphOne.runs.count).toBe(1);
    expect(graphTwo.runs.count).toBe(1);
  });

  it("keeps the memo off globalThis", () => {
    const keys = () => [
      ...Object.getOwnPropertyNames(globalThis),
      ...Arr.map(Object.getOwnPropertySymbols(globalThis), String),
    ];
    const before = keys();
    exportArgs(
      PushCheck.guardFunctions(functions(), [counted("authz").check], "a")
        .publicQuery,
    );
    expect(keys()).toEqual(before);
  });

  it("throws a refusal naming the check, the analyzed function and the declaration, every time", () => {
    const { check, runs } = counted("authz", [
      "two permissions are named tasks.read: give each its own name",
    ]);
    const guarded = PushCheck.guardFunctions(
      functions(),
      [counted("passes").check, check],
      "tasks/list",
    );
    const error = thrown(() => exportArgs(guarded.internalMutation));
    expect(error).toBeInstanceOf(PushCheck.PushRefused);
    expect(error).toMatchObject({
      check: "authz",
      entry: "tasks/list:internalMutation",
      message:
        'Push check "authz" refused the source while Convex analyzed tasks/list:internalMutation: two permissions are named tasks.read: give each its own name',
    });
    expect(thrown(() => exportArgs(guarded.publicAction))).toMatchObject({
      entry: "tasks/list:publicAction",
    });
    expect(runs.count).toBe(1);
  });

  it("names a nested group's function by its path", () => {
    const guarded = PushCheck.guardFunctions(
      { nested: { list: queryGeneric({ args: {}, handler: () => null }) } },
      [counted("authz", ["refused"]).check],
      "tasks",
    );
    expect(thrown(() => exportArgs(guarded.nested.list))).toMatchObject({
      entry: "tasks:nested.list",
    });
  });

  it("copies every function and leaves the input unchanged", () => {
    const originals = functions();
    const { check, runs } = counted("authz", ["refused"]);
    const guarded = PushCheck.guardFunctions(originals, [check], "tasks/list");
    for (const name of names) {
      const original = originals[name] as unknown as Record<
        PropertyKey,
        unknown
      >;
      const copy = guarded[name] as unknown as Record<PropertyKey, unknown>;
      expect(copy).not.toBe(original);
      for (const key of Reflect.ownKeys(original))
        if (key !== "exportArgs") expect(copy[key]).toBe(original[key]);
      expect(() => exportArgs(original)).not.toThrow();
      expect(PushCheck.checksOf(original)).toEqual([]);
      expect(PushCheck.checksOf(copy)).toEqual([check]);
    }
    expect(
      (guarded.publicAction as unknown as Record<PropertyKey, unknown>)[
        nodeAction
      ],
    ).toBe(true);
    expect(runs.count).toBe(0);
  });

  it("returns the functions unchanged with no checks", () => {
    const originals = functions();
    expect(PushCheck.guardFunctions(originals, [], "tasks/list")).toBe(
      originals,
    );
  });

  it.effect("runs no check when a call invokes a function", () =>
    Effect.gen(function* () {
      const { check, runs } = counted("authz", ["refused"]);
      const guarded = PushCheck.guardFunctions(
        functions(),
        [check],
        "tasks/list",
      );
      const invoked = guarded.publicQuery as unknown as {
        readonly invokeQuery: (args: string) => Promise<string>;
      };
      yield* Effect.promise(() =>
        invoked.invokeQuery('[{"a":"x"}]').catch(() => undefined),
      );
      expect(runs.count).toBe(0);
    }),
  );
});

describe("guardRouter", () => {
  const router = () => {
    const http = httpRouter();
    http.route({
      path: "/hello",
      method: "GET",
      handler: httpActionGeneric(() => Promise.resolve(new Response("hi"))),
    });
    return http;
  };

  it("runs the checks once from getRoutes, then delegates", () => {
    const original = router();
    const { check, runs } = counted("authz");
    const guarded = PushCheck.guardRouter(original, [check]);
    expect(guarded.getRoutes()).toEqual(original.getRoutes());
    expect(guarded.getRoutes()).toEqual(original.getRoutes());
    expect(runs.count).toBe(1);
    expect(guarded.isRouter).toBe(true);
    expect(PushCheck.checksOf(guarded)).toEqual([check]);
  });

  it("throws a refusal naming the router", () => {
    const guarded = PushCheck.guardRouter(router(), [
      counted("authz", ["route /x answers what its scope cannot"]).check,
    ]);
    expect(thrown(() => guarded.getRoutes())).toMatchObject({
      _tag: "PushRefused",
      check: "authz",
      entry: "http",
      message:
        'Push check "authz" refused the source while Convex analyzed http: route /x answers what its scope cannot',
    });
  });

  it("serves a request without running a check, and leaves the input unchanged", () => {
    const original = router();
    const { check, runs } = counted("authz", ["refused"]);
    const guarded = PushCheck.guardRouter(original, [check]);
    expect(guarded.lookup("/hello", "GET")?.[1]).toBe("GET");
    expect(() => original.getRoutes()).not.toThrow();
    expect(PushCheck.checksOf(original)).toEqual([]);
    expect(runs.count).toBe(0);
    expect(PushCheck.guardRouter(original, [])).toBe(original);
  });
});
