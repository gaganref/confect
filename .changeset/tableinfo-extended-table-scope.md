---
"@confect/server": patch
---

Fix document IDs for a table type that is not exactly `Table`, such as an intersection with a `Table` or an interface that extends one. `TableInfo` now reads the table name and ID scope through `Table.Name` and `Table.Scope`, so a reader's `doc._id` keeps the table's own scope and matches `DataModel.Id`. Before, those IDs came back with a widened scope and a widened table name.
