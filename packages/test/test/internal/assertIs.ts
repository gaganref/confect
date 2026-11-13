import { assert } from "@effect/vitest";

/**
 * Assert that `value` passes `refinement`, and narrow it to the refined type.
 */
export function assertIs<A, B extends A>(
  value: A,
  refinement: (value: A) => value is B,
): asserts value is B {
  assert(refinement(value));
}
