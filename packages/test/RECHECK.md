# Kernel re-check record

Frame's backend testing design (Frame ADR 0012) puts its
simulation kernel in `@confect/test`. The design read the fork at fork.57. Its
kernel base is fork.77 or later plus fork PR #115, so build-order row 1 owes a
re-check of each part the kernel builds on. This file records what each part is
on fork `main` at `eabc7495`, before row 1's bridge. Line numbers refer to that
commit.

`main` at `eabc7495` is the source of the published `10.3.1-fork.85`. Its
`packages/server/src` is byte-identical to that tarball's `src`. `10.3.1-fork.84`
is `c7a5e8cb`. It carries #114 (component sections), #115 (`CommitTs`) and #116
(a component descriptor names its test kit). #119, the `TableInfo` extractor fix,
first ships in fork.85, because fork.84's `TableInfo.ts` differs from `main`'s.

## Findings

| Part                                                 | What the design assumed                                                                                       | What `main` has                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Verdict                                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `packages/server/src/RegisteredFunction.ts` near 372 | `runHandlerPromise` ends in `Effect.runPromise`, with root-context scheduler run options (comment at 250-261) | `runHandlerPromise` (`:262-393`) ends in `Effect.runPromise(…, runOptions)` at `:372`. The scheduler comment is at `:255-260`. Three handler bases call it: the query base (`RegisteredConvexFunction.ts:265`, with a sync `MixedScheduler` and `queryClock` pinned at `:263`), the mutation base (`RegisteredConvexFunction.ts:380`, sync `MixedScheduler`) and the action base (`RegisteredFunction.ts:476`, no scheduler option). Node actions share the action base.                                                                                                                      | Holds                                                                                                                      |
| `packages/test/src/TestConfect.ts`                   | The public API the kernel sits behind, `layer(app, registry)` and kit `register(t, name)`                     | `layer` has three overloads (`:370-392`): a generated `DeclaredApp`, an `App` with its registry, and a schema with modules. A kit is `register(t, name)` or `{ schema, modules }` (`ComponentKit`, `:313-323`; `registerKit`, `:330-346`). Each layer build calls `convexTest` once (`schemaLayer`, `:446-461`), so one layer is one world. `t.run` runs its effect with `Effect.runPromise` (`:196-216`) and never reaches `runHandlerPromise`.                                                                                                                                              | Holds                                                                                                                      |
| `packages/test/src/internal/MountedHttp.ts`          | How mounted HTTP routes reach a registered handler                                                            | A mounted component gets a reserved bridge module, `__confect_test_http` (`:93`). Its action loads the component's `http` module and calls the route's `invokeHttpAction` (`:139-190`). `fetch` calls that action through a `function://<componentPath>;__confect_test_http:invoke` reference (`:227-245`), one at a time (`:257-262`). A route handler then runs through `HttpRouter.toWebHandler` (`packages/server/src/HttpRouter.ts:245`), not `runHandlerPromise`.                                                                                                                       | Holds. The bridge reaches no HTTP route handler. That is the HTTP row's concern (row 6).                                   |
| `packages/core/src/Mount.ts`                         | Dispatchers call back through stored function handles (cited at lines 16-26)                                  | Lines 16-26 are the `Handle` and `ContractOf` types. `Mount.make` (`:236-283`) builds the mount's client from `componentsGeneric()`. `Mount.initCall` (`:384-401`) swaps each callback slot's host ref for a handle that `create` makes. At push, `MountInit.step` makes them with `Callback.create` (`packages/server/src/MountInit.ts:38-41`), which calls `createFunctionHandle` (`packages/server/src/Callback.ts:298-309`). The component stores the handle and calls back through it. The mock-backend suite runs that through the scheduler and the runner (`components.test.ts:768`). | Holds, with corrected lines                                                                                                |
| fork PR #115, `CommitTs`                             | `db.vars.commitTs` resolves at commit to a `bigint`                                                           | `CommitTs` is `bigint \| CommitTsPlaceholder` (`packages/core/src/CommitTs.ts:14-20`). The writer exposes Convex's `vars` (`packages/server/src/DatabaseWriter.ts:89-92`, `:369`). convex-test 0.0.65 resolves placeholders at commit (`index.ts:425`, `:955`, `:3540`). The fork.84 tarball ships `dist/CommitTs.js`, and its server declarations carry `vars.commitTs`.                                                                                                                                                                                                                     | Holds. Read from the package, so the design's inference is now confirmed.                                                  |
| `App.make({ kind: "component" })` and `init`         | The component profile's subject and the session's open order                                                  | `App.Kind` is `"app" \| "component"` (`packages/core/src/App.ts:35`). A component declares `kind` explicitly (`:80-87`). `init` is an internal Confect mutation on the descriptor (`packages/core/src/Component.ts:556-565`). A push runs it through `MountInit.mutation`, which starts with `Effect.runPromise` directly (`packages/server/src/MountInit.ts:63-79`), so the bridge does not reach it. `TestConfect.layer(app, registry)` registers each mount's kit (`TestConfect.ts:401-426`) and never runs `init`.                                                                        | Holds. The open order (modules, then `init`, then the seed) does not exist under `TestConfect` yet. Rows 2 and 9 build it. |
| Convex `^1.49` peer                                  | convex-test 0.0.65 sits on Convex 1.48.0; the second target must run on the new peer                          | The workspace overrides `convex` to 1.49.0 (`pnpm-workspace.yaml:70`), and `@confect/server` pins `convex-test` 0.0.65 (`packages/server/package.json:21`). `@confect/server` requires `convex ^1.49.0` (`packages/server/package.json:71`). `@confect/test` still declares `convex ^1.32.0` (`packages/test/package.json:54`) beside `convex-test >=0.0.65 <0.1.0`. convex-test 0.0.65 accepts `convex ^1.43.0` and was built against 1.48.0. Both packages resolve `convex` 1.49.0 here, and the `@confect/test` suite and the mock-backend suite pass on it.                               | Holds. `@confect/test`'s looser peer is effectively raised by its `@confect/server` peer.                                  |
| fork PR #116, a descriptor names its test kit        | Rows 9 and 11 read it before they build                                                                       | `DescriptorOptions.testing` names the kit's package specifier (`packages/core/src/Component.ts:568-579`). Codegen imports it only for a mount whose definition comes from another package, and checks that it resolves (`packages/cli/src/confect/codegen.ts:1196-1215`). A local mount ignores it.                                                                                                                                                                                                                                                                                           | Recorded for rows 9 and 11                                                                                                 |

The design's open question on async context in the edge-runtime project: no
Vitest project in this repository sets an edge-runtime environment
(`vitest.shared.ts`). Only `@confect/react` sets one, `happy-dom`. The bridge
runs under Node's `AsyncLocalStorage`, as convex-test's own stores do
(`index.ts:3`, `:158-160`).

No finding contradicts row 1 as written.

## Lane 1 inventory on `main`

Every mock-backend case is placed below. The design's line numbers for
`integration.test.ts` still hold. In `components.test.ts` each moved down one
line.

| Cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | First run in row       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Every case not named below: `actionCall.test.ts` (4), `declarationEmit.test.ts` (2), `middleware.test.ts` (20), `queryStream.test.ts` (37), `queryStreamDistinct.test.ts` (24), `reservedArgument.test.ts` (Node registration at `:61`, collisions at `:104`), `schedulerIsolation.test.ts` (2), the rest of `integration.test.ts` (Node action cases at `:254` and `:1423`, `OfficialComponent` at `:156`), and `components.test.ts:189`, `:250`, `:312`, `:338`, `:372`, `:447`, `:495` | 2                      |
| `integration.test.ts:360` `Scheduler`; `components.test.ts:408` job cancellation; `:768`, `:807`, `:819`, `:831`, the stored-handle cases                                                                                                                                                                                                                                                                                                                                                 | 5                      |
| `integration.test.ts:332` `TransactionMetadata`                                                                                                                                                                                                                                                                                                                                                                                                                                           | 6, limits              |
| `integration.test.ts:61` `Storage`                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 6, storage             |
| `components.test.ts:84` JWT verification against JWKS                                                                                                                                                                                                                                                                                                                                                                                                                                     | 6, JWT                 |
| `http.test.ts` (11); `components.test.ts:535` to `:737`, the mounted HTTP routes                                                                                                                                                                                                                                                                                                                                                                                                          | 6, HTTP, after storage |

Since fork.57, these suites are new: `actionCall`, `declarationEmit`, `middleware`,
`queryStream`, `queryStreamDistinct` and `schedulerIsolation`. None reads the
scheduler, transaction metadata, storage, identity or HTTP, so all of them run
in row 2. `schedulerIsolation.test.ts:60` and `:70`, `reservedArgument.test.ts:72`,
`integration.test.ts:146`, `:240` and `:318`, `components.test.ts:88` and `:193`,
and `http.test.ts:43` call `convexTest` directly. Row 2's alias shim must route
each of them.

## The bridge (row 1)

`src/internal/Invocation.ts` binds a test invocation with `bind(invocation, start)`.
The record holds the owning world, the component path, the attempt, request
metadata, the Effect services, a start time and a random stream. One store per
test runtime lives on `globalThis` under `Symbol.for("@confect/test/Invocation")`,
so every copy of the module that `vi.resetModules` reloads binds through the
store `runHandlerPromise` reads. When an invocation is bound, `runHandlerPromise`
starts the handler with `Effect.runPromiseWith(services)`. Otherwise it keeps
`Effect.runPromise`.

Before the handler starts, the bridge points its `Date`, `Math` and `crypto`
at the invocation. In a query or mutation, `Date.now()` and `new Date()` read
the invocation's start time through the whole run. In an action they read the
world's clock as it runs, so the action sees time move when the driver advances
that clock, as Convex lets an action's clock advance. `runHandlerPromise` tells
the bridge which kind of function it starts. `Math.random` and
`crypto.getRandomValues` draw from the stream. convex-test
0.0.65 gives every handler call its own copy of these globals, and an
assignment inside a handler lands in that copy only (its `dist/index.js:1744`,
`:1883-1905` and `:1927-1930`), so overlapping handlers and nested calls keep
their own. A bound handler that runs without such a copy would change these
globals for every caller. The bridge checks each assignment from the test's
own async context, puts back any that reached it, and refuses the handler
before it runs. Row 2's
kernel owns its globals and replaces this reliance. Effect's default `Clock`
and `Random` read these globals, so the kernel provides neither as a service,
and a door-built handler that strips `effect/Random` still draws from the
stream. A query keeps the query base's `queryClock`. Its effectful reads call
`Date.now()` and so read the start time, and its unsafe reads stay constant and
untracked. A query's or mutation's pinned start time replaces convex-test's
transaction time, which convex-test raises to the last commit. An action's
world clock replaces the host clock convex-test leaves an action. A document a
bound handler inserts takes its `_creationTime` from the pinned `Date.now()` (`:105-107`),
nudged up a microsecond past the previous one. Commit timestamps still come
from convex-test's own clock (`:2062-2069`) until row 3. `crypto.randomUUID` and `performance.now`
are not pinned, as the design names neither.

A call nested in the bound request joins its record at the callee's component
path, with its stream. A query or mutation nested in a query or mutation
shares its caller's start time. One an action calls is a transaction of its
own, so it starts at the world's clock reading when it begins and keeps that
time through its run. A job convex-test starts from a timer
inherits the async context of the handler that scheduled it. Convex gives it its
own `scheduledFunctionId`, so the bridge gives it a fresh record with the
world's services, a start time read from the world's clock, the world's stream
and the job's request metadata. The attempt is always 1 until row 3 adds
attempts. A nested action joins its caller's record too. The design gives it a
fresh one, which differs from the joined record only once an attempt can
differ, so it lands with row 3. The bridge does not reach HTTP route handlers,
`t.run` or mount `init`, as recorded above.
