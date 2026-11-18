import { FunctionSpec } from "@confect/core";
import * as RouteSpecs from "@confect/cli/RouteSpecs";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";

interface Recursive {
  readonly [index: number]: string | Recursive;
  readonly length: number;
}
const Recursive: Schema.Codec<string | Recursive> = Schema.Union([
  Schema.String,
  Schema.Array(Schema.suspend(() => Recursive)),
]);
const Loop: Schema.Codec<string> = Schema.Union([
  Schema.Literal("a"),
  Schema.suspend(() => Loop),
]);

/**
 * Each arg schema with one of its values. The URL carries the value when its
 * StringTree encoding is a string, or for a query arg an array of strings.
 */
const cases: ReadonlyArray<{
  readonly case: string;
  readonly field: Schema.Codec<unknown, unknown>;
  readonly value: unknown;
}> = [
  { case: "a string", field: Schema.String, value: "a" },
  { case: "a number", field: Schema.Finite, value: 1 },
  { case: "a boolean", field: Schema.Boolean, value: true },
  { case: "a string literal", field: Schema.Literals(["a", "b"]), value: "b" },
  {
    case: "a suspended string",
    field: Schema.suspend(() => Schema.String),
    value: "a",
  },
  {
    case: "a string reached through a cycle of suspensions",
    field: Loop,
    value: "a",
  },
  {
    case: "an array of strings",
    field: Schema.Array(Schema.String),
    value: ["a", "b"],
  },
  {
    case: "a suspended array of strings",
    field: Schema.suspend(() => Schema.Array(Schema.String)),
    value: ["a", "b"],
  },
  {
    case: "an array of suspended strings",
    field: Schema.Array(Schema.suspend(() => Schema.String)),
    value: ["a"],
  },
  {
    case: "a tuple of strings",
    field: Schema.Tuple([Schema.String, Schema.String]),
    value: ["a", "b"],
  },
  {
    case: "a tuple with a rest of numbers",
    field: Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Schema.Finite]),
    value: ["a", 1, 2],
  },
  {
    case: "a struct",
    field: Schema.Struct({ text: Schema.String }),
    value: { text: "a" },
  },
  {
    case: "a suspended struct",
    field: Schema.suspend(() => Schema.Struct({ text: Schema.String })),
    value: { text: "a" },
  },
  {
    case: "an array of structs",
    field: Schema.Array(Schema.Struct({ text: Schema.String })),
    value: [{ text: "a" }],
  },
  {
    case: "an array of arrays",
    field: Schema.String.pipe(Schema.Array, Schema.Array),
    value: [["a"]],
  },
  {
    case: "a tuple holding an array",
    field: Schema.Tuple([Schema.String, Schema.Array(Schema.String)]),
    value: ["a", ["b"]],
  },
  {
    case: "a recursive array of strings",
    field: Recursive,
    value: [["a"]],
  },
];

const route = (
  method: "GET" | "POST",
  path: string,
  field: Schema.Codec<unknown, unknown>,
) => {
  const spec = FunctionSpec.httpAction({
    name: "say",
    method,
    path,
    args: () => ({ x: field }),
    returns: () => Schema.String,
  });
  return RouteSpecs.check({
    group: "echo",
    spec,
    functionPath: "echo:say",
    source: "echo.spec.ts",
  });
};

type Args = Schema.Codec<{ readonly x: unknown }, { readonly x: unknown }>;

describe("RouteSpecs.check", () => {
  // The oracle is Effect's own endpoint codec for the arg: encode the value as
  // a client would, and when the URL can carry that, decode it as the server
  // would.
  it.effect.each(cases)(
    "follows Effect's query codec for $case",
    ({ field, value }) =>
      Effect.gen(function* () {
        const query = HttpApiEndpoint.get("say", "/echo", {
          query: Schema.Struct({ x: field }),
        }).query as Args;
        const { x: encoded } = yield* Schema.encodeEffect(query)({ x: value });
        const carried =
          Predicate.isString(encoded) ||
          (Arr.isArray(encoded) && Arr.every(encoded, Predicate.isString));
        if (carried) {
          const decoded = yield* Schema.decodeEffect(
            Schema.toCodecArrayFromSingle(query),
          )({ x: encoded });
          expect(decoded).toEqual({ x: value });
        }
        expect(Result.isSuccess(route("GET", "/echo", field))).toBe(carried);
      }),
  );

  it.effect.each(cases)(
    "follows Effect's path codec for $case",
    ({ field, value }) =>
      Effect.gen(function* () {
        const params = HttpApiEndpoint.post("say", "/echo/:x", {
          params: Schema.Struct({ x: field }),
        }).params as Args;
        const { x: encoded } = yield* Schema.encodeEffect(params)({ x: value });
        const carried = Predicate.isString(encoded);
        if (carried) {
          const decoded = yield* Schema.decodeEffect(params)({ x: encoded });
          expect(decoded).toEqual({ x: value });
        }
        expect(Result.isSuccess(route("POST", "/echo/:x", field))).toBe(
          carried,
        );
      }),
  );
});
