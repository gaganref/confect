---
"@confect/core": minor
---

`Table.make(...).group("batchId")` names the id field that groups a table's rows, and rejects a field that is not a required id. `Component.contract` takes tables beside system table names and rejects a grouped table whose id is not one of the component's own tables; `Component.groups(contract)` reads each table's `{ key, table }`.
