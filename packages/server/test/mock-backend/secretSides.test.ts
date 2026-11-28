import * as Callback from "@confect/core/Callback";
import * as FunctionSpec from "@confect/core/FunctionSpec";
import * as GenericId from "@confect/core/GenericId";
import * as DatabaseSchema from "@confect/server/DatabaseSchema";
import * as FunctionRegistryItem from "@confect/server/FunctionRegistryItem";
import * as RegisteredConvexFunction from "@confect/server/RegisteredConvexFunction";
import * as RegisteredNodeFunction from "@confect/server/RegisteredNodeFunction";
import * as Table from "@confect/server/Table";
import { convexTest } from "convex-test";
import {
  defineSchema,
  defineTable,
  makeFunctionReference,
} from "convex/server";
import { v } from "convex/values";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { assert, describe, expect, it } from "@effect/vitest";
// Imported by relative path, as in `TestConfect.ts`.
import * as Json from "../../../test/src/internal/Json";

const marker = "canary-secret-side-5c2e8a71";
const Secret = Schema.RedactedFromValue(Schema.String);

const database = DatabaseSchema.make({
  keys: Table.make(() => Schema.Struct({ label: Schema.String }))("keys"),
  other: Table.make(() => Schema.Struct({ label: Schema.String }))("other"),
});
const convexSchema = defineSchema({
  keys: defineTable({ label: v.string() }),
  other: defineTable({ label: v.string() }),
});

const item = (
  spec: FunctionSpec.AnyWithProps,
  handler: (args: any) => Effect.Effect<any>,
) => {
  const result = FunctionRegistryItem.make({
    functionSpec: spec,
    groupMiddlewareAttachments: [],
    handler,
  });
  if (result._tag !== "Confect") throw new Error("Expected a Confect function");
  return result;
};

type Value = Schema.Codec<any, string>;

/**
 * An opened value and the `keys` row it came from, or that none was there.
 */
const opened = (value: Value) =>
  Schema.Array(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("missing") }),
      Schema.Struct({
        kind: Schema.Literal("opened"),
        value,
        row: GenericId.GenericId("keys"),
      }),
    ]),
  );

/**
 * Opens `answer`, naming the row it is passed as its `keys` row.
 */
const opener = (name: string, value: Value, answer: unknown) =>
  item(
    FunctionSpec.internalMutation({
      name,
      args: () => ({ row: Schema.String }),
      returns: () => opened(value),
    }),
    ({ row }) => Effect.succeed([{ kind: "opened", value: answer, row }]),
  );

const changer = (name: string, value: Value) =>
  item(
    FunctionSpec.internalMutation({
      name,
      args: () => ({
        items: Schema.Array(
          Schema.Union([
            Schema.Struct({ kind: Schema.Literal("set"), value }),
            Schema.Struct({ kind: Schema.Literal("unset") }),
          ]),
        ),
      }),
      returns: () => Schema.Null,
    }),
    () => Effect.succeed(null),
  );

const items = {
  open: opener("open", Secret, Redacted.make(marker)),
  openPlain: opener("openPlain", Schema.String, marker),
  change: changer("change", Secret),
  changePlain: changer("changePlain", Schema.String),
};
type Name = keyof typeof items;

const prepared = (name: Name) => {
  const definition = RegisteredConvexFunction.prepare(database, items[name]);
  assert(definition._tag === "InternalMutation");
  return definition;
};

const backend = () => {
  const t = convexTest(convexSchema, {
    "./_generated/server.ts": () => Promise.resolve({}),
    "./secrets.ts": () =>
      Promise.resolve({
        open: RegisteredConvexFunction.make(database, items.open),
        openPlain: RegisteredConvexFunction.make(database, items.openPlain),
        change: RegisteredConvexFunction.make(database, items.change),
        changePlain: RegisteredConvexFunction.make(database, items.changePlain),
      }),
  });
  const ref = (name: Name) =>
    makeFunctionReference<"mutation", any, any>(`secrets:${name}`);
  const rows = t.run((ctx) =>
    Promise.all([
      ctx.db.insert("keys", { label: "key" }),
      ctx.db.insert("other", { label: "other" }),
    ]),
  );
  const refusal = (name: Name, args: unknown) =>
    t.mutation(ref(name), args).then(
      () => expect.unreachable(`${name} was not refused`),
      (error: unknown) => {
        assert(error instanceof Error);
        return error;
      },
    );
  return { t, ref, rows, refusal };
};

const text = (error: Error) => `${error.name}: ${error.message}`;

/**
 * A refusal's `ConvexError` data, whether the backend handed it over parsed or
 * as Convex's JSON text.
 */
const dataOf = (error: Error): unknown => {
  const data: unknown = (error as { readonly data?: unknown }).data;
  return typeof data === "string" ? Json.parse(data) : data;
};

/**
 * A refusal Confect made in Convex's place: its stack holds no frame, its data
 * is exactly the four value-free fields, and nothing of it holds `value`.
 */
const refusedWithout = (
  error: Error,
  value: string,
  side: "arguments" | "returns",
  path: string,
) => {
  const data = dataOf(error);
  expect({
    stack: pipe(error.stack ?? "", Str.includes("    at ")),
    data,
    printed: Arr.some(
      [text(error), error.stack ?? "", Json.stringify(data)],
      (printed) => pipe(printed, Str.includes(value)),
    ),
  }).toEqual({
    stack: false,
    data: {
      _tag: "@confect/server/SecretSideRefused",
      side,
      path,
      validator: expect.any(String),
    },
    printed: false,
  });
};

/**
 * A refusal that reads `refusal` and then names its validator, as Convex's own
 * does, but never prints `value` or a stack frame.
 */
const printedWithout = (value: string, refusal: string) =>
  expect.toSatisfy(
    (message: string) =>
      pipe(message, Str.startsWith(`${refusal}\nValidator: v.union(`)) &&
      !pipe(message, Str.includes(value)) &&
      !pipe(message, Str.includes("    at ")),
  );

const extraSibling = {
  items: [{ kind: "set", value: marker, note: "unexpected" }],
};

describe("a side that holds a secret", () => {
  it("registers no validator with Convex, and a side without one keeps it", () => {
    expect(prepared("open").returns()).toBeUndefined();
    expect(prepared("open").args()).toMatchObject({ row: { kind: "string" } });
    expect(prepared("change").args()).toBeUndefined();
    expect(prepared("change").returns()).toMatchObject({ kind: "null" });
    expect(prepared("openPlain").returns()).toMatchObject({ kind: "array" });
    expect(prepared("changePlain").args()).toMatchObject({
      items: { kind: "array" },
    });
  });

  it("refuses a return with a wrong-table ID and does not print the value", () => {
    const { refusal, rows } = backend();
    return rows
      .then(([, other]) => refusal("open", { row: other }))
      .then((error) => {
        refusedWithout(error, marker, "returns", "[0]");
        return expect(text(error)).toEqual(
          printedWithout(
            marker,
            "ReturnsValidationError: Value does not match validator.\nPath: [0]",
          ),
        );
      });
  });

  it("refuses arguments with an extra field and does not print the value", () =>
    backend()
      .refusal("change", extraSibling)
      .then((error) => {
        refusedWithout(error, marker, "arguments", ".items[0]");
        return expect(text(error)).toEqual(
          printedWithout(
            marker,
            "ArgumentValidationError: Value does not match validator.\nPath: .items[0]",
          ),
        );
      }));

  it("accepts what Convex's validator accepts", () => {
    const { t, ref, rows } = backend();
    return rows.then(([key]) =>
      Promise.all([
        t.mutation(ref("open"), { row: key }),
        t.mutation(ref("change"), {
          items: [{ kind: "set", value: marker }, { kind: "unset" }],
        }),
      ]).then((results) =>
        expect(results).toEqual([
          [{ kind: "opened", value: marker, row: key }],
          null,
        ]),
      ),
    );
  });

  it("leaves a side with no secret to Convex's validator, which prints the value", () => {
    const { refusal, rows } = backend();
    return rows
      .then(([, other]) =>
        Promise.all([
          refusal("openPlain", { row: other }),
          refusal("changePlain", extraSibling),
        ]),
      )
      .then((errors) =>
        expect(Arr.map(errors, text)).toEqual([
          expect.stringContaining(marker),
          expect.stringContaining(marker),
        ]),
      );
  });

  it("refuses to compile an action's secret side that holds an ID", () => {
    const spec = {
      name: "openAction",
      args: () => ({}),
      returns: () => opened(Secret),
    };
    const action = RegisteredConvexFunction.prepare(
      database,
      item(FunctionSpec.internalAction(spec), () => Effect.succeed([])),
    );
    const node = RegisteredNodeFunction.make(
      database,
      item(FunctionSpec.internalNodeAction(spec), () => Effect.succeed([])),
    ) as unknown as { readonly exportReturns: () => string };
    assert(action._tag === "InternalAction");
    const refusal =
      "openAction's returns hold a secret, so Convex's validator would print it and Confect checks them instead. They also hold an ID, and an action has no database to check an ID's table.";
    expect(() => action.returns()).toThrow(refusal);
    expect(() => node.exportReturns()).toThrow(refusal);
  });

  it("checks an action's secret side in Convex's place", () => {
    const reveal = (answer: unknown) =>
      item(
        FunctionSpec.internalAction({
          name: "reveal",
          args: () => ({}),
          returns: () => Schema.Struct({ value: Secret }),
        }),
        () => Effect.succeed(answer),
      );
    const definition = RegisteredConvexFunction.prepare(
      database,
      reveal({ value: Redacted.make(marker) }),
    );
    assert(definition._tag === "InternalAction");
    expect(definition.returns()).toBeUndefined();
    const t = convexTest(convexSchema, {
      "./_generated/server.ts": () => Promise.resolve({}),
      "./reveal.ts": () =>
        Promise.resolve({
          valid: RegisteredConvexFunction.make(
            database,
            reveal({ value: Redacted.make(marker) }),
          ),
        }),
    });
    return t
      .action(makeFunctionReference<"action", any, any>("reveal:valid"), {})
      .then((answer) => expect(answer).toEqual({ value: marker }));
  });
});

const literalMarker = "canary-secret-literal-7e41";
const Anything = Schema.RedactedFromValue(Schema.Unknown);

class Instance {
  readonly held = marker;
}

/**
 * A mutation whose secret return is `answer`, which its validator accepts.
 */
const revealing = (
  name: string,
  value: Schema.Codec<any, any>,
  answer: unknown,
) =>
  RegisteredConvexFunction.make(
    database,
    item(
      FunctionSpec.internalMutation({
        name,
        args: () => ({}),
        returns: () => Schema.Struct({ value }),
      }),
      () => Effect.succeed({ value: Redacted.make(answer) }),
    ),
  );

const unserializable = {
  // oxlint-disable-next-line effecttsgo/global-date -- A Date is a class instance Convex cannot serialize.
  date: new Date(0),
  map: new Map([[marker, 1]]),
  set: new Set([marker]),
  instance: new Instance(),
  bytes: new Uint8Array([1]),
  holesInArray: [undefined, marker],
};

describe("a secret side Convex would still refuse after Confect's check", () => {
  const OnEvent = Callback.mutation("secrets/onEvent", {
    args: () => ({}),
    returns: () => Schema.Null,
  });
  const reveals = {
    ...Rec.map(unserializable, (answer, name) =>
      revealing(name, Anything, answer),
    ),
    huge: revealing("huge", Schema.RedactedFromValue(Schema.BigInt), 2n ** 64n),
  };
  const revealBackend = () =>
    convexTest(convexSchema, {
      "./_generated/server.ts": () => Promise.resolve({}),
      "./reveal.ts": () => Promise.resolve(reveals),
    });

  it.each(Rec.keys(reveals))(
    "refuses a %s return Convex cannot serialize, printing no value",
    (name) =>
      revealBackend()
        .mutation(
          makeFunctionReference<"mutation", any, any>(`reveal:${name}`),
          {},
        )
        .then(
          () => expect.unreachable(`${name} was not refused`),
          (error: unknown) => {
            assert(error instanceof Error);
            refusedWithout(error, marker, "returns", "");
            return expect(text(error)).toMatch(
              /^ReturnsValidationError: Value is not a supported Convex value\.\nValidator: v\.object\(/u,
            );
          },
        ),
  );

  it.each([
    [
      "a secret literal",
      () => Schema.RedactedFromValue(Schema.Literal(`${literalMarker}-secret`)),
      Redacted.make(`${literalMarker}-secret`),
    ],
    [
      "a literal composite secret",
      () =>
        Schema.RedactedFromValue(
          Schema.Struct({
            token: Schema.Literal(`${literalMarker}-composite`),
          }),
        ),
      Redacted.make({ token: `${literalMarker}-composite` }),
    ],
    ["a secret beside literal siblings", () => Secret, Redacted.make("plain")],
  ] as const)(
    "prints %s's side without any literal of it",
    (_name, value, answer) => {
      const literals = item(
        FunctionSpec.internalMutation({
          name: "openLiterals",
          args: () => ({ row: Schema.String }),
          returns: () =>
            Schema.Array(
              Schema.Union([
                Schema.Struct({ kind: Schema.Literal("missing") }),
                Schema.Struct({
                  kind: Schema.Literal(`${literalMarker}-kind`),
                  value: value(),
                  maybe: Schema.optionalKey(
                    Schema.Literal(`${literalMarker}-optional`),
                  ),
                  list: Schema.Array(Schema.Literal(`${literalMarker}-array`)),
                  map: Schema.Record(
                    Schema.String,
                    Schema.Literal(`${literalMarker}-record`),
                  ),
                  option: Schema.OptionFromNullOr(
                    Schema.Literal(`${literalMarker}-option`),
                  ),
                  renamed: Schema.Struct({
                    a: Schema.Literal(`${literalMarker}-keys`),
                  }).pipe(Schema.encodeKeys({ a: "b" })),
                  decoded: Schema.Literal(`${literalMarker}-decodeTo`).pipe(
                    Schema.decodeTo(Schema.String),
                  ),
                  row: GenericId.GenericId("keys"),
                }),
              ]),
            ),
        }),
        ({ row }) =>
          Effect.succeed([
            {
              kind: `${literalMarker}-kind`,
              value: answer,
              list: [],
              map: {},
              option: Option.none(),
              renamed: { a: `${literalMarker}-keys` },
              decoded: `${literalMarker}-decodeTo`,
              row,
            },
          ]),
      );
      const t = convexTest(convexSchema, {
        "./_generated/server.ts": () => Promise.resolve({}),
        "./literal.ts": () =>
          Promise.resolve({
            open: RegisteredConvexFunction.make(database, literals),
          }),
      });
      return t
        .run((ctx) => ctx.db.insert("other", { label: "other" }))
        .then((other) =>
          t
            .mutation(
              makeFunctionReference<"mutation", any, any>("literal:open"),
              {
                row: other,
              },
            )
            .then(
              () => expect.unreachable("openLiterals was not refused"),
              (error: unknown) => {
                assert(error instanceof Error);
                refusedWithout(error, literalMarker, "returns", "[0]");
                return expect(text(error)).toContain(
                  "kind: v.literal(<secret>)",
                );
              },
            ),
        );
    },
  );

  it("refuses arguments the function's own schema refuses, printing nothing of them", () => {
    const Token = Schema.String.check(
      Schema.makeFilter(
        (token: string) => token.length < 8 || `token too long: ${token}`,
      ),
    );
    const storing = RegisteredConvexFunction.make(
      database,
      item(
        FunctionSpec.internalMutation({
          name: "storeToken",
          args: () => ({
            payload: Schema.Struct({ token: Token }).pipe(
              Schema.fromJsonString,
              Schema.RedactedFromValue,
            ),
          }),
          returns: () => Schema.Null,
        }),
        () => Effect.succeed(null),
      ),
    );
    const tokenRevealing = RegisteredConvexFunction.make(
      database,
      item(
        FunctionSpec.internalMutation({
          name: "revealToken",
          args: () => ({}),
          returns: () =>
            Schema.Struct({ value: Schema.RedactedFromValue(Token) }),
        }),
        () => Effect.succeed({ value: Redacted.make(marker) }),
      ),
    );
    const t = convexTest(convexSchema, {
      "./_generated/server.ts": () => Promise.resolve({}),
      "./tokens.ts": () =>
        Promise.resolve({ store: storing, reveal: tokenRevealing }),
    });
    const refusedBy = (name: string, args: unknown) =>
      t
        .mutation(
          makeFunctionReference<"mutation", any, any>(`tokens:${name}`),
          args,
        )
        .then(
          () => expect.unreachable(`${name} was not refused`),
          (error: unknown) => {
            assert(error instanceof Error);
            return error;
          },
        );
    return Promise.all([
      refusedBy("store", { payload: Json.stringify({ token: marker }) }),
      refusedBy("reveal", {}),
    ]).then(([stored, revealed]) => {
      refusedWithout(stored, marker, "arguments", "");
      refusedWithout(revealed, marker, "returns", "");
      return expect([text(stored), text(revealed)]).toEqual([
        expect.stringMatching(
          /^ArgumentValidationError: Value does not match the function's args schema\./u,
        ),
        expect.stringMatching(
          /^ReturnsValidationError: Value does not match the function's returns schema\./u,
        ),
      ]);
    });
  });

  it("refuses to compile a secret side that holds a function handle", () => {
    const definition = RegisteredConvexFunction.prepare(
      database,
      item(
        FunctionSpec.internalMutation({
          name: "withHandle",
          args: () => ({ onEvent: Callback.handle(OnEvent), value: Secret }),
          returns: () => Schema.Null,
        }),
        () => Effect.succeed(null),
      ),
    );
    assert(definition._tag === "InternalMutation");
    expect(() => definition.args()).toThrow(
      "withHandle's arguments hold a secret, so Convex's validator would print it and Confect checks them instead. They also hold a function handle, whose format only the backend can check.",
    );
  });

  it("refuses to compile an action's secret arguments that hold an ID", () => {
    const definition = RegisteredConvexFunction.prepare(
      database,
      item(
        FunctionSpec.internalAction({
          name: "storeAction",
          args: () => ({ row: GenericId.GenericId("keys"), value: Secret }),
          returns: () => Schema.Null,
        }),
        () => Effect.succeed(null),
      ),
    );
    assert(definition._tag === "InternalAction");
    expect(() => definition.args()).toThrow(
      "storeAction's arguments hold a secret, so Convex's validator would print it and Confect checks them instead. They also hold an ID, and an action has no database to check an ID's table.",
    );
  });

  it("refuses, as Convex's push does, a secret side's field Convex would refuse", () => {
    const declared = (value: Value) =>
      RegisteredConvexFunction.prepare(
        database,
        item(
          FunctionSpec.internalMutation({
            name: "hyphenated",
            args: () => ({ "a-b": value }),
            returns: () => Schema.Null,
          }),
          () => Effect.succeed(null),
        ),
      );
    const secret = declared(Secret);
    const plain = declared(Schema.String);
    assert(
      secret._tag === "InternalMutation" && plain._tag === "InternalMutation",
    );
    expect(() => secret.args()).toThrow(
      "Error in args validator: Identifier a-b has invalid character '-': Identifiers can only contain alphanumeric characters or underscores",
    );
    expect(plain.args()).toMatchObject({ "a-b": { kind: "string" } });
  });

  it("refuses an action's invalid secret arguments and invalid secret return", () => {
    const action = (name: string, answer: unknown) =>
      RegisteredConvexFunction.make(
        database,
        item(
          FunctionSpec.internalAction({
            name,
            args: () => ({ value: Secret }),
            returns: () => Schema.Struct({ value: Anything }),
          }),
          () => Effect.succeed({ value: Redacted.make(answer) }),
        ),
      );
    const t = convexTest(convexSchema, {
      "./_generated/server.ts": () => Promise.resolve({}),
      "./actions.ts": () =>
        Promise.resolve({
          valid: action("valid", marker),
          // oxlint-disable-next-line effecttsgo/global-date -- A Date is a class instance Convex cannot serialize.
          dated: action("dated", new Date(0)),
        }),
    });
    const refusedBy = (name: string, args: unknown) =>
      t
        .action(
          makeFunctionReference<"action", any, any>(`actions:${name}`),
          args,
        )
        .then(
          () => expect.unreachable(`${name} was not refused`),
          (error: unknown) => {
            assert(error instanceof Error);
            return error;
          },
        );
    return Promise.all([
      refusedBy("valid", { value: marker, extra: 1 }),
      refusedBy("dated", { value: marker }),
    ]).then(([args, returned]) => {
      refusedWithout(args, marker, "arguments", "");
      refusedWithout(returned, marker, "returns", "");
      return expect([text(args), text(returned)]).toEqual([
        expect.stringMatching(
          /^ArgumentValidationError: Object contains a field that is not in the validator\./u,
        ),
        expect.stringMatching(
          /^ReturnsValidationError: Value is not a supported Convex value\./u,
        ),
      ]);
    });
  });
});
