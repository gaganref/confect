---
"@confect/core": minor
"@confect/cli": minor
---

Add the backend declaration: describe a backend in `confect/env.ts`, `app.ts`, `auth.ts` and `http.ts`, and `confect codegen` and `confect dev` write `convex/convex.config.ts`, `convex/auth.config.ts`, `convex/http.ts` and an import-free `confect/_generated/manifest.ts` from it. It applies only when `confect/app.ts` exists; without it, nothing changes.

```ts
// confect/env.ts
import { Env } from "@confect/core";

export default Env.make("tenant", {
  EMAIL_FROM: Env.string(),
  RESEND_API_KEY: Env.secret(),
  PLATFORM_URL: Env.optional(Env.string()),
});

// confect/app.ts
import { App } from "@confect/core";
import email from "@acme/email/convex.config.js";
import env from "./env";

export default App.make({
  env,
  mounts: {
    email: App.mount(email, {
      httpPrefix: "/email",
      env: { FROM: env.EMAIL_FROM, RESEND_API_KEY: env.RESEND_API_KEY },
    }),
  },
});

// confect/auth.ts
import { Auth } from "@confect/core";
import app from "./app";

export default Auth.make(app, {
  providers: [{ domain: "https://login.example.edu", applicationID: "tenant" }],
});

// confect/http.ts
import { Http } from "@confect/core";
import { TenantApi, TenantHandlers } from "./api";

export default Http.make({ api: TenantApi, handlers: TenantHandlers });
```

Each `Env` entry is an Effect `Config`, so a handler reads `yield* env.RESEND_API_KEY` as `Redacted<string>`. `App.mount` types each mount's env against the component's own `defineComponent({ env })`, and `Manifest.Values<typeof manifest>` types the values a deployment supplies. `Auth.siteUrl` stands in for the deployment's site URL in a provider.

Codegen reports a `convex.config.ts` or `auth.config.ts` it did not write ("Found a hand-written … `confect codegen` writes it from … now"), an app route under a mount's HTTP prefix, a duplicate route, and overlapping mount prefixes. `confect codegen --component-dir` also accepts a Confect-authored component that declares itself with `env.ts` and `app.ts`, and writes its `defineComponent`.

`@confect/core` now requires `convex` 1.39.0 or later, the first release whose component definitions declare their environment.
