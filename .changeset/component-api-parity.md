---
"@confect/core": major
---

Breaking change. `Component.Api` now gives a host the call types Convex's generated `ComponentApi` gives. A Convex-typed spec's return is awaited instead of exposing the handler's `Promise`. Arrays and object fields in args and returns are mutable, as in Convex's types. A `Callback.handle(contract)` field is typed as Convex's `FunctionHandle_future` with the contract's encoded args and returns, so a host can no longer pass a plain string or a handle for other args.

`Callback.handle(contract)` now encodes to the new `Callback.EncodedHandle<contract>` type instead of `string`. `FunctionSpec.EncodedReturns` awaits a Convex-typed spec's return, as `FunctionSpec.Returns` already did. Runtime behaviour does not change.

Who is affected: code that decodes text it did not get from Convex as a handle, such as a placeholder or a test fixture, through `Schema.decodeEffect`, `Schema.decodeSync` or another typed decoder of a schema that holds `Callback.handle`. Code that passes a plain string into a callback-handle argument of a `Component.Api` ref is affected the same way. Handles from `Callback.create` or Convex's `createFunctionHandle` keep working.

The compile error looks like this:

```
error TS2345: Argument of type 'string' is not assignable to parameter of type 'EncodedHandle<...>'.
  Type 'string' is not assignable to type 'FunctionReference_future<...>'.
```

To migrate, decode such text with the unknown-input decoder, which runs the same code. For example, `Schema.decodeUnknownEffect(Callback.handle(OnEvent))("function://...")`. Pass a real handle where a `Component.Api` ref takes one.
