import { describe, expect, it } from "@effect/vitest";
import { Guard, Http } from "@confect/core";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

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

  it("refuses part of an app api passed through a variable", () => {
    const api = HttpApi.make("host").add(
      HttpApiGroup.make("meta").add(HttpApiEndpoint.get("status", "/status")),
    );
    const handlers = HttpApiBuilder.group(api, "meta", (h) =>
      h.handle("status", () => Effect.void),
    );
    const withoutHandlers = { api, guard: Guard.none };
    const withoutApi = { handlers, guard: Guard.none };
    const docsWithoutApi = { docs: "/docs", guard: Guard.none } as const;
    const refusals = Arr.map(
      [
        // @ts-expect-error an api comes with its handlers
        () => Http.make(withoutHandlers),
        // @ts-expect-error handlers come with their api
        () => Http.make(withoutApi),
        // @ts-expect-error a docs page documents an api
        () => Http.make(docsWithoutApi),
      ],
      (make) => {
        try {
          make();
          return undefined;
        } catch (error) {
          return Schema.is(Http.PartialApi)(error) ? error.given : error;
        }
      },
    );
    expect(refusals).toEqual(["api", "handlers", "docs"]);
  });
});
