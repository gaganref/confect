import { Guard as CoreGuard, Http } from "@confect/core";
import { Guard } from "@confect/server";
import { describe, expect, it } from "@effect/vitest";

describe("Guard from @confect/server", () => {
  it("is core's Guard, so a guard made by either passes both checks", () => {
    const frame = Guard.make("frame", (inner) => inner);
    expect([
      Guard.none === CoreGuard.none,
      CoreGuard.isGuard(frame),
      Guard.isGuard(CoreGuard.make("core", (inner) => inner)),
      Http.make({ guard: Guard.none }).guard === CoreGuard.none,
    ]).toEqual([true, true, true, true]);
  });
});
