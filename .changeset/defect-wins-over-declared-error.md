---
"@confect/server": patch
---

Inspect the full handler cause before encoding a declared error so any defect takes precedence. When there is no defect, encode the first declared failure in cause order, ignoring other failures and interruptions. Preserve bare ConvexError defects and undeclared ConvexError failures. Keep complete causes and rendered diagnostics for other defects, interrupt-only or empty causes, and error-encoding failures.
