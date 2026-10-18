---
"@confect/core": minor
"@confect/cli": minor
---

Add a literal `kind` to `App.make` declarations and reject component declarations in `Auth.make`. Component authors must pass `App.make({ kind: "component", env, mounts })`; the default remains `"app"`. Codegen rejects declarations whose kind differs from its target directory.

Check callback contracts exported from a component's `confect/callbacks.ts` during codegen. Each id must start with the name passed to `defineComponent`, followed by `/`. Components without that file and host applications are unaffected.
