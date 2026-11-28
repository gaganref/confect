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
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { assert, describe, expect, it } from "@effect/vitest";

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
      (error: unknown) => (error instanceof Error ? error.message : ""),
    );
  return { t, ref, rows, refusal };
};

/**
 * A message that starts its refusal with `refusal` and never prints `value`.
 */
const printedWithout = (value: string, refusal: string) =>
  expect.toSatisfy(
    (message: string) =>
      pipe(message, Str.includes(refusal)) &&
      !pipe(message, Str.includes(value)),
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
      .then((message) =>
        expect(message).toEqual(
          printedWithout(
            marker,
            "ReturnsValidationError: Value does not match validator.\nPath: [0]",
          ),
        ),
      );
  });

  it("refuses arguments with an extra field and does not print the value", () =>
    backend()
      .refusal("change", extraSibling)
      .then((message) =>
        expect(message).toEqual(
          printedWithout(
            marker,
            "ArgumentValidationError: Value does not match validator.\nPath: .items[0]",
          ),
        ),
      ));

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
      .then((messages) =>
        expect(messages).toEqual([
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
