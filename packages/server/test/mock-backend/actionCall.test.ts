import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MutationCtx } from "./fixtures/confect/_generated/services";
import refs from "./fixtures/confect/_generated/refs";
import * as TestConfect from "./TestConfect";
import type * as Ref from "@confect/core/Ref";
const execute = (
  mode: Ref.Args<typeof refs.public.groups.actionCall.execute>["mode"],
) =>
  Effect.flatMap(TestConfect.TestConfect, (c) =>
    c.action(refs.public.groups.actionCall.execute, { mode }),
  );

describe("one-call actions", () => {
  it.effect("rejects scheduling before any mutation is dispatched", () =>
    Effect.gen(function* () {
      const c = yield* TestConfect.TestConfect;
      for (const mode of ["scheduleAfter", "scheduleAt"] as const) {
        const exit = yield* Effect.exit(execute(mode));
        assert(Exit.isFailure(exit));
        expect(Cause.pretty(exit.cause)).toContain("SchedulingNotAllowed");
      }
      expect(yield* c.query(refs.public.groups.notes.list)).toEqual([]);
      yield* c.run(
        Effect.gen(function* () {
          const ctx = yield* MutationCtx;
          expect(
            yield* Effect.promise(() =>
              ctx.db.system.query("_scheduled_functions").collect(),
            ),
          ).toEqual([]);
        }),
      );
    }).pipe(Effect.provide(TestConfect.layer)),
  );
  it.effect("calls one mutation or query with fresh state per invocation", () =>
    Effect.gen(function* () {
      const c = yield* TestConfect.TestConfect;
      expect(yield* execute("inspect")).toBe(true);
      const id = yield* execute("write");
      expect(typeof id).toBe("string");
      expect(yield* execute("read")).toBe(1);
      yield* execute("write");
      expect(yield* execute("read")).toBe(2);
      expect(
        (yield* c.query(refs.public.groups.notes.list)).map((row) => row.text),
      ).toEqual(["one call", "one call"]);
    }).pipe(Effect.provide(TestConfect.layer)),
  );

  it.effect("rejects repeated evaluation before a second mutation", () =>
    Effect.gen(function* () {
      const c = yield* TestConfect.TestConfect;
      const exit = yield* Effect.exit(execute("twice"));
      assert(Exit.isFailure(exit));
      expect(Cause.pretty(exit.cause)).toContain("ActionCallAlreadyUsed");
      expect(
        (yield* c.query(refs.public.groups.notes.list)).map((row) => row.text),
      ).toEqual(["first only"]);
    }).pipe(Effect.provide(TestConfect.layer)),
  );

  it.effect(
    "rejects parallel calls and a successful handler that never calls",
    () =>
      Effect.gen(function* () {
        const c = yield* TestConfect.TestConfect;
        const parallel = yield* Effect.exit(execute("parallel"));
        assert(Exit.isFailure(parallel));
        expect(Cause.pretty(parallel.cause)).toContain("ActionCallAlreadyUsed");
        const unused = yield* Effect.exit(execute("unused"));
        assert(Exit.isFailure(unused));
        expect(Cause.pretty(unused.cause)).toContain("ActionCallNotUsed");
        const encoding = yield* Effect.exit(execute("failedEncoding"));
        assert(Exit.isFailure(encoding));
        expect(Cause.pretty(encoding.cause)).toContain("ActionCallNotUsed");
        const preflight = yield* Effect.exit(execute("preflight"));
        assert(Exit.isFailure(preflight));
        expect(Cause.pretty(preflight.cause)).toContain(
          "ActionCallAlreadyUsed",
        );
        const rows = yield* c.query(refs.public.groups.notes.list);
        expect(rows.length).toBeLessThanOrEqual(1);
        expect(rows.every((row) => row.text.startsWith("parallel"))).toBe(true);
      }).pipe(Effect.provide(TestConfect.layer)),
  );
});
