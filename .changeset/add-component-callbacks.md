---
"@confect/core": minor
"@confect/server": minor
---

Add typed callbacks for components. A component declares a contract with `Callback.mutation`, `Callback.query`, or `Callback.action`, stores the host's handle using the `Callback.handle(contract)` schema, and runs it with `MutationRunner`, `QueryRunner`, `ActionRunner`, or `Scheduler`. Declared errors arrive by tag. A host creates the handle with `Callback.create` from `@confect/server`. Passing a function whose type, args or returns visibly differ from the contract on the wire, or whose errors are undeclared, is a type error. Before creating the handle, `Callback.create` checks the validators Convex compiles for the function against the contract.

In the component:

```ts
import { Callback } from "@confect/core";

export const OnEvent = Callback.mutation("email/onEvent", {
  args: () => ({ emailId: Schema.String, status: Status }),
  returns: () => Schema.Null,
  error: () => EventRejected,
});

// a table field (or function arg) that holds the handle
Schema.Struct({ to: Schema.String, onEvent: Callback.handle(OnEvent) });

// run the stored handle
Effect.gen(function* () {
  const runner = yield* MutationRunner;
  yield* runner
    .runMutation(email.onEvent, { emailId, status: "bounced" })
    .pipe(
      Effect.catchTag("EventRejected", (rejected) =>
        Effect.log(rejected.reason),
      ),
    );
});
```

In the host:

```ts
import { Callback } from "@confect/server";

Effect.gen(function* () {
  const runner = yield* MutationRunner;
  const onEvent = yield* Callback.create(OnEvent, refs.internal.emails.onEvent);
  yield* runner.runMutation(email.email.send, { to, onEvent });
});
```

When args or returns validators differ, or the host declares an error outside the contract's set, `Callback.create` fails with a `CallbackContractMismatch` whose message names the side and both validators, for example:

```text
The host function does not satisfy callback contract "email/onEvent": its args compile to {"kind":"object","fields":{"state":{"kind":"string"}}}, the contract's to {"kind":"object","fields":{"status":{"kind":"string"}}}.
```

Args and returns must compile to the same validators. The host's errors, including its middleware's errors, must all be declared by the contract, either the same schema or one compiling to the same validator. The host may declare fewer errors. An unsupported args or returns schema on either side fails the effect with a message naming the contract, the side and the unsupported schema type, such as `TemplateLiteral`. A plain Convex reference has no codecs to compile and is checked by its types only. Codecs that compile to the same validator, such as `Schema.DateFromString` and `Schema.DurationFromString` or two schemas that differ only in a refinement, are not told apart.

Generated references now carry the returns and error codecs their functions declare, so two references whose return or error schemas differ are no longer assignable to each other, even when both encode and decode the same types. References built directly from a function spec now include the errors of the function's middleware, as generated references already did.

`@confect/core` now requires `convex` 1.46.0 or later, the first release that exports `FunctionReference_future`, which `Callback.toFuture` returns.
