import { FunctionSpec } from "@confect/core";
import * as RouteSpecs from "@confect/cli/RouteSpecs";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import { isDeepStrictEqual } from "node:util";

interface Recursive {
  readonly [index: number]: string | Recursive;
  readonly length: number;
}
const Recursive: Schema.Codec<string | Recursive> = Schema.Union([
  Schema.String,
  Schema.Array(Schema.suspend(() => Recursive)),
]);
type Text = string | ReadonlyArray<Text>;
const Text: Schema.Codec<Text> = Schema.suspend(() =>
  Schema.Union([Schema.String, Schema.Array(Text)]),
);
const Loop: Schema.Codec<string> = Schema.Union([
  Schema.Literal("a"),
  Schema.suspend(() => Loop),
]);

/**
 * A sample that leaves the arg out of the request.
 */
const absent = Symbol("absent");

const specials = "a b&c=d,e%f?#+é";

// oxlint-disable-next-line effecttsgo/global-date -- Schema.Date's values are Dates.
const epoch = new Date(0);

/**
 * Each arg schema with values that exercise each of its shapes. An arg is
 * accepted exactly when every value survives a URL, unless `refused` names why
 * the check refuses it although these values survive.
 */
const cases: ReadonlyArray<{
  readonly case: string;
  readonly field: Schema.Top;
  readonly samples: ReadonlyArray<unknown>;
  readonly refused?: string;
}> = [
  { case: "a string", field: Schema.String, samples: ["a", "a/b", specials] },
  {
    case: "a refined string",
    field: Schema.String.check(Schema.isMinLength(2)),
    samples: ["ab"],
  },
  {
    case: "a branded string",
    field: Schema.String.pipe(Schema.brand("Id")),
    samples: ["a"],
  },
  {
    case: "a template literal",
    field: Schema.TemplateLiteral([Schema.String, "-", Schema.Finite]),
    samples: ["a-1"],
  },
  {
    case: "a string literal",
    field: Schema.Literals(["a", "b"]),
    samples: ["a", "b"],
  },
  {
    case: "a number",
    // oxlint-disable-next-line effecttsgo/schema-number -- Its non-finite values are samples.
    field: Schema.Number,
    samples: [1, -1.5, Number.NaN, Infinity, -Infinity],
  },
  { case: "a finite number", field: Schema.Finite, samples: [1, 2.5] },
  { case: "a boolean", field: Schema.Boolean, samples: [true, false] },
  { case: "null", field: Schema.Null, samples: [null] },
  { case: "a date", field: Schema.Date, samples: [epoch] },
  {
    case: "a number from a string",
    field: Schema.FiniteFromString,
    samples: [42],
  },
  {
    case: "a number literal",
    field: Schema.Literals([10, 25]),
    samples: [10, 25],
  },
  {
    case: "a string or a number literal",
    field: Schema.Literals(["a", 1]),
    samples: ["a", 1],
  },
  {
    case: "a nullable string literal",
    field: Schema.NullOr(Schema.Literal("a")),
    samples: ["a", null],
  },
  {
    case: "a string or a string literal",
    field: Schema.Union([Schema.String, Schema.Literal("all")]),
    samples: ["a", "all"],
  },
  {
    case: "a string literal or a number",
    field: Schema.Union([Schema.Literal("all"), Schema.Finite]),
    samples: ["all", 1],
  },
  {
    case: "a string or a number literal that reads as the string",
    field: Schema.Literals(["1", 1]),
    samples: ["1", 1],
  },
  {
    case: "a string or a number",
    field: Schema.Union([Schema.String, Schema.Finite]),
    samples: ["a", "1", 1],
  },
  {
    case: "a string or a boolean",
    field: Schema.Union([Schema.String, Schema.Boolean]),
    samples: ["a", "true", true],
  },
  {
    case: "a nullable string",
    field: Schema.NullOr(Schema.String),
    samples: ["a", null, "null"],
  },
  {
    case: "a number or a date",
    field: Schema.Union([Schema.Finite, Schema.Date]),
    samples: [1, epoch],
    refused:
      "the check cannot tell that two members with unbounded strings never share one",
  },
  {
    case: "a suspended string",
    field: Schema.suspend(() => Schema.String),
    samples: ["a"],
  },
  {
    case: "a string reached through a cycle of suspensions",
    field: Loop,
    samples: ["a"],
  },
  {
    case: "an optional string",
    field: Schema.optional(Schema.String),
    samples: ["a", absent, undefined],
  },
  {
    case: "an optional key",
    field: Schema.optionalKey(Schema.String),
    samples: ["a", absent],
  },
  {
    case: "a required string or undefined",
    field: Schema.UndefinedOr(Schema.String),
    samples: ["a", undefined],
  },
  { case: "undefined", field: Schema.Undefined, samples: [undefined] },
  { case: "unknown", field: Schema.Unknown, samples: ["a", 1, { a: "b" }] },
  { case: "any", field: Schema.Any, samples: ["a", 1] },
  {
    case: "an array of strings",
    field: Schema.Array(Schema.String),
    samples: [["a"], ["a", "b"], ["a,b"], [""], [specials]],
  },
  {
    case: "a suspended array of strings",
    field: Schema.suspend(() => Schema.Array(Schema.String)),
    samples: [["a"], ["a", "b"]],
  },
  {
    case: "an array of suspended strings",
    field: Schema.Array(Schema.suspend(() => Schema.String)),
    samples: [["a"], ["a", "b"]],
  },
  {
    case: "an array of numbers",
    field: Schema.Array(Schema.Finite),
    samples: [[1], [1, 2]],
  },
  {
    case: "a non-empty array of strings",
    field: Schema.NonEmptyArray(Schema.String),
    samples: [["a"], ["a", "b"]],
  },
  {
    case: "an optional array of strings",
    field: Schema.String.pipe(Schema.Array, Schema.optional),
    samples: [["a"], ["a", "b"], absent],
  },
  {
    case: "a tuple of strings",
    field: Schema.Tuple([Schema.String, Schema.String]),
    samples: [["a", "b"]],
  },
  {
    case: "a tuple with a rest of numbers",
    field: Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Schema.Finite]),
    samples: [["a"], ["a", 1, 2]],
  },
  {
    case: "a tuple holding undefined",
    field: Schema.Tuple([Schema.UndefinedOr(Schema.String), Schema.String]),
    samples: [
      ["a", "b"],
      [undefined, "b"],
    ],
  },
  {
    case: "a tuple with an optional element",
    field: Schema.Tuple([Schema.optionalKey(Schema.String)]),
    samples: [["a"], []],
  },
  {
    case: "an array of strings or undefined",
    field: Schema.String.pipe(Schema.UndefinedOr, Schema.Array),
    samples: [["a"], [undefined]],
  },
  {
    case: "a string or an array of strings",
    field: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
    samples: ["a", ["a"], ["a", "b"]],
  },
  {
    case: "an array of strings or a string",
    field: Schema.Union([Schema.Array(Schema.String), Schema.String]),
    samples: ["a", ["a"], ["a", "b"]],
  },
  {
    case: "a struct",
    field: Schema.Struct({ text: Schema.String }),
    samples: [{ text: "a" }],
  },
  {
    case: "a suspended struct",
    field: Schema.suspend(() => Schema.Struct({ text: Schema.String })),
    samples: [{ text: "a" }],
  },
  {
    case: "a record",
    field: Schema.Record(Schema.String, Schema.String),
    samples: [{ a: "b" }],
  },
  {
    case: "an array of structs",
    field: Schema.Array(Schema.Struct({ text: Schema.String })),
    samples: [[{ text: "a" }]],
  },
  {
    case: "an array of arrays",
    field: Schema.String.pipe(Schema.Array, Schema.Array),
    samples: [[["a"]], [["a", "b"]]],
  },
  {
    case: "a tuple holding an array",
    field: Schema.Tuple([Schema.String, Schema.Array(Schema.String)]),
    samples: [
      ["a", ["b"]],
      ["a", ["b", "c"]],
    ],
  },
  {
    case: "a union holding a recursive array",
    field: Recursive,
    samples: ["a", ["a"], [["a", "b"]]],
  },
  {
    case: "a suspended recursive union of strings and arrays",
    field: Text,
    samples: ["a", ["a", "b"], [["a", "b"]]],
  },
];

/**
 * Values whose shape the check accepts although they do not come back. Each
 * fails loudly, or loses only what a JSON body loses too.
 */
const limits: ReadonlyArray<{
  readonly case: string;
  readonly at: At;
  readonly field: Schema.Top;
  readonly sample: unknown;
}> = [
  {
    case: "an empty array, which leaves the query key out and answers 400",
    at: "query",
    field: Schema.Array(Schema.String),
    sample: [],
  },
  {
    case: "an empty path param, which the router does not match",
    at: "path",
    field: Schema.String,
    sample: "",
  },
  {
    case: "a dot-segment path param, which Effect's client refuses",
    at: "path",
    field: Schema.String,
    sample: ".",
  },
  {
    case: "negative zero, which reads back as zero as in JSON",
    at: "query",
    // oxlint-disable-next-line effecttsgo/schema-number -- A number's encoding is the subject.
    field: Schema.Number,
    sample: -0,
  },
];

type At = "query" | "path";

/**
 * Serve one endpoint the way `Routes.make` builds it, the arg in the query or
 * in a path param, request the URL Effect's client builds for `sample`, and
 * report whether the handler receives the same args. An arg left out and one
 * given as `undefined` are the same args.
 */
const survives = (field: Schema.Top, sample: unknown, at: At) => {
  const args = sample === absent ? {} : { x: sample };
  const expected = sample === absent || sample === undefined ? {} : args;
  const slot = at === "query" ? "query" : "params";
  const arg = Schema.Struct({ x: field as Schema.Codec<unknown, unknown> });
  const endpoint =
    at === "query"
      ? HttpApiEndpoint.get("say", "/echo", { query: arg })
      : HttpApiEndpoint.get("say", "/echo/:x", { params: arg });
  const api = HttpApi.make("routes").add(
    HttpApiGroup.make("echo").add(endpoint),
  );
  const received: Array<unknown> = [];
  const group = HttpApiBuilder.group(api, "echo", (handlers) =>
    handlers.handle("say", (request) =>
      Effect.sync(() => {
        received.push("query" in request ? request.query : request.params);
      }),
    ),
  );
  const url = Result.try(() =>
    HttpApiClient.urlBuilder(api, { baseUrl: "https://example.com" }).echo.say({
      [slot]: args,
    } as never),
  );
  if (Result.isFailure(url)) return Effect.succeed(false);
  return Effect.acquireUseRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(api).pipe(
          Layer.provide(group),
          Layer.provide(HttpServer.layerServices),
        ),
        { disableLogger: true },
      ),
    ),
    (web) =>
      Effect.map(
        Effect.promise(() => web.handler(new Request(url.success))),
        (response) => response.ok && isDeepStrictEqual(received, [expected]),
      ),
    (web) => Effect.promise(web.dispose),
  );
};

const route = (method: "GET" | "POST", path: string, field: Schema.Top) => {
  const spec = FunctionSpec.httpAction({
    name: "say",
    method,
    path,
    args: () => ({ x: field as Schema.Codec<unknown, unknown> }),
    returns: () => Schema.String,
  });
  return RouteSpecs.check({
    group: "echo",
    spec,
    functionPath: "echo:say",
    source: "echo.spec.ts",
  });
};

const checks = {
  query: (field: Schema.Top) => route("GET", "/echo", field),
  path: (field: Schema.Top) => route("POST", "/echo/:x", field),
};

describe("RouteSpecs.check", () => {
  describe.each(["query", "path"] as const)("as a %s arg", (at) => {
    it.effect.each(cases)(
      "accepts $case exactly when its values survive a URL",
      ({ field, samples, refused }) =>
        Effect.gen(function* () {
          const survived = yield* Effect.forEach(samples, (sample) =>
            survives(field, sample, at),
          );
          expect(
            Result.isSuccess(checks[at](field)),
            `survived: ${String(survived)}`,
          ).toBe(refused === undefined && Arr.every(survived, identity));
          if (refused !== undefined) expect(survived).not.toContain(false);
        }),
    );
  });

  it.effect.each(limits)("accepts $case", ({ at, field, sample }) =>
    Effect.gen(function* () {
      const survived = yield* survives(field, sample, at);
      expect(survived).toBe(false);
      expect(Result.isSuccess(checks[at](field))).toBe(true);
    }),
  );

  it("names the route, the arg and why the URL cannot carry it", () => {
    const refusal = (result: ReturnType<typeof route>) =>
      Result.isFailure(result) ? result.failure.reason : undefined;
    expect(refusal(checks.query(Text))).toContain(
      'Route "echo:say" GET arg "x"',
    );
    expect(refusal(checks.path(Schema.Array(Schema.String)))).toContain(
      'Route "echo:say" path param "x"',
    );
  });
});
