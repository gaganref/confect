import * as Callback from "@confect/core/Callback";
import {
  compileArgsSchema,
  compileReturnsSchema,
} from "@confect/core/SchemaToValidator";
import callbackValidators from "./fixtures/callback-validators.json";
import {
  compileSchema,
  compileAst,
  UnsupportedPropertySignatureKeyTypeError,
  type UndefinedOrValueToValidator,
  type ValueToValidator,
} from "@confect/core/SchemaToValidator";
import { GenericId } from "@confect/core/GenericId";
import type { TypeError } from "@confect/core/Types";
import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
  v,
  type VAny,
  type VArray,
  type VObject,
  type VOptional,
} from "convex/values";
import type { FunctionType } from "convex/server";
import {
  jsonToConvex,
  type RecordKeyValidatorJSON,
  type ValidatorJSON,
} from "convex/values";
import type { Brand } from "effect";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import { rows } from "./LoweringMatrix";

describe("UnsupportedPropertySignatureKeyTypeError", () => {
  it("preserves raw numeric and symbol keys through construction and schema decoding", () => {
    for (const propertyKey of [NaN, Infinity, -Infinity, Symbol("key")]) {
      const error = UnsupportedPropertySignatureKeyTypeError.make({
        propertyKey,
      });
      const decoded = Result.getOrThrow(
        Schema.decodeResult(UnsupportedPropertySignatureKeyTypeError)({
          _tag: "UnsupportedPropertySignatureKeyTypeError",
          propertyKey,
        }),
      );

      expect(error.propertyKey).toBe(propertyKey);
      expect(decoded).toBeInstanceOf(UnsupportedPropertySignatureKeyTypeError);
      expect(decoded.propertyKey).toBe(propertyKey);
      expect(error.message).toContain(propertyKey.toString());
    }
  });
});

describe("ValueToValidator", () => {
  it("preserves wide literal unions in required, optional, and nested validators", () => {
    type Hex =
      | "0"
      | "1"
      | "2"
      | "3"
      | "4"
      | "5"
      | "6"
      | "7"
      | "8"
      | "9"
      | "a"
      | "b"
      | "c"
      | "d"
      | "e"
      | "f";
    type Wide = `member_${Hex}${Hex}`;
    type Converted = ValueToValidator<{
      code: Wide;
      optional?: Wide;
      nested: { codes: readonly Wide[] };
    }>;
    type Required = Converted["fields"]["code"];
    type Optional = Converted["fields"]["optional"];
    type Element = Converted["fields"]["nested"]["fields"]["codes"]["element"];
    expectTypeOf<Required["members"]["length"]>().toEqualTypeOf<256>();
    expectTypeOf<Required["members"][number]["type"]>().toEqualTypeOf<Wide>();
    expectTypeOf<
      Required["members"][number]["kind"]
    >().toEqualTypeOf<"literal">();
    expectTypeOf<
      Required["members"][number]["isOptional"]
    >().toEqualTypeOf<"required">();
    expectTypeOf<Optional["type"]>().toEqualTypeOf<Wide | undefined>();
    expectTypeOf<Optional["isOptional"]>().toEqualTypeOf<"optional">();
    expectTypeOf<Optional["members"]>().toEqualTypeOf<Required["members"]>();
    expectTypeOf<Element>().toEqualTypeOf<Required>();
    expectTypeOf<Converted["fieldPaths"]>().toEqualTypeOf<
      "code" | "optional" | "nested" | "nested.codes"
    >();
  });

  it("preserves boolean folding and member types in wide mixed unions", () => {
    type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7";
    type Wide = `member_${Digit}${Digit}`;
    type Converted = ValueToValidator<
      Wide | boolean | 42 | null | { count: number }
    >;
    type Members = Converted["members"][number];
    expectTypeOf<Converted["members"]["length"]>().toEqualTypeOf<68>();
    expectTypeOf<Members["type"]>().toEqualTypeOf<
      Wide | boolean | 42 | null | { count: number }
    >();
    expectTypeOf<
      Extract<Members, { kind: "boolean" }>["type"]
    >().toEqualTypeOf<boolean>();
    expectTypeOf<Members["isOptional"]>().toEqualTypeOf<"required">();
    expectTypeOf<Converted["fieldPaths"]>().toEqualTypeOf<"count">();
  });

  it("preserves never element validators", () => {
    expectTypeOf<ValueToValidator<[]>>().toEqualTypeOf<
      VArray<never[], never>
    >();
    expectTypeOf<ValueToValidator<readonly []>>().toEqualTypeOf<
      VArray<never[], never>
    >();
    expectTypeOf<ValueToValidator<never[]>>().toEqualTypeOf<
      VArray<never[], never>
    >();
  });

  it("preserves undefined-only and optional-never fields", () => {
    expectTypeOf<ValueToValidator<{ value: undefined }>>().toEqualTypeOf<
      VObject<{ value: never }, { value: VOptional<VAny> }>
    >();
    expectTypeOf<ValueToValidator<{ value?: never }>>().toEqualTypeOf<
      VObject<{ value?: never }, { value: VOptional<VAny> }>
    >();
  });

  it("distinguishes required and optional any fields", () => {
    const expected = v.object({
      required: v.any(),
      optional: v.optional(v.any()),
    });
    expectTypeOf<
      ValueToValidator<{ required: any; optional?: any }>
    >().toEqualTypeOf<typeof expected>();
  });

  it("constructs required record values independently of object optionality", () => {
    const expected = v.object({
      records: v.array(v.record(v.string(), v.any())),
      optional: v.optional(v.record(v.string(), v.any())),
    });
    expectTypeOf<
      ValueToValidator<{
        readonly records: ReadonlyArray<Record<string, any>>;
        readonly optional?: Record<string, any>;
      }>
    >().toEqualTypeOf<typeof expected>();
  });

  it("keeps collection children required when their containing fields are optional", () => {
    type Converted = ValueToValidator<{
      rows?: ReadonlyArray<Record<string, { label?: string }>>;
      metadata?: Record<string, readonly number[]>;
      choice?:
        | { kind: "text"; text: string }
        | { kind: "number"; value: number };
    }>;
    type Rows = Converted["fields"]["rows"];
    type Metadata = Converted["fields"]["metadata"];
    type Choice = Converted["fields"]["choice"];

    expectTypeOf<Rows["isOptional"]>().toEqualTypeOf<"optional">();
    expectTypeOf<Rows["element"]["isOptional"]>().toEqualTypeOf<"required">();
    expectTypeOf<
      Rows["element"]["value"]["isOptional"]
    >().toEqualTypeOf<"required">();
    expectTypeOf<
      Rows["element"]["value"]["fields"]["label"]["isOptional"]
    >().toEqualTypeOf<"optional">();
    expectTypeOf<Metadata["isOptional"]>().toEqualTypeOf<"optional">();
    expectTypeOf<Metadata["value"]["isOptional"]>().toEqualTypeOf<"required">();
    expectTypeOf<
      Metadata["value"]["element"]["isOptional"]
    >().toEqualTypeOf<"required">();
    expectTypeOf<Choice["isOptional"]>().toEqualTypeOf<"optional">();
    expectTypeOf<
      Choice["members"][number]["isOptional"]
    >().toEqualTypeOf<"required">();
  });

  it("rejects undefined record values without absorbing a never array element", () => {
    expectTypeOf<
      ValueToValidator<Record<string, number | undefined>>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      ValueToValidator<ReadonlyArray<Record<string, number | undefined>>>
    >().toEqualTypeOf<VArray<Record<string, number>[], never>>();
  });

  it("keeps optional fields in record values", () => {
    const expected = v.record(
      v.string(),
      v.object({
        labels: v.array(v.literal("label")),
        metadata: v.optional(v.record(v.string(), v.any())),
      }),
    );
    expectTypeOf<
      ValueToValidator<
        Record<
          string,
          {
            readonly labels: readonly "label"[];
            readonly metadata?: Record<string, any>;
          }
        >
      >
    >().toEqualTypeOf<typeof expected>();
  });

  it("preserves the types and field paths of readonly nested values", () => {
    const expected = v.object({
      profile: v.optional(v.object({ name: v.string(), active: v.boolean() })),
      rows: v.array(v.object({ count: v.float64() })),
    });
    type Input = {
      readonly profile?: { readonly name: string; readonly active: boolean };
      readonly rows: ReadonlyArray<{ readonly count: number }>;
    };
    expectTypeOf<ValueToValidator<Input>>().toEqualTypeOf<typeof expected>();
    expectTypeOf<ValueToValidator<Input>["fieldPaths"]>().toEqualTypeOf<
      "profile" | "profile.name" | "profile.active" | "rows"
    >();
  });

  it("does not treat shared subtrees as cycles", () => {
    type Child = { label: string };
    const expected = v.object({
      left: v.object({ label: v.string() }),
      right: v.object({ label: v.string() }),
    });
    expectTypeOf<
      ValueToValidator<{ left: Child; right: Child }>
    >().toEqualTypeOf<typeof expected>();
  });

  it("collapses a nested cycle but not a legitimate any field", () => {
    type Recursive = { next: Recursive };
    expectTypeOf<
      ValueToValidator<{ value: any; nested: Recursive }>
    >().toEqualTypeOf<VAny>();
  });

  it("preserves recursion detection before invalid-value rejection", () => {
    type RecursiveTuple = [string, RecursiveTuple?];
    type RecursiveMap = Map<string, RecursiveMap>;
    type RecursiveSet = Set<RecursiveSet>;
    type InvalidRecursive = { invalid: Date; next: InvalidRecursive };
    expectTypeOf<ValueToValidator<RecursiveTuple>>().toEqualTypeOf<VAny>();
    expectTypeOf<ValueToValidator<RecursiveMap>>().toEqualTypeOf<VAny>();
    expectTypeOf<ValueToValidator<RecursiveSet>>().toEqualTypeOf<VAny>();
    expectTypeOf<ValueToValidator<InvalidRecursive>>().toEqualTypeOf<VAny>();
    expectTypeOf<
      ValueToValidator<Date | InvalidRecursive>
    >().toEqualTypeOf<VAny>();
  });

  it("preserves branded recursion boundaries", () => {
    type Recursive = { next: Recursive };
    type Branded = { child: Recursive } & Brand.Brand<"parent">;
    expectTypeOf<ValueToValidator<Branded>>().toEqualTypeOf<
      TypeError<"Provided value is not a valid Convex value", Branded>
    >();
    type BrandedArray = Recursive[] & Brand.Brand<"array">;
    expectTypeOf<
      ValueToValidator<BrandedArray>["kind"]
    >().toEqualTypeOf<"array">();
    expectTypeOf<
      ValueToValidator<BrandedArray>["element"]
    >().toEqualTypeOf<VAny>();
  });

  it("detects recursion through augmented primitives and readonly arrays", () => {
    type Recursive = { next: Recursive };
    expectTypeOf<
      ValueToValidator<{ value: string & { child: Recursive } }>
    >().toEqualTypeOf<VAny>();
    expectTypeOf<
      ValueToValidator<readonly string[] & { child: Recursive }>
    >().toEqualTypeOf<VAny>();
  });

  it("preserves invalid symbol-keyed fields as never", () => {
    const metadata = Symbol();
    type Input = { name: string; [metadata]: () => string };
    expectTypeOf<
      ValueToValidator<Input>["fields"][typeof metadata]
    >().toEqualTypeOf<never>();
  });

  it("preserves tagged errors for non-recursive invalid values", () => {
    expectTypeOf<ValueToValidator<unknown>>().toEqualTypeOf<
      TypeError<"Provided value is not a valid Convex value", unknown>
    >();
    expectTypeOf<ValueToValidator<Date | string>>().toEqualTypeOf<
      TypeError<"Provided value is not a valid Convex value", Date | string>
    >();
  });
});

describe("UndefinedOrValueToValidator", () => {
  it("preserves any, never, undefined, and recursive values", () => {
    type Recursive = { child: Recursive };
    expectTypeOf<UndefinedOrValueToValidator<any>>().toEqualTypeOf<
      VOptional<VAny>
    >();
    expectTypeOf<UndefinedOrValueToValidator<never>>().toEqualTypeOf<never>();
    expectTypeOf<UndefinedOrValueToValidator<undefined>>().toEqualTypeOf<
      VOptional<VAny>
    >();
    expectTypeOf<
      UndefinedOrValueToValidator<Recursive | undefined>
    >().toEqualTypeOf<VOptional<VAny>>();
  });

  it("matches native optional wrapping for arrays, objects, records, and unions", () => {
    type ArrayValue = readonly string[];
    type ObjectValue = { readonly name: string };
    type RecordValue = Record<string, any>;
    type UnionValue = string | number | null;
    expectTypeOf<
      UndefinedOrValueToValidator<ArrayValue | undefined>
    >().toEqualTypeOf<VOptional<ValueToValidator<ArrayValue>>>();
    expectTypeOf<
      UndefinedOrValueToValidator<ObjectValue | undefined>
    >().toEqualTypeOf<VOptional<ValueToValidator<ObjectValue>>>();
    expectTypeOf<
      UndefinedOrValueToValidator<RecordValue | undefined>
    >().toEqualTypeOf<VOptional<ValueToValidator<RecordValue>>>();
    expectTypeOf<
      UndefinedOrValueToValidator<UnionValue | undefined>
    >().toEqualTypeOf<VOptional<ValueToValidator<UnionValue>>>();
  });
});

describe("ID schemas", () => {
  it("compiles an ID to a table-specific validator", () => {
    const expected = v.id("users");
    const compiled = compileSchema(GenericId("users"));

    expect(compiled).toEqual(expected);
    expectTypeOf(compiled).toEqualTypeOf<typeof expected>();
  });

  it("compiles an ID-keyed record field with checks and annotations", () => {
    const schema = Schema.Struct({
      counts: Schema.Record(
        GenericId("shipmentLineItems")
          .check(Schema.isMinLength(1))
          .annotate({ title: "Line item ID" }),
        Schema.Finite,
      ).check(Schema.isMinProperties(1)),
    });

    expect(compileSchema(schema)).toEqual(
      v.object({
        counts: v.record(v.id("shipmentLineItems"), v.float64()),
      }),
    );
  });
});

describe("compiler preprocessing", () => {
  it.effect("captures union members before executing the compiler effect", () =>
    Effect.gen(function* () {
      const ast = Schema.Union([Schema.String, Schema.Boolean]).ast;
      const effect = compileAst(ast);
      Object.defineProperty(ast, "types", { value: [Schema.Null.ast] });
      const result1 = yield* effect;
      expect(result1).toEqual(v.union(v.string(), v.boolean()));
      const result2 = yield* effect;
      expect(result2).toEqual(v.union(v.string(), v.boolean()));
      const result3 = yield* compileAst(ast);
      expect(result3).toEqual(v.null());
    }),
  );

  it.effect(
    "captures tuple elements before executing the compiler effect",
    () =>
      Effect.gen(function* () {
        const ast = Schema.Tuple([Schema.String]).ast;
        const effect = compileAst(ast);
        Object.defineProperty(ast, "elements", { value: [Schema.Boolean.ast] });
        const result4 = yield* effect;
        expect(result4).toEqual(v.array(v.string()));
        const result5 = yield* effect;
        expect(result5).toEqual(v.array(v.string()));
        const result6 = yield* compileAst(ast);
        expect(result6).toEqual(v.array(v.boolean()));
      }),
  );

  it.effect(
    "captures array rest elements before executing the compiler effect",
    () =>
      Effect.gen(function* () {
        const ast = Schema.Array(Schema.String).ast;
        const effect = compileAst(ast);
        Object.defineProperty(ast, "rest", { value: [Schema.Boolean.ast] });
        const result7 = yield* effect;
        expect(result7).toEqual(v.array(v.string()));
        const result8 = yield* effect;
        expect(result8).toEqual(v.array(v.string()));
        const result9 = yield* compileAst(ast);
        expect(result9).toEqual(v.array(v.boolean()));
      }),
  );
});

describe("callback handles", () => {
  it("lowers optional EmailArgs callbacks with their encoded contract", () => {
    const OnEvent = Callback.mutation("email/onEvent", {
      args: () => ({
        attempts: Schema.Finite,
        message: Schema.String,
        fromName: Schema.String,
      }),
      returns: () => Schema.Null,
    });
    const EmailArgs = Schema.Struct({
      fromName: Schema.String.annotate({
        description: "Sender name on every email.",
      }),
      maxAttempts: Schema.optional(Schema.Int),
      onEvent: Schema.optional(Callback.handle(OnEvent)),
    });
    expect(Reflect.get(v.object(compileArgsSchema(EmailArgs)), "json")).toEqual(
      callbackValidators,
    );
  });
});

it.each([
  ["query", Callback.query],
  ["mutation", Callback.mutation],
  ["action", Callback.action],
] as const)(
  "lowers %s callback codecs to their encoded validators",
  (functionType, make) => {
    const contract = make("email/encoded", {
      args: () => ({ count: Schema.FiniteFromString }),
      returns: () => Schema.FiniteFromString,
    });
    const fields = compileArgsSchema(
      Schema.Struct({ callbacks: Schema.Array(Callback.handle(contract)) }),
    );
    expect(fields).toEqual({
      callbacks: v.array(
        v.function({
          fnType: functionType,
          args: { count: v.string() },
          returns: v.string(),
        }),
      ),
    });
  },
);

const json = (validator: object): ValidatorJSON =>
  Reflect.get(validator, "json");

type LiteralType<Literal> = Literal extends string
  ? "string"
  : Literal extends number
    ? "number"
    : Literal extends bigint
      ? "bigint"
      : Literal extends boolean
        ? "boolean"
        : never;

/**
 * Each shape a Convex validator can take, read from Convex's own types, so a
 * kind Convex adds fails to compile here until it is placed as one the matrix
 * lowers or one the lowering never emits.
 */
type Feature =
  | ValidatorJSON["type"]
  | `field.${"optional" | "required"}`
  | `function.${FunctionType}`
  | `recordKey.${RecordKeyValidatorJSON["type"]}`
  | `literal.${LiteralType<Parameters<typeof v.literal>[0]>}`;

const features = {
  null: "row",
  number: "row",
  bigint: "row",
  commitTs: "row",
  function: "row",
  boolean: "row",
  string: "row",
  bytes: "row",
  any: "row",
  literal: "row",
  id: "row",
  array: "row",
  record: "row",
  object: "row",
  union: "row",
  "field.optional": "row",
  "field.required": "row",
  "function.query": "row",
  "function.mutation": "row",
  "function.action": "row",
  "recordKey.string": "row",
  "recordKey.id": "row",
  // Effect gives a union key one index signature per member.
  "recordKey.union": "not emitted",
  "literal.string": "row",
  "literal.number": "row",
  "literal.bigint": "row",
  "literal.boolean": "row",
} as const satisfies Record<Feature, "row" | "not emitted">;

const featuresOf = (validator: ValidatorJSON): ReadonlyArray<string> => {
  switch (validator.type) {
    case "object":
      return Arr.prepend(
        Arr.flatMap(Rec.values(validator.value), (field) =>
          Arr.prepend(
            featuresOf(field.fieldType),
            `field.${field.optional ? "optional" : "required"}`,
          ),
        ),
        validator.type,
      );
    case "array":
      return [validator.type, ...featuresOf(validator.value)];
    case "union":
      return [validator.type, ...Arr.flatMap(validator.value, featuresOf)];
    case "record":
      return [
        validator.type,
        `recordKey.${validator.keys.type}`,
        ...featuresOf(validator.keys),
        ...featuresOf(validator.values.fieldType),
      ];
    case "function":
      return [
        validator.type,
        `function.${validator.fnType}`,
        ...(validator.args === undefined ? [] : featuresOf(validator.args)),
        ...(validator.returns === undefined
          ? []
          : featuresOf(validator.returns)),
      ];
    case "literal":
      return [
        validator.type,
        `literal.${typeof jsonToConvex(validator.value)}`,
      ];
    default:
      return [validator.type];
  }
};

/**
 * Every AST tag, read from Effect's own type, as one the matrix lowers or one
 * the lowering refuses. `Undefined` lowers only as an optional field's
 * absence.
 */
const tags = {
  Declaration: "row",
  Null: "row",
  Undefined: "row",
  Void: "refused",
  Never: "refused",
  Unknown: "row",
  Any: "row",
  String: "row",
  Number: "row",
  Boolean: "row",
  BigInt: "row",
  Symbol: "refused",
  Literal: "row",
  UniqueSymbol: "refused",
  ObjectKeyword: "refused",
  Enum: "refused",
  TemplateLiteral: "refused",
  Arrays: "row",
  Objects: "row",
  Union: "row",
  Suspend: "row",
} as const satisfies Record<SchemaAST.AST["_tag"], "row" | "refused">;

type Refused = {
  [Tag in keyof typeof tags]: (typeof tags)[Tag] extends "refused"
    ? Tag
    : never;
}[keyof typeof tags];

const refused = {
  Void: Schema.Void,
  Never: Schema.Never,
  Symbol: Schema.Symbol,
  UniqueSymbol: Schema.UniqueSymbol(Symbol.for("matrix")),
  ObjectKeyword: Schema.ObjectKeyword,
  Enum: Schema.Enum({ A: "a" }),
  TemplateLiteral: Schema.TemplateLiteral(["a", Schema.String]),
} satisfies Record<Refused, Schema.Top>;

const tagsOf = (ast: SchemaAST.AST): ReadonlyArray<string> => {
  switch (ast._tag) {
    case "Union":
      return [ast._tag, ...Arr.flatMap(ast.types, tagsOf)];
    case "Objects":
      return [
        ast._tag,
        ...Arr.flatMap(ast.propertySignatures, ({ type }) => tagsOf(type)),
        ...Arr.flatMap(ast.indexSignatures, ({ parameter, type }) =>
          Arr.appendAll(tagsOf(parameter), tagsOf(type)),
        ),
      ];
    case "Arrays":
      return [
        ast._tag,
        ...Arr.flatMap(ast.elements, tagsOf),
        ...Arr.flatMap(ast.rest, tagsOf),
      ];
    default:
      return [ast._tag];
  }
};

describe("lowering matrix", () => {
  it.each(Rec.toEntries(rows))("lowers %s to its row's validator", (_, row) => {
    expect(compileReturnsSchema(row.schema)).toEqual(row.validator);
  });

  it("has a row for each shape Convex's validators take", () => {
    expect(
      new Set(
        Arr.flatMap(Rec.values(rows), (row) =>
          row.schema.pipe(compileReturnsSchema, json, featuresOf),
        ),
      ),
    ).toEqual(
      new Set(
        Arr.flatMap(Rec.toEntries(features), ([feature, kind]) =>
          kind === "row" ? [feature] : [],
        ),
      ),
    );
  });

  it("has a row for each AST tag the lowering accepts", () => {
    expect(
      new Set(
        Arr.flatMap(Rec.values(rows), (row) =>
          tagsOf(row.schema.pipe(Schema.toEncoded).ast),
        ),
      ),
    ).toEqual(
      new Set(
        Arr.flatMap(Rec.toEntries(tags), ([tag, kind]) =>
          kind === "row" ? [tag] : [],
        ),
      ),
    );
  });

  it.each(Rec.toEntries(refused))(
    "refuses a field tagged %s",
    (tag, schema) => {
      expect(schema.ast._tag).toBe(tag);
      expect(() =>
        compileReturnsSchema(Schema.Struct({ x: schema })),
      ).toThrow();
    },
  );
});
