import { GenericId, IdScope } from "@confect/core";
import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
  defineSchema,
  defineTable,
  type GenericTableIndexes,
  type GenericTableSearchIndexes,
  type GenericTableVectorIndexes,
  type TableDefinition,
} from "convex/server";
import { v, type GenericValidator } from "convex/values";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Table from "@confect/server/Table";

describe("Table.tableDefinition", () => {
  it("should extend a generic Convex TableDefinition", () => {
    const confectNotesTableDefinition = Table.tableDefinition(
      Table.make(() =>
        Schema.Struct({
          userId: Schema.optionalKey(GenericId.GenericId("users")),
          text: Schema.String.check(Schema.isMaxLength(100)),
          tag: Schema.optionalKey(Schema.String),
          author: Schema.optionalKey(
            Schema.Struct({
              role: Schema.Literals(["admin", "user"]),
              name: Schema.String,
            }),
          ),
          embedding: Schema.Finite.pipe(Schema.Array, Schema.optionalKey),
        }),
      )
        .index("by_text", ["text"])
        .index("by_role", ["author.role"])
        .searchIndex("text", {
          searchField: "text",
          filterFields: ["tag"],
        })
        .vectorIndex("embedding", {
          vectorField: "embedding",
          filterFields: ["author.name", "tag"],
          dimensions: 1536,
        })("notes"),
    );
    type ConfectNotesTableDefinition = typeof confectNotesTableDefinition;

    const convexNotesTableDefinition = defineTable({
      userId: v.optional(v.id("users")),
      text: v.string(),
      tag: v.optional(v.string()),
      author: v.optional(
        v.object({
          role: v.union(v.literal("admin"), v.literal("user")),
          name: v.string(),
        }),
      ),
      embedding: v.optional(v.array(v.number())),
    })
      .index("by_text", ["text"])
      .index("by_role", ["author.role"])
      .searchIndex("text", {
        searchField: "text",
        filterFields: ["tag"],
      })
      .vectorIndex("embedding", {
        vectorField: "embedding",
        filterFields: ["author.name", "tag"],
        dimensions: 1536,
      });
    type ConvexNotesTableDefinition = typeof convexNotesTableDefinition;

    expectTypeOf<ConfectNotesTableDefinition>().toExtend<
      TableDefinition<
        GenericValidator,
        GenericTableIndexes,
        GenericTableSearchIndexes,
        GenericTableVectorIndexes
      >
    >();

    // The two definitions cannot be compared with `toEqualTypeOf` as a whole:
    // `ValueToValidator` derives `VUnion` member tuples via `UnionToTuple`,
    // whose element order follows TypeScript's internal union interning and is
    // not stable across programs (vitest vs `tsc -b`) or unrelated code
    // changes, while `v.union(...)` fixes the tuple in argument order. Compare
    // the order-insensitive projections instead; the runtime `toStrictEqual`
    // below still pins the exact validator structure (member order included).
    type Projections<TableDefinition_> =
      TableDefinition_ extends TableDefinition<
        infer Validator_,
        infer Indexes_,
        infer SearchIndexes_,
        infer VectorIndexes_
      >
        ? {
            documentType: Validator_["type"];
            fieldPaths: Validator_["fieldPaths"];
            isOptional: Validator_["isOptional"];
            indexes: Indexes_;
            searchIndexes: SearchIndexes_;
            vectorIndexes: VectorIndexes_;
          }
        : never;

    expectTypeOf<Projections<ConfectNotesTableDefinition>>().toEqualTypeOf<
      Projections<ConvexNotesTableDefinition>
    >();

    expect(convexNotesTableDefinition).toStrictEqual(
      confectNotesTableDefinition,
    );
  });

  it("supports indexes on name fields when the schema includes an optional ID", () => {
    const confectOrganizationsTableDefinition = Table.tableDefinition(
      Table.make(() =>
        Schema.Struct({
          name: Schema.String,
          description: Schema.optional(Schema.String),
          createdBy: Schema.optional(GenericId.GenericId("users")),
        }),
      )
        .index("by_name", ["name"])
        .searchIndex("search_name", { searchField: "name" })("organizations"),
    );

    const convexOrganizationsTableDefinition = defineTable({
      name: v.string(),
      description: v.optional(v.string()),
      createdBy: v.optional(v.id("users")),
    })
      .index("by_name", ["name"])
      .searchIndex("search_name", { searchField: "name" });

    expectTypeOf(confectOrganizationsTableDefinition).toEqualTypeOf(
      convexOrganizationsTableDefinition,
    );
    expect(convexOrganizationsTableDefinition).toStrictEqual(
      confectOrganizationsTableDefinition,
    );
  });

  it("supports a record of any", () => {
    const confectResultsTableDefinition = Table.tableDefinition(
      Table.make(() =>
        Schema.Struct({
          name: Schema.String,
          payload: Schema.Record(Schema.String, Schema.Any),
        }),
      ).index("by_name", ["name"])("results"),
    );

    const convexResultsTableDefinition = defineTable({
      name: v.string(),
      payload: v.record(v.string(), v.any()),
    }).index("by_name", ["name"]);

    expectTypeOf(confectResultsTableDefinition).toEqualTypeOf(
      convexResultsTableDefinition,
    );
    expect(convexResultsTableDefinition).toStrictEqual(
      confectResultsTableDefinition,
    );
  });

  it("supports indexes when a nested struct is assignable to its parent", () => {
    const confectSettingsTableDefinition = Table.tableDefinition(
      Table.make(() =>
        Schema.Struct({
          userId: Schema.String,
          sidebar: Schema.Struct({
            badge: Schema.String,
            rows: Schema.Struct({ badge: Schema.String }).pipe(
              Schema.Array,
              Schema.optionalKey,
            ),
          }),
        }),
      ).index("by_userId", ["userId"])("settings"),
    );

    const convexSettingsTableDefinition = defineTable({
      userId: v.string(),
      sidebar: v.object({
        badge: v.string(),
        rows: v.optional(v.array(v.object({ badge: v.string() }))),
      }),
    }).index("by_userId", ["userId"]);

    expectTypeOf(confectSettingsTableDefinition).toEqualTypeOf(
      convexSettingsTableDefinition,
    );
    expect(convexSettingsTableDefinition).toStrictEqual(
      confectSettingsTableDefinition,
    );
  });

  it("supports indexes on name fields when the schema includes optional bytes", () => {
    const confectImagesTableDefinition = Table.tableDefinition(
      Table.make(() =>
        Schema.Struct({
          name: Schema.String,
          bytes: Schema.optional(Schema.instanceOf(ArrayBuffer)),
        }),
      ).index("by_name", ["name"])("images"),
    );

    const convexImagesTableDefinition = defineTable({
      name: v.string(),
      bytes: v.optional(v.bytes()),
    }).index("by_name", ["name"]);

    expectTypeOf(confectImagesTableDefinition).toEqualTypeOf(
      convexImagesTableDefinition,
    );
    expect(convexImagesTableDefinition).toStrictEqual(
      confectImagesTableDefinition,
    );
  });

  describe("lazy compilation", () => {
    const makeInstrumented = () => {
      const calls = { count: 0 };
      const lazyFields = () => {
        calls.count += 1;
        return Schema.Struct({ text: Schema.String });
      };
      return { calls, lazyFields };
    };

    it("is `===`-stable and materialises all chained indexes/searchIndexes/vectorIndexes", () => {
      const notes = Table.make(() =>
        Schema.Struct({
          text: Schema.String,
          tag: Schema.optional(Schema.String),
          embedding: Schema.Finite.pipe(Schema.Array, Schema.optional),
        }),
      )
        .index("by_text", ["text"])
        .searchIndex("text", { searchField: "text", filterFields: ["tag"] })
        .vectorIndex("embedding", {
          vectorField: "embedding",
          dimensions: 4,
          filterFields: ["tag"],
        })("notes");

      const first = Table.tableDefinition(notes);
      const second = Table.tableDefinition(notes);
      expect(first).toBe(second);

      const expected = defineTable({
        text: v.string(),
        tag: v.optional(v.string()),
        embedding: v.optional(v.array(v.number())),
      })
        .index("by_text", ["text"])
        .searchIndex("text", { searchField: "text", filterFields: ["tag"] })
        .vectorIndex("embedding", {
          vectorField: "embedding",
          dimensions: 4,
          filterFields: ["tag"],
        });
      expect(first).toStrictEqual(expected);
    });

    it("forces `Fields` exactly once, even if `Fields` was already forced", () => {
      const { calls, lazyFields } = makeInstrumented();
      const notes = Table.make(lazyFields)("notes");
      void notes.Fields;
      void Table.tableDefinition(notes);
      void notes.Fields;
      void Table.tableDefinition(notes);
      expect(calls.count).toBe(1);
    });
  });
});

describe("Table.tableDefinition deploy checks", () => {
  const counted = (refusals: ReadonlyArray<string>) => {
    const runs = { checks: 0, fields: 0 };
    const unnamed = Table.make(() => {
      runs.fields++;
      return Schema.Struct({ text: Schema.String });
    }).deployCheck((table) => {
      runs.checks++;
      return Arr.map(refusals, (refusal) => `${table.tableName} ${refusal}`);
    });
    return { runs, unnamed };
  };

  /**
   * A schema wrap as a section that sets `wrapsSchema` writes one, as Frame's
   * tenancy does: each table's definition built through `tableDefinition`.
   */
  const wrap = (confect: Readonly<Record<string, Table.AnyWithProps>>) =>
    Rec.map(confect, (table) => Table.tableDefinition(table));

  it("throws TableRefused naming the table and each refusal, before it compiles the schema", () => {
    const { runs, unnamed } = counted(["is too wide", "is too deep"]);
    const notes = unnamed("notes");
    let thrown: unknown;
    try {
      Table.tableDefinition(notes);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Table.TableRefused);
    expect(thrown).toMatchObject({
      _tag: "TableRefused",
      tableName: "notes",
      refusals: ["notes is too wide", "notes is too deep"],
    });
    expect((thrown as Error).message).toBe(
      'Table "notes" is refused:\n- notes is too wide\n- notes is too deep',
    );
    expect(runs.fields).toBe(0);
    // A refusal is never cached: each build of the schema refuses again.
    expect(() => Table.tableDefinition(notes)).toThrow(Table.TableRefused);
    expect(runs.checks).toBe(2);
  });

  it("refuses a direct schema, as the generated convexSchema.ts builds it", () => {
    const notes = counted(["is refused"]).unnamed("notes");
    const tags = Table.make(() => Schema.Struct({ name: Schema.String }))(
      "tags",
    );
    expect(() =>
      defineSchema({
        tags: Table.tableDefinition(tags),
        notes: Table.tableDefinition(notes),
      }),
    ).toThrow('Table "notes" is refused: notes is refused');
  });

  it("refuses a schema a section wraps through tableDefinition", () => {
    const notes = counted(["is refused"]).unnamed("notes");
    expect(() => defineSchema(wrap({ notes }))).toThrow(
      'Table "notes" is refused: notes is refused',
    );
  });

  it("runs a passing table's checks once, and returns its definition again without them", () => {
    const { runs, unnamed } = counted([]);
    const notes = unnamed("notes");
    const first = Table.tableDefinition(notes);
    expect(Table.tableDefinition(notes)).toBe(first);
    expect(defineSchema(wrap({ notes })).tables.notes).toBe(first);
    expect(runs).toEqual({ checks: 1, fields: 1 });
    expect(first).toStrictEqual(defineTable({ text: v.string() }));
  });

  it("builds a table without checks as before", () => {
    const notes = Table.make(() => Schema.Struct({ text: Schema.String }))(
      "notes",
    );
    expect(Table.tableDefinition(notes)).toStrictEqual(
      defineTable({ text: v.string() }),
    );
  });
});

describe("Table.systemTablesForScope", () => {
  it("reuses system table definitions within a scope and keeps scopes separate", () => {
    const scope = IdScope.component("@example/system-tables");
    const tables = Table.systemTablesForScope(scope);
    expect(Table.systemTablesForScope(scope)).toBe(tables);
    expect(tables._storage.scope).toBe(scope);
    expect(tables._scheduled_functions.scope).toBe(scope);
    const other = Table.systemTablesForScope(IdScope.app);
    expect(other).not.toBe(tables);
    expect(other._storage.scope).toBe(IdScope.app);
    expect(GenericId.scope(tables._storage.Doc.fields._id.ast)).toBe(scope);
  });
});
