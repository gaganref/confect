import { expect } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { assertIs } from "./assertIs";

/**
 * Assert that `exit` died with `defect`, as building a backend whose push
 * checks refuse its source dies with the refusal.
 */
export const diedWith = (
  exit: Exit.Exit<unknown, unknown>,
  defect: unknown,
) => {
  assertIs(exit, Exit.isFailure);
  expect(Cause.hasDies(exit.cause)).toBe(true);
  expect(Cause.squash(exit.cause)).toStrictEqual(defect);
};
