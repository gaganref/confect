import { IdScope, Table } from "@confect/core";
import type { GenericId } from "@confect/core";
import { DatabaseSchema } from "@confect/server";
import type { DatabaseReader, TableInfo } from "@confect/server";
import { describe, expectTypeOf, it } from "@effect/vitest";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const scope = IdScope.component("@example/entries");
const entries = Table.make(() =>
  Schema.Struct({ batchId: Schema.String }),
).index("by_batch", ["batchId"])("entries", scope);

type EntryId = GenericId.GenericId<"entries", typeof scope>;

const intersected = Object.assign(entries, {
  extra: { kind: "aggregated" as const },
});

interface Derived extends Table.Table<
  "entries",
  Table.TableSchema<typeof entries>,
  Table.TableValidator<typeof entries>,
  Table.Indexes<typeof entries>,
  Table.SearchIndexes<typeof entries>,
  Table.VectorIndexes<typeof entries>,
  typeof scope
> {
  readonly extra: { readonly kind: "aggregated" };
}

type Resolved<Table_ extends Table.AnyWithProps> = [
  TableInfo.TableInfo<Table_>["document"]["_id"],
  TableInfo.TableInfo<Table_>["encodedDocument"]["_id"],
  TableInfo.TableInfo<Table_>["convexDocument"]["_id"],
  keyof TableInfo.TableInfo<Table_>["indexes"],
];

type Expected = [
  EntryId,
  EntryId,
  EntryId,
  "by_batch" | "by_creation_time" | "by_id",
];

describe("TableInfo", () => {
  it("keeps the name and component scope of a table intersected with extra fields", () => {
    expectTypeOf<Resolved<typeof intersected>>().toEqualTypeOf<Expected>();
  });

  it("keeps the name and component scope of an interface that extends a table", () => {
    expectTypeOf<Resolved<Derived>>().toEqualTypeOf<Expected>();
  });

  it("types a reader's document id with the table's component scope", () => {
    const schema = DatabaseSchema.make(
      { entries: intersected },
      { kind: "component", scope },
    );
    const check = (
      reader: DatabaseReader.DatabaseReaderService<typeof schema>,
      id: EntryId,
    ) => {
      const doc = reader.table("entries").get(id);
      expectTypeOf<
        Effect.Success<typeof doc>["_id"]
      >().toEqualTypeOf<EntryId>();
    };
    void check;
  });
});
