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
at the invocation. `Date.now()` and `new Date()` read the start time.
`Math.random` and `crypto.getRandomValues` draw from the stream. convex-test
0.0.65 gives every handler call its own copy of these globals, and an
assignment inside a handler lands in that copy only (its `dist/index.js:1744`,
`:1883-1905` and `:1927-1930`), so overlapping handlers and nested calls keep
their own. A bound handler that runs without such a copy would change these
globals for every caller. The bridge checks each assignment from the test's
own async context, puts back any that reached it, and refuses the handler
before it runs. The kernel gives each function call it starts such a copy
too, as recorded under row 3. Effect's default `Clock`
and `Random` read these globals, so the kernel provides neither as a service,
and a door-built handler that strips `effect/Random` still draws from the
stream. A query keeps the query base's `queryClock`. Its effectful reads call
`Date.now()` and so read the start time, and its unsafe reads stay constant and
untracked. The pinned start time replaces convex-test's transaction time,
which convex-test raises to the last commit. A document a bound handler
inserts takes its `_creationTime` from the pinned `Date.now()` (`:105-107`),
nudged up a microsecond past the previous one. Commit timestamps still come
from convex-test's own clock (`:2062-2069`) until row 3. `crypto.randomUUID` and `performance.now`
are not pinned, as the design names neither.

A call nested in the bound request joins its record at the callee's component
path, with its start time and stream. A job convex-test starts from a timer
inherits the async context of the handler that scheduled it. Convex gives it its
own `scheduledFunctionId`, so the bridge gives it a fresh record with the
world's services, a start time read from the world's clock, the world's stream
and the job's request metadata. Row 3 gives each mutation attempt its number and a
nested action a fresh record, as recorded below. The bridge does not reach HTTP route handlers,
`t.run` or mount `init`, as recorded above.

## Storage and attempts (row 2)

`src/internal/Kernel.ts` holds the committed state: rows per component path
and table, the latest version and commit timestamp, and the write log.
`Kernel.apply` is its only writer. It publishes one attempt's writes as one
version, across every component. `src/internal/Attempt.ts` is one frame of an
attempt: the committed state it started from, its caller's frame and its own
pending writes. Each nested mutation gets a frame of its own, which merges into
its caller's when it returns and is dropped when it fails. Only the invocation
that owns a frame writes to it, so a caller's write made while its nested
mutation is in flight survives that mutation's failure. `src/internal/Execution.ts` answers Convex's syscalls
for the function that made them and runs queries, mutations and actions. Its
query, range, pagination and validator rules come from convex-test 0.0.65
(`KernelValues.ts`, `KernelQuery.ts`, Apache-2.0, credited in each file). The
kernel adds a `record` validator check, of every key and value, and refuses a
validator kind it does not know rather than accepting it.

A function in a component runs with no identity, whoever called it, since
Convex gives a component no `ctx.auth` of its caller's. A nested call in the
host takes its parent's identity, even when that is none, and a test's caller
reaches only the function the test called.

Row 2 published one top-level mutation at a time. Row 3 replaced that with
read-set validation and held attempts. Scheduling, storage, HTTP, JWT signing
and transaction limits refuse with `KernelRowPending`, naming the row that
supplies them. Text and vector search refuse with `RequiresBinary`.

`src/internal/ConvexTest.ts` gives the kernel convex-test's `convexTest`
signature. `vitest.mock-backend.kernel.config.ts` in `@confect/server` aliases
`convex-test` to it, so `TestConfect` and every suite that calls `convexTest`
directly run on the kernel. A plugin refuses any import that resolves into the
installed convex-test package, and `kernelLane.ts` fails a case when another
backend installed `globalThis.Convex`. `test:mock-backend` runs the
convex-test lane and then this one.

### Placement changes

`test/mock-backend/kernelPlacement.ts` is the inventory above as data. Two
facts differ from it.

- `integration.test.ts:394`, "uses the canonical Doc decoder across database
  read paths", read through a text search beside its other read paths. The
  inventory places it in row 2. The search read is now its own case, "uses the
  canonical Doc decoder for a text search". The other nine read paths and the
  writer run on the kernel. The new case is placed `binary`, the lane's one
  permanent placement. The design sanctions it, since its kernel scope says
  text search is not simulated and is `RequiresBinary`, the exception lane 1
  allows for.
- At open the kernel loads the modules Convex's bundler would deploy, by the
  rule in `convex/src/bundler/index.ts` (1.49). It skips `_generated`,
  `schema.ts`, any file with more than one dot, dotfiles and nested component
  directories. The official Workflow kit registers its packages' own
  `*.test.ts` files, and importing those inside a running test fails, so
  loading every registered file would break that kit. `test/Kernel.test.ts`
  registers the real kit, `@convex-dev/workflow` 0.4.10 (Frame's pin), through
  its own `register`. All 27 deployable modules of Workflow, Workpool and Batch
  Worker load before the first handler runs, with no preload, and none of the
  kit's test files loads.

## Read sets, held attempts and lifetime (row 3)

An attempt records what it reads, in `src/internal/ReadSet.ts`'s terms. A read
of a document by ID records the ID, so a later commit that creates, changes or
deletes that document invalidates it. A query records an interval: its index's
fields with the `_creationTime` and `_id` tie-breakers, the index range
expression, a page's cursor as an exclusive start, and how far the query
examined, inclusive. `.first()` and `.take(n)` read only the rows they
examined, filtered rows included. An empty result reads the whole range, so an
insert into it conflicts. A page reads from its cursor up to its end cursor,
inclusive, and a page from the terminal cursor reads nothing, as the binary's
`IndexRange::new` cuts the interval (`index_range.rs:111-127`). Writes outside
what the page could hold leave it valid. A nested query reads into its
caller's attempt. A nested mutation that fails drops its writes and keeps its
reads. `count` reads the whole table.

`World.prepare` runs a top-level mutation to its commit point and holds it as
attempt 1. `World.apply` checks the attempt's reads against every commit since
its snapshot (`Kernel.conflict`). It answers one of four results:

- `applied`, with the version and the commit timestamp;
- `conflict`, with the one next attempt, which it ran against the latest
  commit and holds;
- `exhausted`, with `OptimisticConcurrencyControlFailure`, when attempt 5
  conflicts;
- `refused`, when the function failed. Nothing is published.

An attempt that wrote nothing publishes nothing, so it is not checked. The
kernel has no retry loop. The shim's convex-test `mutation` applies each
attempt as soon as it is prepared and prepares the next on a conflict, as the
binary retries. Top-level mutations no longer take turns, so concurrent calls
conflict and run again.

`Kernel.KernelRuntime` supplies the clock and commit timestamps. A commit takes
`runtime.commitTs(version)`. One no greater than the previous commit's is
refused with `CommitTsNotIncreasing`. A mutation that wrote nothing asks for
no timestamp. As on the binary, it is serialized at its snapshot and answers
the snapshot's commit timestamp (`committer.rs:1596-1600` and
`application_function_runner/mod.rs:1117-1122` in convex-backend 1.49.0).
convex-test 0.0.65 gives it a fresh one (`index.ts:3214-3231`). The kernel's
snapshot moves only with commits, so empty mutations with no commit between
them answer the same timestamp. The default runtime is the wall clock, bumped
by a nanosecond when it stands still. A test passes its own runtime as
`convexTest({ schema, modules, runtime })`, and two processes that replay one
history with it print the same bytes. ID allocation and randomness stay with
later rows.

A mutation's commit point is once its function has returned and a whole turn
of the event loop passes with no syscall of its attempt running or started. So
a write a detached fiber makes after the handler settled lands in the attempt,
as on the binary. A throwaway spike showed convex-test and row 2 both lose
that write when the fiber reads once or five times before writing. Past the
commit point the attempt is closed, and any syscall on it fails with
`ClosedAttempt` instead of writing to an attempt that is already held or
published. The drain waits on `node:timers/promises`, which fake timers leave
alone.

Each attempt's handler starts under the invocation bound when the mutation was
first called, with that attempt's number. A nested action starts under a fresh
record with its world's services, a start time read from its world's clock, its
world's stream and attempt 1, as the design gives actions and scheduled
functions. On convex-test, the second target, a nested action still
joins its caller's record, since convex-test runs no attempts. The record
carries no identity, so the design's "reset identity" does not reach it. The
kernel's identity rule is row 2's. The request-metadata row resets identity
only for scheduled calls.

Row 1's pins rely on each handler call having its own `Date`, `Math` and
`crypto`, and the kernel gave a handler none, so the bridge refused every
handler the kernel started under a bound invocation. `src/internal/Globals.ts`
gives each query, mutation and action the kernel starts its own copy, as
convex-test does, and a nested call starts from the test environment's. A
bound handler on the kernel then reads its invocation's start time and stream,
a nested action its world's, and test code keeps the host's. The kernel's
default wall clock reads the host's `Date`, never a handler's copy, so a
document a bound mutation inserts takes its `_creationTime` from the kernel's
clock, as every commit timestamp does. On convex-test it takes the pinned
start time, as recorded under row 1.

No inventory case is placed in row 3, and no refusal named row 3, so the lane's
placements are unchanged.
