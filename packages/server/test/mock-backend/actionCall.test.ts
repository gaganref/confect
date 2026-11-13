import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MutationCtx } from "./fixtures/confect/_generated/services";
import refs from "./fixtures/confect/_generated/refs";
import * as TestConfect from "./TestConfect";
import type * as Ref from "@confect/core/Ref";
import * as String from "effect/String";
import { pipe } from "effect/Function";
import * as Array from "effect/Array";
import { assertIs } from "../internal/assertIs";
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
        assertIs(exit, Exit.isFailure);
        expect(Cause.pretty(exit.cause)).toContain("SchedulingNotAllowed");
      }
      const query2 = yield* c.query(refs.public.groups.notes.list);
      expect(query2).toEqual([]);
      yield* c.run(
        Effect.gen(function* () {
          const ctx = yield* MutationCtx;
          const resolved = yield* Effect.promise(() =>
            ctx.db.system.query("_scheduled_functions").collect(),
          );
          expect(resolved).toEqual([]);
        }),
      );
    }).pipe(Effect.provide(TestConfect.layer)),
  );
  it.effect("calls one mutation or query with fresh state per invocation", () =>
    Effect.gen(function* () {
      const c = yield* TestConfect.TestConfect;
      const executeResult = yield* execute("inspect");
      expect(executeResult).toBe(true);
      const id = yield* execute("write");
      expect(typeof id).toBe("string");
      const executeResult2 = yield* execute("read");
      expect(executeResult2).toBe(1);
      yield* execute("write");
      const executeResult3 = yield* execute("read");
      expect(executeResult3).toBe(2);
      const query2 = yield* c.query(refs.public.groups.notes.list);
      expect(Array.map(query2, (row) => row.text)).toEqual([
        "one call",
        "one call",
      ]);
    }).pipe(Effect.provide(TestConfect.layer)),
  );

  it.effect("rejects repeated evaluation before a second mutation", () =>
    Effect.gen(function* () {
      const c = yield* TestConfect.TestConfect;
      const exit = yield* Effect.exit(execute("twice"));
      assertIs(exit, Exit.isFailure);
      expect(Cause.pretty(exit.cause)).toContain("ActionCallAlreadyUsed");
      const query2 = yield* c.query(refs.public.groups.notes.list);
      expect(Array.map(query2, (row) => row.text)).toEqual(["first only"]);
    }).pipe(Effect.provide(TestConfect.layer)),
  );

  it.effect(
    "rejects parallel calls and a successful handler that never calls",
    () =>
      Effect.gen(function* () {
        const c = yield* TestConfect.TestConfect;
        const parallel = yield* Effect.exit(execute("parallel"));
        assertIs(parallel, Exit.isFailure);
        expect(Cause.pretty(parallel.cause)).toContain("ActionCallAlreadyUsed");
        const unused = yield* Effect.exit(execute("unused"));
        assertIs(unused, Exit.isFailure);
        expect(Cause.pretty(unused.cause)).toContain("ActionCallNotUsed");
        const encoding = yield* Effect.exit(execute("failedEncoding"));
        assertIs(encoding, Exit.isFailure);
        expect(Cause.pretty(encoding.cause)).toContain("ActionCallNotUsed");
        const preflight = yield* Effect.exit(execute("preflight"));
        assertIs(preflight, Exit.isFailure);
        expect(Cause.pretty(preflight.cause)).toContain(
          "ActionCallAlreadyUsed",
        );
        const rows = yield* c.query(refs.public.groups.notes.list);
        expect(rows.length).toBeLessThanOrEqual(1);
        expect(
          Array.every(rows, (row) =>
            pipe(row.text, String.startsWith("parallel")),
          ),
        ).toBe(true);
      }).pipe(Effect.provide(TestConfect.layer)),
  );
});
