---
"@confect/cli": minor
---

Reject Node groups in `confect codegen --component-dir` and `confect dev --component-dir` with a diagnostic that names the group and the Convex restriction:

```text
Group "tasks" in tasks.spec.ts uses the Node runtime. Convex components do not support Node.js functions.
```

Application Node groups remain supported.
