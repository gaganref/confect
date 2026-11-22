---
"@confect/core": major
---

Breaking change. `Component.Api` now gives a host the call types Convex's generated `ComponentApi` gives. A Convex-typed spec's return is awaited instead of exposing the handler's `Promise`. Arrays and object fields in args and returns are mutable, as in Convex's types. An optional field, such as one declared with `Schema.optional`, does not admit `undefined`. A `Schema.Unknown` slot is `any`, as Convex types `v.any()`, where it was `{}` and refused `null`. A commit timestamp is `bigint | CommitTsPlaceholder`, a record keyed by an ID is keyed by `string`, and a tuple is an array of the elements its validator keeps. A `Callback.handle(contract)` field is typed as Convex's `FunctionHandle_future` with the contract's args and returns in the same wire form, so a host can no longer pass a plain string or a handle for other args.

`Callback.handle(contract)` now encodes to the new `Callback.EncodedHandle<contract>` type instead of `string`. `FunctionSpec.EncodedReturns` awaits a Convex-typed spec's return, as `FunctionSpec.Returns` already did. Runtime behaviour does not change. Handles from `Callback.create` or Convex's `createFunctionHandle` keep working, including for contracts whose args or returns hold arrays, nested objects, IDs, optional fields, bigints or bytes.

Who is affected, and how to migrate:

- Code that decodes text it did not get from Convex as a handle, such as a placeholder or a test fixture, through `Schema.decodeEffect`, `Schema.decodeSync` or another typed decoder of a schema that holds `Callback.handle`. Decode such text with the unknown-input decoder, which runs the same code. For example, `Schema.decodeUnknownEffect(Callback.handle(OnEvent))("function://...")`.
- Code that passes a plain string into a callback-handle argument of a `Component.Api` ref. Pass a real handle, from `Callback.create` or `createFunctionHandle`.
- Code that passes a `ReadonlyArray` into an array argument of a `Component.Api` ref. Convex's `ComponentApi` refuses it too. Copy it, as in `{ items: [...items] }`.
- Code that passes `undefined` for an optional field of a `Component.Api` ref, as in `{ note: undefined }`. Convex's `ComponentApi` refuses it too. Leave the key out, as in `{ ...(note === undefined ? {} : { note }) }`.
- Code that passes a tuple with a rest element, such as `[string, ...number[]]`, to a `Component.Api` ref. Its validator keeps only the leading elements, so Convex refuses the rest at runtime and its type refuses them too. Pass only values the validator accepts.
- Code that hand-writes a value typed `Component.Api`, or passes one to `Component.bind`, with `string` in a callback-handle slot. Type the slot as Convex's codegen prints it, `FunctionHandle_future<"mutation", Args, Returns>` with the contract's encoded args and returns. A `ComponentApi` that Convex generated already does.
  Three differences from Convex's type are deliberate:

- A host that calls a function whose spec reserves an argument cannot pass that argument through `Component.Api`, although Convex's type lists it as `context?: any`. The reserved argument is not a domain argument. Confect's runners and scheduler fill it from `RegisteredFunction.Forward` after encoding the domain args, so a host sends context by providing `Forward`, not by passing the value.
- A query without a returns validator, which Convex types as returning `any`, keeps its handler's declared return.
- A recursive schema, which lowers to `v.any()` together with every object, array or union that holds it, keeps its declared type where Convex says `any`. The component's decoder enforces that type, so a call Convex's type accepts but the declared type refuses fails at runtime anyway.

The compile error for a plain string looks like this:

```
error TS2345: Argument of type 'string' is not assignable to parameter of type 'EncodedHandle<...>'.
  Type 'string' is not assignable to type 'FunctionReference_future<...>'.
```
