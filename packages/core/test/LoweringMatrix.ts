import * as Callback from "@confect/core/Callback";
import * as CommitTs from "@confect/core/CommitTs";
import { GenericId } from "@confect/core/GenericId";
import * as IdScope from "@confect/core/IdScope";
import type { FunctionHandle_future } from "convex/server";
import { v } from "convex/values";
import type {
  CommitTsPlaceholder,
  GenericId as ConvexGenericId,
  Infer,
  Validator,
} from "convex/values";
import * as Effect from "effect/Effect";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";

/**
 * A schema and the validator `SchemaToValidator` lowers its encoded side to.
 * The `SchemaToValidator` suite checks the pairing at runtime.
 */
export interface Row<
  S extends Schema.Codec<any, any> = Schema.Codec<any, any>,
  V extends Validator<any, "required", any> = Validator<any, "required", any>,
> {
  readonly schema: S;
  readonly validator: V;
}

const row = <
  S extends Schema.Codec<any, any>,
  V extends Validator<any, "required", any>,
>(
  schema: S,
  validator: V,
): Row<S, V> => ({ schema, validator });

/**
 * The type Convex's codegen prints into a component's `component.ts` for a
 * validator, from Convex's `Infer` of it. `validatorToType` in Convex's
 * `codegen_templates/validator_helpers.ts` prints the same type as `Infer` for
 * every kind but `id`, which `component.ts` prints as `string`.
 */
export type Printed<T> = 0 extends 1 & T
  ? T
  : T extends ConvexGenericId<string>
    ? string
    : T extends FunctionHandle_future<infer Type, infer Args, infer Returns>
      ? FunctionHandle_future<Type, Printed<Args>, Printed<Returns>>
      : T extends
            | string
            | number
            | bigint
            | boolean
            | null
            | ArrayBuffer
            | CommitTsPlaceholder
        ? T
        : T extends ReadonlyArray<infer Element>
          ? Array<Printed<Element>>
          : [keyof T] extends [never]
            ? T
            : [keyof T] extends [ConvexGenericId<string>]
              ? Record<string, Printed<T[keyof T]>>
              : // Reading an optional key adds `undefined`, which Convex's
                // `ObjectType` excludes from it.
                { [K in keyof T]: Printed<Exclude<T[K], undefined>> };

/**
 * What codegen prints for `row`'s validator.
 */
export type Expected<Row_ extends Row> = Printed<Infer<Row_["validator"]>>;

const ItemId = GenericId("items");
const ForeignId = GenericId("items", IdScope.component("@matrix/other"));
const Bytes = Schema.instanceOf(ArrayBuffer);

interface Tree {
  readonly name: string;
  readonly children: ReadonlyArray<Tree>;
}
const Tree: Schema.Codec<Tree> = Schema.Struct({
  name: Schema.String,
  children: Schema.Array(Schema.suspend((): Schema.Codec<Tree> => Tree)),
});

const OnMutation = Callback.mutation("matrix/onMutation", {
  args: () => ({
    id: ItemId,
    note: Schema.optional(Schema.String),
    count: Schema.BigInt,
  }),
  returns: () => Schema.Array(Schema.Struct({ id: ItemId })),
});
const OnQuery = Callback.query("matrix/onQuery", {
  returns: () => Schema.NullOr(Schema.String),
});
const OnAction = Callback.action("matrix/onAction", {
  args: () => ({ bytes: Bytes }),
  returns: () => Schema.Null,
});

/**
 * One row per form the lowering handles, each named for that form.
 */
const forms = {
  string: row(Schema.String, v.string()),
  number: row(Schema.Finite, v.float64()),
  bigint: row(Schema.BigInt, v.int64()),
  boolean: row(Schema.Boolean, v.boolean()),
  null: row(Schema.Null, v.null()),
  bytes: row(Bytes, v.bytes()),
  commitTs: row(CommitTs.CommitTs, v.commitTs()),
  unknown: row(Schema.Unknown, v.any()),
  any: row(Schema.Any, v.any()),
  stringLiteral: row(Schema.Literal("a"), v.literal("a")),
  numberLiteral: row(Schema.Literal(1), v.literal(1)),
  bigintLiteral: row(Schema.Literal(1n), v.literal(1n)),
  booleanLiteral: row(Schema.Literal(true), v.literal(true)),
  id: row(ItemId, v.id("items")),
  foreignId: row(ForeignId, v.string()),
  brand: row(Schema.String.pipe(Schema.brand("Name")), v.string()),
  transformed: row(Schema.FiniteFromString, v.string()),
  array: row(Schema.Array(Schema.String), v.array(v.string())),
  tuple: row(
    Schema.Tuple([Schema.String, Schema.Finite]),
    v.array(v.union(v.string(), v.float64())),
  ),
  // The lowering keeps a tuple's leading elements and drops its rest.
  tupleWithRest: row(
    Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Schema.Finite]),
    v.array(v.string()),
  ),
  object: row(
    Schema.Struct({ a: Schema.String, b: Schema.Finite }),
    v.object({ a: v.string(), b: v.float64() }),
  ),
  optionalKey: row(
    Schema.Struct({ a: Schema.optionalKey(Schema.String) }),
    v.object({ a: v.optional(v.string()) }),
  ),
  optional: row(
    Schema.Struct({ a: Schema.optional(Schema.String) }),
    v.object({ a: v.optional(v.string()) }),
  ),
  optionalNullable: row(
    Schema.Struct({ a: Schema.String.pipe(Schema.NullOr, Schema.optional) }),
    v.object({ a: v.optional(v.union(v.string(), v.null())) }),
  ),
  optionalWithDefault: row(
    Schema.Struct({
      a: Schema.optionalKey(Schema.String).pipe(
        Schema.withDecodingDefaultKey(Effect.succeed("a")),
      ),
    }),
    v.object({ a: v.optional(v.string()) }),
  ),
  optionFromOptional: row(
    Schema.Struct({ a: Schema.OptionFromOptional(Schema.String) }),
    v.object({ a: v.optional(v.string()) }),
  ),
  record: row(
    Schema.Record(Schema.String, Schema.Finite),
    v.record(v.string(), v.float64()),
  ),
  recordById: row(
    Schema.Record(ItemId, Schema.Finite),
    v.record(v.id("items"), v.float64()),
  ),
  // Effect gives a union key one index signature per member, and the lowering
  // keeps the first.
  recordByKeyUnion: row(
    Schema.Record(Schema.Union([ItemId, Schema.String]), Schema.Finite),
    v.record(v.id("items"), v.float64()),
  ),
  recordByLiterals: row(
    Schema.Record(Schema.Literals(["a", "b"]), Schema.Finite),
    v.object({ a: v.float64(), b: v.float64() }),
  ),
  union: row(
    Schema.Union([Schema.String, Schema.Finite]),
    v.union(v.string(), v.float64()),
  ),
  literals: row(
    Schema.Literals(["a", "b"]),
    v.union(v.literal("a"), v.literal("b")),
  ),
  objectUnion: row(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("a"), a: Schema.String }),
      Schema.Struct({ kind: Schema.Literal("b"), b: ItemId }),
    ]),
    v.union(
      v.object({ kind: v.literal("a"), a: v.string() }),
      v.object({ kind: v.literal("b"), b: v.id("items") }),
    ),
  ),
  nullable: row(Schema.NullOr(Schema.String), v.union(v.string(), v.null())),
  mutationHandle: row(
    Callback.handle(OnMutation),
    v.function({
      fnType: "mutation",
      args: {
        id: v.id("items"),
        note: v.optional(v.string()),
        count: v.int64(),
      },
      returns: v.array(v.object({ id: v.id("items") })),
    }),
  ),
  queryHandle: row(
    Callback.handle(OnQuery),
    v.function({
      fnType: "query",
      args: {},
      returns: v.union(v.string(), v.null()),
    }),
  ),
  actionHandle: row(
    Callback.handle(OnAction),
    v.function({
      fnType: "action",
      args: { bytes: v.bytes() },
      returns: v.null(),
    }),
  ),
};

/**
 * `form` in each position a value takes: alone, as an array's element, as an
 * object's field, required or optional, in a nullable union, and as a callback
 * handle's arg and return.
 */
const positions = <
  S extends Schema.Codec<any, any>,
  V extends Validator<any, "required", any>,
>(
  name: string,
  form: Row<S, V>,
) => ({
  alone: form,
  element: row(Schema.Array(form.schema), v.array(form.validator)),
  field: row(
    Schema.Struct({ x: form.schema }),
    v.object({ x: form.validator }),
  ),
  optionalKey: row(
    Schema.Struct({ x: Schema.optionalKey(form.schema) }),
    v.object({ x: v.optional(form.validator) }),
  ),
  optional: row(
    Schema.Struct({ x: Schema.optional(form.schema) }),
    v.object({ x: v.optional(form.validator) }),
  ),
  nullable: row(Schema.NullOr(form.schema), v.union(form.validator, v.null())),
  handle: row(
    Callback.handle(
      Callback.mutation(`matrix/${name}`, {
        args: () => ({ x: form.schema }),
        returns: () => form.schema,
      }),
    ),
    v.function({
      fnType: "mutation",
      args: { x: form.validator },
      returns: form.validator,
    }),
  ),
});

type Positions<Form extends Row> = ReturnType<
  typeof positions<Form["schema"], Form["validator"]>
>;

type Forms = typeof forms;

/**
 * Every row, keyed `<form>/<position>`.
 */
export type Matrix = {
  readonly [
    Key in {
      [Form in keyof Forms]: `${Form}/${keyof Positions<Forms[Form]>}`;
    }[keyof Forms]
  ]: Key extends `${infer Form extends keyof Forms}/${infer Position}`
    ? Position extends keyof Positions<Forms[Form]>
      ? Positions<Forms[Form]>[Position]
      : never
    : never;
};

/**
 * A recursive schema lowers to `v.any()` wherever it sits, and so does every
 * object, array or union holding it, except a function's args object.
 */
const recursive = {
  "recursive/alone": row(Tree, v.any()),
  "recursive/element": row(Schema.Array(Tree), v.any()),
  "recursive/field": row(Schema.Struct({ x: Tree }), v.any()),
  "recursive/optionalKey": row(
    Schema.Struct({ x: Schema.optionalKey(Tree) }),
    v.any(),
  ),
  "recursive/optional": row(
    Schema.Struct({ x: Schema.optional(Tree) }),
    v.any(),
  ),
  "recursive/nullable": row(Schema.NullOr(Tree), v.any()),
  "recursive/handle": row(
    Callback.handle(
      Callback.mutation("matrix/recursive", {
        args: () => ({ x: Tree }),
        returns: () => Tree,
      }),
    ),
    v.function({ fnType: "mutation", args: { x: v.any() }, returns: v.any() }),
  ),
};

export type AllRows = Matrix & typeof recursive;

const forEachPosition = Rec.fromEntries(
  Arr.flatMap(Rec.toEntries<string, Row>(forms), ([name, form]) =>
    Arr.map(
      Rec.toEntries<string, Row>(positions(name, form)),
      ([position, cell]) => [`${name}/${position}`, cell] as const,
    ),
  ),
);

// `Matrix` names the same keys `forEachPosition` builds.
export const rows = { ...forEachPosition, ...recursive } as unknown as AllRows;

/**
 * The rows where `Component.Api` keeps the schema's own type and Convex's type
 * is `any`. Every other row must match.
 */
export type Excused = keyof typeof recursive;
