---
"@confect/core": minor
"@confect/server": minor
"@confect/cli": minor
"@confect/test": minor
---

Add component authoring with `confect codegen --component-dir` and `confect dev --component-dir`. Publish a component contract, bind it to installed instances with `Component.bind`, and call it with decoded arguments, results, and declared errors.

```ts
import { Component } from "@confect/core";
import counterContract from "@example/counter/confect";
import { components } from "./_generated/components";

export const counter = Component.bind(counterContract, components.counter);
```

Use `Component.id` and `Component.schema` in host schemas, `HttpRouter.forSchema` for component HTTP routes, and `TestConfect.registerComponent` in tests. Vanilla Convex callers can use the component's encoded API.

Invalid component definitions and database bindings report tagged errors with validation details.
