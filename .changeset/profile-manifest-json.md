---
"@confect/cli": patch
---

Require profile manifest descriptions to be JSON data; `Map`, `Set` and class instances are refused rather than written as `{}`. Report typed diagnostics with the section, function, declaring spec and exact JSON path, including empty property names and cycles. Refuse own `__proto__` properties so generated object literals preserve section content and unchanged runs settle.
