import { describe, expect, it } from "@effect/vitest";
import { Guard, Http } from "@confect/core";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Record from "effect/Record";

describe("Guard", () => {
  it.effect("names a middleware that runs its inner effect", () =>
    Effect.gen(function* () {
      const seen: Array<string> = [];
      const guard = Guard.make("frame", (inner) =>
        Effect.sync(() => seen.push("guard")).pipe(Effect.andThen(inner)),
      );
      expect(guard.name).toBe("frame");
      expect(Guard.isGuard(guard)).toBe(true);
      const inner = HttpServerResponse.text("inner");
      // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- An HttpMiddleware's result channels are Effect's own erased any.
      const result = yield* Effect.succeed(inner).pipe(guard);
      expect([seen, result]).toEqual([["guard"], inner]);
    }),
  );

  it("names the explicit opt-out none", () => {
    expect([Guard.none.name, Guard.isGuard(Guard.none)]).toEqual([
      "none",
      true,
    ]);
  });

  it("refuses a plain function, whose name is not a guard's", () => {
    const named = (inner: unknown) => inner;
    expect([Guard.isGuard(named), Guard.isGuard(undefined)]).toEqual([
      false,
      false,
    ]);
  });
});

describe("Http.make with a guard", () => {
  it("declares a guard and no api for a backend that serves only route specs", () => {
    const http = Http.make({ guard: Guard.none });
    expect([
      http.guard,
      Record.keys(http.api.groups),
      http.docs,
      Http.isHttp(http),
    ]).toEqual([Guard.none, [], undefined, true]);
  });

  it("leaves the guard undefined when none is given", () => {
    expect(Http.make({}).guard).toBeUndefined();
  });
});
