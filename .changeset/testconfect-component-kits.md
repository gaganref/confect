---
"@confect/test": minor
---

Add a `register` option to `TestConfect.layer` for component test kits and `httpMounts` for fetching a component's HTTP routes at their full mounted paths.

```ts
import { TestConfect } from "@confect/test";
import { register } from "@example/email/testing";
import * as Effect from "effect/Effect";
import schema from "./confect/_generated/schema";
import convexSchema from "./confect/_generated/convexSchema";

const modules = import.meta.glob("./convex/**/!(*.*.*)*.*s");

const layer = TestConfect.layer(schema, convexSchema, modules, {
  register: (registerComponent) => register(registerComponent, "email"),
  httpMounts: [{ componentPath: "email", httpPrefix: "/email" }],
});

const program = Effect.gen(function* () {
  const t = yield* TestConfect.TestConfect<typeof schema>();
  return yield* t.fetch("/email/webhook", { method: "POST" });
}).pipe(Effect.provide(layer));
```

Mounted HTTP requests use the selected component's database and mount-specific `CONVEX_SITE_URL`. Provide a fresh HTTP router loader when testing multiple mounts of the same component. Process environment and imported modules remain shared across tests.
