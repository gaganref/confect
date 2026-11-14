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
`crypto.getRandomValues` draw from the stream. `getRandomValues` lets the host
check its receiver and argument first, so a detached call throws the host's
`TypeError`, as it does in production. convex-test
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
its caller's when it returns and is dropped when it fails. `src/internal/Execution.ts` answers Convex's syscalls
for the function that made them and runs queries, mutations and actions.

A query's or mutation's async syscalls, nested calls included, run one at a
time in the order the function made them. Convex 1.49 does the same:
`start_async_syscall` pushes each onto a queue, and `run_inner` runs the queue
oldest first, awaiting each batch before it re-enters JavaScript
(`crates/isolate/src/environment/udf/mod.rs:367-379`, `:1157-1231`). Only
gets, stream reads and storage reads batch, so a write and a nested call each
run alone (`async_syscall.rs:275-300`). A nested call takes the transaction,
runs its function to the end, commits or rolls back its subtransaction and
then gives the transaction back (`phase.rs:357-363`, `async_syscall.rs:703-776`).
So a caller's write issued after its nested mutation runs after that mutation
and wins on the same field, a nested call sees every write issued before it,
and a caller's write issued beside a failing nested mutation survives its
rollback. A query stream reads at its first `queryStreamNext`, which waits in
the queue, so it sees each write issued before it. A function's invocation
ends once its handler returned and its queue is empty, as `run_inner` keeps
running the queue after the promise resolves. An action's calls run side by
side, as they do on Convex. Its
query, range, pagination and validator rules come from convex-test 0.0.65
(`KernelValues.ts`, `KernelQuery.ts`, Apache-2.0, credited in each file). The
kernel adds a `record` validator check, of every key and value, and refuses a
validator kind it does not know rather than accepting it.

A nested call takes its caller's identity, even when that is none, and a
test's caller reaches only the function the test called. Row 2 also gave every
function in a component no identity. The component identity row (below)
replaced that with the binary's rule: a component a query or a mutation calls
sees the caller, and one an action calls sees none.

Row 2 published one top-level mutation at a time. Row 3 replaced that with
read-set validation and held attempts. Scheduling, storage, HTTP, JWT signing
and transaction limits refuse with `KernelRowPending`, naming the row that
supplies them. Row 5 lifts the scheduling refusals, the limits row the
transaction limits refusal, and row 6's storage metadata and HTTP rows the
storage and HTTP refusals. Text and vector search, and storage uploads and
downloads, refuse with `RequiresBinary`.

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
check, the publication and the version `applied` reports run in one synchronous
turn, so two attempts applied together cannot both pass the check, and a job's
state commit cannot land between them. The
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

A nested mutation's frame has the same lifetime. It ends once its function has
returned and its own syscalls have drained, then closes and merges into its
caller's frame, so a detached fiber's write made after the nested handler
settled merges with it. Convex 1.49 runs a nested function through the same
`run_inner` loop as a top-level one (`execute_nested_udf` and `run_nested` in
`crates/isolate/src/environment/udf/mod.rs:546-600`). The loop ends only when
its promise settled and its syscall queue is empty (`:1125-1270`), and only
then does the caller commit the subtransaction (`async_syscall.rs:703-776`).
A syscall that reaches a closed nested frame fails with `ClosedAttempt`. Each
frame shares its attempt's reads but has its own lifetime, since a nested call
is a syscall of its caller until it ends, and a shared count would wait on
itself. A failed nested mutation closes at once and is dropped, as the binary
stops a function at its rejection.

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
bound handler on the kernel then reads its invocation's stream, a nested action
its world's, and test code keeps the host's. The start time it reads is the
kernel's, as recorded under rows 4 and 5. The kernel's
default wall clock reads the host's `Date`, never a handler's copy, so a
document a bound mutation inserts takes its `_creationTime` from the kernel's
clock, as every commit timestamp does. On convex-test it takes the pinned
start time, as recorded under row 1.

No inventory case is placed in row 3, and no refusal named row 3, so the lane's
placements are unchanged.

## Subscriptions (row 4)

`src/internal/Subscriptions.ts` keeps each client's query set. A `Subscriber`
holds one caller and an identity version. Each subscription keeps its latest
run: the value, the commit it read, its read set, whether it asked for the
caller's identity, the pinned time it read and where its paginated read ended.

A run is stale when a commit since its snapshot changed something it read,
which is the check `apply` makes for an attempt (`Kernel.conflict`). It is also
stale when it read the identity and `authenticate` has since bumped its
subscriber's identity version. `refresh` reruns the stale runs at the latest
commit and the kernel's time, oldest first, until none is stale. It lists each
value that changed. `reference` is the full-rerun reference: it reruns every
subscription from scratch and lists each one whose value differs. Two failures
show the same thing when their errors share a name, message and data, or when
they threw equal bare values of the same type, so a query that throws `"a"`
and then `"b"` changes.

Three rules come from the binary's source and docs (Convex 1.49), not from
convex-test, which has no subscriptions:

- Time never makes a run stale. "The query is not re-run when `Date.now()`
  changes" (`docs/understanding/best-practices/best-practices.mdx:571`). The
  sync worker reruns a query only when its read set or the identity changes
  (`crates/sync/src/worker.rs:948-962`). The binary's time dependency is its
  query cache, which reuses a result that read the time only within
  `MAX_CACHE_AGE` (`crates/application/src/cache/mod.rs:795-820`). The kernel
  has no cache, so a rerun always reads the kernel's time now. The reference
  reruns a query that read the time at the time its run read, and again at the
  kernel's time now when that rerun's own reads show a rerun was owed: a commit
  since the run changed something it read, or it read an identity that has
  changed. It reads neither the run's recorded reads nor `invalidation`, so a
  missed invalidation disagrees even when the query's value is only the time.
- An identity change makes stale only the runs that read the identity, as the
  design says. The binary reruns every query of the session and leaves the
  narrower rule as a TODO, CX-737 (`crates/sync/src/worker.rs:953-962`). The
  two differ only for a query that read the time but not the identity, once
  its cached result is older than the cache window.
- A rerun ends its page where the first run's page ended, as the binary's query
  journal does (`crates/isolate/src/environment/udf/async_syscall.rs:2263-2266`
  and `:2324`). So an insert inside the page grows it.

`Date` inside a query or mutation answers its start time, and a query that
reads it records that time. The wrapper, `src/internal/Clock.ts`, is the same
file as row 5's, byte for byte: a time dependency needs the pinned query clock
that row 5's scheduler also needs.

Inside a bound handler, row 1's pin of the invocation's start time would hide
the wrapper. A bound query would then read that start time, and its read would
go unrecorded, so a subscription would lose its time dependency. So when the
realm's `Date` is the kernel's wrapper and a kernel invocation is running, the
bridge leaves `Date` to it and pins only `Math` and `crypto`
(`Clock.answersInvocation`, row 5's rule too). A bound handler on the kernel
reads the kernel's clock as an unbound one does, and a bound query's read of it
is recorded. A bound action reads the running clock, and a query or mutation it
calls starts at the kernel's time when it is called, the kernel's form of row
1's rule. A record's own start time and its world's clock apply only on
convex-test.

A kernel subscription's reruns reach Convex's server library through the same
`globalThis.Convex` dispatcher and pinned-global accessors that a live
convex-test layer uses (row 5's `TestConfect` target). Beside such a layer it
ignores the other target's commits, reruns on a kernel commit to what it read,
agrees with the reference, and leaves each accessor as it found it
(`test/TestConfectTargets.test.ts`). `TestConfect` itself has no subscription
surface yet, so a test opens subscriptions on the kernel's `convexTest` shim.

No inventory case is placed in row 4, and no refusal named row 4, so the lane's
placements are unchanged.

## Scheduler, crons, handles and workflow events (row 5)

`src/internal/Scheduling.ts` is the job model. A job is a row in its
component's `_scheduled_functions` table with the fields Convex's system table
has. Beside it the kernel keeps the job's target, which a stored handle may put
in another component, whether the job is standing, and the world of the
invocation bound when it was scheduled. `1.0/schedule` writes
the row through the scheduling attempt, so a job exists only once that mutation
commits. `1.0/actions/schedule` and `1.0/actions/cancel_job` commit at once.
A stored handle passes a `v.function()` validator, which row 2's refusal of an
unknown kind turned away. The pinned binary,
`precompiled-2026-10-28-cccbade`, accepts a string that parses as a function
handle (`common/src/schemas/validator.rs:156-164`). Its parser strips the
`function://` prefix and parses the rest as a document id, with an optional
`#` function name (`common/src/bootstrap_model/components/handles.rs:100-112`).
The kernel mints convex-test's format instead, `function://<component>;<path>`,
so it accepts a string that parses as that: one `;` and a function path after
it. It refuses `function://` and `function://not-a-valid-handle`, which the
binary refuses too.
Cancel marks a pending or running job `canceled`, and a canceled job never
starts.

The kernel's clock is the runtime's time, never earlier than the latest
deadline it advanced to (`World.now`). `advance(ms)` runs every job due in the
window in deadline order, jobs those jobs schedule included, and moves the
clock to each deadline as the job starts. `finishInProgressScheduledFunctions`
is `advance(0)`, so it crosses no future deadline. A job runs as its own
request: no identity, no IP or user agent, a fresh request ID and its job ID
as `scheduledFunctionId`. It starts under a fresh record of the world that
scheduled it, with that world's services and attempt 1, whatever the drain is
bound to. A job scheduled with no invocation bound starts unbound, so its
handler keeps the production runtime. On convex-test a job inherits its
scheduler's async context through the host timer, which gives the same records
(row 1). The kernel has no timer to carry that context, so it keeps the world
beside the job. A job's row goes from `pending` through
`inProgress` to `success` or `failed`, in separate commits as in convex-test.

Convex 1.49's `runAfter` computes the job's time from `Date.now()` inside the
handler (`convex/src/server/impl/scheduler_impl.ts:99`). So `src/internal/Clock.ts`
wraps the realm's `Date`, which then answers a query's or mutation's start time
inside it, the running clock inside an action, and the host's time elsewhere.
A test that fakes `Date` replaces the wrapper while its fake is installed, so
handlers then read the fake. The default wall-clock runtime reads the host
`Date`, the fake one included, which is how a suite that steps fake timers and
calls `finishInProgressScheduledFunctions` moves the kernel's clock. A
document's `_creationTime` is its invocation's start time, bumped past the
previous one.

Inside a bound handler, row 1's pin of the invocation's start time would hide
the wrapper. A mutation bound with a start time of its own would then schedule
a job at that time plus its delay, not on the kernel's clock. So when the
realm's `Date` is the kernel's wrapper and a kernel invocation is running, the
bridge leaves `Date` to it and pins only `Math` and `crypto`
(`Clock.answersInvocation`). A bound handler on the kernel reads the kernel's
clock as an unbound one does, an action's running clock included, and draws
from its invocation's stream. A query or mutation a bound action calls starts
at the kernel's time when it is called, the kernel's form of row 1's rule. A record's own start time and its world's clock
apply only on convex-test.

`finishAllScheduledFunctions` runs non-standing jobs, earliest first, each at
its deadline, until only standing jobs are pending. It does not call
`advanceTimers`. Every job counts against a budget of 100, convex-test's
default, and running out fails with `DrainBudgetExceeded`, naming what is left.
`registerComponent(path, schema, modules, { standing })` names the functions
that schedule their own next run, as `module:export`. A job is standing when it
runs one of them or one of them scheduled it. The crons component's
`public:rescheduler` schedules both its target and its next run, so both are
standing. A standing job runs only when `advance` reaches its deadline. A name
the component does not export is refused at open with `UnknownStandingSource`.

Open: no committed test runs the official crons or Workflow kits, or their
suites, on the kernel. `Scheduling.test.ts` covers the same behaviour with
hand-built beat and workflow components. A throwaway spike outside this
repository, which nothing here reproduces, ran the official kits at Frame's pins
(`@convex-dev/crons` 0.2.3, `@convex-dev/workflow` 0.4.10 with workpool 0.4.14)
on the kernel. With
`public:rescheduler` declared, the drain ended with the rescheduler pending and
two one-second `advance` calls ran the target at +1000 and +2000. Without the
entry the drain failed `DrainBudgetExceeded` naming `crons` `public:rescheduler`.
A workflow that awaits an event was `inProgress` on its event step after the
drain with no job pending, and completed with the event's value once
`sendEvent` ran and the drain finished.

The lint override for `packages/test/src/internal/**` refuses `node:timers`,
`timers` and their `promises` imports, and the global `setTimeout`,
`setInterval`, `setImmediate` and their clears. The one exception is the
attempt drain's event-loop turn in `Attempt.ts`, row 3's, which is no deadline.

The six row-5 cases now run in the kernel lane: `integration.test.ts:360`
`Scheduler`, `components.test.ts:408` job cancellation, and the stored-handle
cases at `:768`, `:807`, `:819` and `:831`.

Declared cron jobs (`src/internal/Crons.ts`) are simulated as standing
sources, pinned to convex-backend `precompiled-2026-10-28-cccbade`, the binary
the fork's local backend runs. When the backend opens, the kernel reads each
component's `crons` module as the push reads `crons.js`
(`crates/model/src/cron_jobs/mod.rs:151-223`). It refuses with `InvalidCron`
what the push refuses: a default export that is no `Crons` object
(`crates/isolate/src/environment/analyze.rs:1016-1048`), a schedule
`CronSpec::from_exported_json` rejects (`crates/model/src/cron_jobs/types.rs:270-478`),
a name with a character that is not printable ASCII (`types.rs:156-166`), and a
target that is missing, a query or an HTTP action
(`crates/application/src/application_function_runner/mod.rs:1932-1979`). Jobs
are created in name order, each with its first run computed from the kernel's
time at open.

Each run's time is `compute_next_ts` (`crates/model/src/cron_jobs/next_ts.rs:129-189`).
An interval's first run is due at once, and each later one an interval after the
previous run's time, not its finish. A clock schedule's run is saffron's next
occurrence strictly after the minute holding `now` less the previous run's
delay, plus the next run's delay. The delay (`cron_splay`, `next_ts.rs:56-127`)
is a whole number of seconds below `CRON_SPLAY_SECONDS`, 60 by default
(`crates/common/src/knobs.rs:620-621`), for a pinned minute or a cron
expression, and below 3600 when `minuteUTC` is left out. A first run counts its
fresh delay as already in effect, so it can land in the current minute or hour.
Later runs carry the delay through the previous run's timestamp, and draw again
only when it was 0. The kernel holds no generator: the delay draws from the
random stream of the world bound by the call that opened the backend, the stream
that world's handlers draw from (row 1). With no invocation bound, it draws from
the world the driver gave the backend (`convexTest`'s `world` option). `advance`
and `drain` open with the driver's world. `TestConfect.layer`'s kernel target is
such a driver: its world's stream is mulberry32 seeded by the layer's `seed`,
`0` by default, so two runs with one seed replay the same delays. A backend with
neither world has nothing to draw from, so it refuses a clock schedule with
`CronRandomUnavailable`. An interval never draws. When `now` is no later than the
previous delay, the binary's checked subtraction fails and the search starts at
`now` itself (`next_ts.rs:180`, `Timestamp::sub` at
`crates/convex/sync_types/src/timestamp.rs:72-78`), so an epoch clock with a 15 s
delay first runs at 75 s, not 15 s. When a run finishes, the next is
computed from that time, and every run already past is skipped
(`complete_job_run`, `crates/application/src/cron_jobs/mod.rs:852-965`).

Cron expressions follow saffron at the rev the binary pins
(`convex/saffron@1d842379`): five fields split by spaces or tabs, numbers,
three-letter month and weekday names in any case, `*`, ranges, steps and lists,
weekdays 0-6 from Sunday, a lone `L` for Saturday, and a day of the month and a
weekday that are both restricted matching either (`saffron/src/lib.rs:975-1003`).
saffron's quirks are kept: a wrapping range such as `22-2` starts one value
early, at 21 (`lib.rs:393-407`), and a wrapping step reads its bounds off by one
for days, months and weekdays (`lib.rs:418-425`). The binary refuses a pattern
saffron's `any` says never matches (`types.rs:453-459`).

The search is a line-by-line port of saffron's `next_after` (`lib.rs:1134-1436`),
not a scan for matching minutes. The first day is tested with `contains_date`
(`lib.rs:623-678` for the day of the month, `:153-173` for the weekday, `:992-1003`
for both), and every later day is found by `find_next_day_of_month`
(`:1253-1310`) or `find_next_weekday` (`:1314-1387`). The two can disagree for
the `L` and `W` forms, and the port keeps both. `L` is the last day, `L-n` n days
before it, `LW` and `L-nW` the nearest weekday to those, `nW` the nearest weekday
to day n within the month, `nL` the month's last weekday n, and `n#k` its k-th
weekday n. A month without the day has no run. One case cannot be simulated: an
`L-nW` test on a Monday computes `day + n - days_in_month` in `u32` (`:663`), and
below zero that underflows. convex-backend builds with `overflow-checks = true`
and `panic = "abort"` (`Cargo.toml:271-274`), so the binary process aborts. The
kernel refuses with `CronAbortsBinary` instead. A differential harness built
without overflow checks would wrap there and answer no match.

A cron run is a system request: no identity, no IP or user agent, a fresh
request ID and no scheduled function ID (`cron_jobs/mod.rs:441-446`,
`crates/common/src/types/functions.rs:236-242`). It starts as a fresh
invocation of the world bound by the call that opened the backend, or unbound.
`advance` and `drain` open the backend with no world, as their binding never
reaches a job. A mutation's writes, jobs it schedules included, publish only if
it commits. A failed run still schedules the next (`cron_jobs/mod.rs:585-619`).
The binary keeps the job in `_cron_jobs` and `_cron_next_run`, which no function
reads, so the kernel keeps it beside its tables, and `crons()` lists each job's
next run and how its latest run ended.

`advance` runs cron runs and jobs in time order, each at its time. The binary
runs them on separate executors, so at one instant it orders neither first. The
kernel runs jobs first, then cron runs by component and name. A cron run never
counts against the budget, since each moves its job's next run later. A drain
never runs a cron run. The design asks that the crons door's suite pass on both
targets with the plain drain; that suite lives in Frame and is not run here.

A raw host timer in a handler is row 6's I/O ban.

`TestConfect.layer`'s `target: "kernel"` builds the layer's backend on this
shim, in each of the layer's three forms, so a consumer reaches the kernel
without importing `@confect/test/internal/*`, which stays unexported. A
throwaway rerun of the crons spike through that option, with Frame's crons
suite's fake-timer step, ticked at +1000 and +2000 with `public:rescheduler`
standing and failed `DrainBudgetExceeded` without it.

Both targets reach Convex's server library through the one `globalThis.Convex`.
convex-test assigns its own the first time it builds a world, so before this fix
whichever target was built last answered every syscall, and a live layer on the
other target failed its next one. The kernel now keeps the global as an accessor
that always reads its dispatcher. A syscall inside a kernel function goes to the
kernel, and any other to the backend that convex-test assigned. Nothing is
restored when a layer ends. `test/TestConfectTargets.test.ts` resumes a live
layer of each target beside and after a layer of the other, and holds a kernel
function between two syscalls while convex-test makes its first assignment.

Both targets also give each function call its own `Date`, `Math` and `crypto`
through accessors on `globalThis`, and convex-test installs its own again
whenever another is on top (`dist/index.js:1854-1866`). Row 3's
`src/internal/Globals.ts` did the same, so with both layers live each call
wrapped the other's accessor once more and every read of these globals went
deeper. The kernel now leaves an accessor in place when it already reads
through one of the kernel's, which a sentinel in a fresh copy shows, and the
chain settles after the first call on each target.

## Storage metadata (row 6)

`src/internal/Storage.ts` is the file model. A file is a row in its
component's `_storage` table, read and written through the attempt like any
document, so a mutation's file exists only once it commits, a rolled-back one
never does, and `getUrl`, `getMetadata` and `get` join the read set. An
action's store and delete commit at once, and its reads see the latest commit.
Beside the row the kernel keeps the bytes and a storage UUID; the row holds
only what the binary's virtual table shows.

Pinned against convex-backend `precompiled-2026-10-28-cccbade`, the local
backend's version:

- The row is `{ _id, _creationTime, sha256, size, contentType }`
  (`FileStorageDocMapper`, `crates/model/src/file_storage/virtual_table.rs`).
  `sha256` is the base64 SHA-256 with padding (`Sha256Digest::as_base64`,
  `crates/value/src/sha256.rs:24`). `contentType` is `null` when the file has
  none, though the npm package's `_storage` schema declares it optional. An
  empty content type is none (`crates/isolate/src/ops/storage.rs:29`).
- `getMetadata` answers `{ storageId, sha256, size, contentType }` with a hex
  digest and the storage UUID (`storage_get_metadata`,
  `crates/isolate/src/environment/udf/async_syscall.rs:1365-1405`).
- `getUrl` answers `<origin>/api/storage/<uuid>`, with `?component=<id>`
  outside the root (`FileStorage::get_url_batch`,
  `crates/file_storage/src/core.rs:158-206`). The kernel's origin is
  `https://kernel.convex.cloud` and its component ID is the path.
- A declared digest that differs fails `Sha256 mismatch. Expected: … Actual: …`
  before the row is written (`FileStorage::upload_file`, `core.rs:395-419`).
- `delete` of a missing file fails `storage id … not found`
  (`FileStorage::delete`, `core.rs:209-221`).
- A storage ID of another table, or a string that is neither an ID nor a UUID,
  is refused as an argument (`FileStorageId::from_str` and
  `query_for_storage_id`, `crates/model/src/file_storage/mod.rs:126-143`,
  `:244-279`). A file's storage UUID still names it.

`packages/server/test/local-backend/storage.test.ts` checks the row, metadata,
URL, null content type, digest mismatch and delete answers for one stored blob
on the binary, and `test/Storage.test.ts` checks the same answers on the
kernel. The binary's `null` content type was the one answer the source left
open; the local-backend run settled it.

Not simulated: upload streaming, signed upload tokens and durability. An upload
URL has the binary's shape with an unsigned token, and the kernel's `fetch`
refuses an upload to it or a download from a file URL with `RequiresBinary`
(`storageUpload`, `storageDownload`). The bytes are held in memory, not
streamed, and a deleted file's bytes are only unreachable.

Fix round 2, after the limits, snapshot and redaction rows merged:

- **Limits.** File storage charges the four file counters through
  `Metering.ts`'s one meter. A mutation's store checks
  `filesWritten` and `fileWriteBytes` before it writes the row
  (`file_storage_store`, `crates/isolate/src/environment/udf/async_syscall.rs:478-497`),
  refusing with `TooManyFilesWritten` or `FilesWrittenTooLarge`. Stored files
  are nested pending writes: a nested mutation starts from its caller's, a
  commit keeps its own and a rollback drops them, and a delete frees a file
  stored in the same transaction (`NestedWrites<FileUploads>`,
  `crates/database/src/transaction.rs:186`, `:425-451`;
  `crates/database/src/file_uploads.rs:68-79`; `async_syscall.rs:521-529`). A
  query's or mutation's `storage.get` counts a file once per transaction, never
  one it stored, against `filesRead` and `fileReadBytes`
  (`check_file_read_limits`, `async_syscall.rs:1291-1311`; the download cache
  reaches nested calls at `:732`). `getUrl` and `getMetadata` count nothing,
  and an action's store and get count toward no transaction. The local-backend
  probes in `storage.test.ts` cross each limit, at the deployment's ceiling and
  under a nested budget, and the binary and the kernel give the same message.
  A nested call's uncaught error reaches its caller as the binary rethrows it,
  `Uncaught Error: ` and a stack around the message, where the kernel passes
  the error itself, so nested probes compare the message.
- **Snapshots.** A snapshot carries every committed `_storage` row's file:
  bytes (base64), component and storage UUID, and `identity.nextFile` and
  `identity.nextUploadToken`. `Snapshot.contract.file` covers `Storage.File`
  by type, and `contract.world` lists `files`, `legacyIds`, `nextFile` and
  `nextUploadToken`. A restore rebuilds the UUID mappings from the files, and
  refuses with `SnapshotFileInconsistent` a file with no committed row, a row
  with no file, bytes whose SHA-256 or size is not the row's, and a UUID the
  kernel would not mint or two files share, and with `SnapshotAllocatorBehind`
  a `nextFile` at or behind a stored UUID. Bytes a rolled-back or deleted file
  left behind are unreachable and not exported.
- **Redaction.** `_storage` rows pass through every projection as documents,
  and a declared secret in a row that references a file stays marked. File
  bytes have no schema, so the backstop's rule applies to them: bytes holding
  a kept secret's text are written as a marker, which a restore given the
  secrets puts back, and refuses with `SnapshotSecretMissing` without them.
- **Content types.** A content type is parsed as the binary's `mime` 0.3.17
  parses it (`src/parse.rs:111-305`): its tokens, quoted values, spaces after a
  `;`, an empty subtype, and a bare trailing `;`, which it drops. A mutation's
  store refuses a malformed one as an argument (`async_syscall.rs:1272-1276`),
  ``Invalid argument `contentType` for `storage.store`: mime parse error: …``,
  and an action's as its content type header
  (`crates/isolate/src/environment/action/storage.rs:55-60`), `mime parse
  error: …`. The kernel stores the type as `mime` prints it.

`LocalBackend.ts` reads `CONFECT_LOCAL_BACKEND_PORT` (default 3210) for its
backends' ports, so the local-backend suite can run beside another checkout's
on one machine. Every anonymous local deployment is named `anonymous-agent`,
and `convex dev` waits for its recorded port to stop whoever holds it
(`cli/lib/localDeployment/run.ts:290-342` in the npm package), so a run on
other ports also moves the fixtures' local deployment config.

`integration.test.ts:61` `Storage` now runs in the kernel lane.

## HTTP routes and signed ingress (row 6)

`World.fetch` sends a test's request to the root component's `http` router.
The binary looks the route up with the router's own `lookup` and answers a miss
itself, with 404 and the text `No matching routes found`
(`run_http_action_inner`, `crates/isolate/src/environment/action/mod.rs:557-578`;
the body's content type is `text/plain; charset=utf-8`,
`crates/udf/src/http_action.rs:122-131`). The kernel does the same, so the npm
router's own `runRequest` fallback, `No HttpAction routed for …`, which
convex-test answers, never appears. A deployment with no HTTP module answers
every path that way. The route's handler runs as an action at
`https://some.convex.site` plus the path, with the request's headers and body
bytes as sent and the caller's identity, and a HEAD request gets the GET
route's status and headers and no body.

A mounted component's HTTP module now reaches only `MountedHttp`'s bridge,
which builds the router once per site URL. Registered as a backend module, the
kernel loaded it at open, under no mount's site URL, and a module that failed
to build failed every call to the world. The binary fails the push of a
deployment whose module throws at import, so this is a test-only isolation: a
mount's router is built at that mount's site URL, as the binary builds it, and
a failure there fails that mount's requests and no others.

`packages/server/test/signedEnvelope.ts` is a route-local ingress rule: a JSON
envelope `{ id, event }` whose `x-confect-signature` is the HMAC-SHA-256 of the
exact body bytes under a test-owned secret. It declares one refusal per
malformed shape, checked before anything is written. The mock-backend and
local-backend fixtures each mount it at `POST /ingress/events`.
`test/mock-backend/signedIngress.test.ts` runs a positive control and sixteen
garbage shapes on both lanes and checks after each refusal that the protected
`notes` table is byte-identical. The local-backend case in
`test/local-backend/http.test.ts` sends the accepted envelope, a tampered one
and a signed non-UTF-8 body to the binary and gets the same answers.

A route whose handler throws answers as the binary does, on the root and
through the mounted bridge alike: 500, `content-type: application/json`, and
`{ code, trace }`, plus `data` for a `ConvexError`. `code` is
`[Request ID: <16 hex digits>] Server Error: Uncaught <name>: <message>`, and
`trace` is that uncaught line and the error's stack frames, one per line, each
line ending in a newline. The binary builds it in
`RedactedJsError::to_http_response_parts`
(`crates/application/src/redaction.rs:143-160`), sends it from
`Application::run_http_action` (`crates/application/src/lib.rs:1542-1548`) with
a fresh request ID, and sets the content type in
`HttpActionResponsePart::from_json` (`crates/udf/src/http_action.rs:133-141`).
`test/local-backend/httpErrors.test.ts` pins it on the binary through
`LocalBackend.plainLayer`, a fixture of plain Convex HTTP actions on port 3230,
since a Confect router answers a handler's failure itself. The kernel's frames
are the host's, its request IDs are counted, and its `data` is the parsed JSON
where the binary writes a float as `2.0`.

convex-test rejects the `fetch` instead. The two root cases
(`test/mock-backend/httpRouteError.test.ts` and `httpRouteConvexError.test.ts`)
are conformance exceptions in the convex-test lane. #137's `conformance.ts`
machinery is not on `main` yet, so they are recorded the way the lane records
an exception today: `vitest.mock-backend.config.ts` lists each one, its exact
case, the binary behaviour, an owner, the convex-test version and the binary
evidence, and excludes its file, which holds that one case. An entry checked
against another convex-test version fails the lane. The mounted case runs on
both lanes, since the bridge is the adapter's own.

Fix round 2:

- A HEAD request's 404 and 500 end with no body, as its 200 does: the binary
  routes HEAD as GET (`RoutableMethod::try_from`,
  `crates/common/src/types/actions.rs:127`) and sends no HEAD body.
- A mounted router's miss answers the binary's `No matching routes found`, on
  both targets, where the bridge answered convex-test's `No HttpAction routed`.
  A component router runs through the same `run_http_action_inner`, so its
  miss is the root's (`crates/isolate/src/environment/action/mod.rs:557-578`).
  No local fixture mounts a plain component router, so this one is pinned by
  source, not by a binary run.
- GET, OPTIONS and HEAD requests reach their route with no body, at the root
  and through the bridge, as the binary discards one
  (`ExtractHttpRequestMetadata`, `crates/local_backend/src/http_actions.rs:131-140`).
- A kernel refusal inside a route is no handler error, so it surfaces as
  itself rather than as a 500. Convex's `performAsyncSyscall` rethrows a
  syscall's error as a plain `Error`, so the kernel keeps the first refusal a
  call's syscalls threw, its nested calls' included, and the root `fetch` and
  the bridge rethrow it. Loader and compatibility failures stay outside the
  handler's catch and reject as before.
- `fetch` now counts in the live registries a snapshot waits on (`running`,
  then `functions` while the route runs), so a snapshot refuses mid-request.
- Fix round 3: the bridge drops a GET or HEAD body before it builds the
  request, which cannot be built with one, as the root does. The 500 body is
  an artifact, so the root and the bridge build it from the failure
  redaction's copy of the thrown value: a kept secret a route's error carries
  is marked there as in a rejected call's report.

`test/local-backend/httpErrors.test.ts` pins on the binary, through raw
`node:http` requests on their own connections: HEAD answers to `/ok`, a missing
route and a throwing route, an OPTIONS body never reaching its route, two
values of one request header reaching the route as `a, b`, and a route's two
`set-cookie` values leaving as two header lines. The test kernel answers each
the same.

Identity comes from the test's accessor, not from an `Authorization` header,
which is the JWT row's. Not simulated: TLS, streaming request and response
bodies, and edge limits.

`http.test.ts` and the mounted HTTP route cases, `components.test.ts:534` to
`:736`, now run in the kernel lane.

## Snapshots (row 6)

`src/internal/Snapshot.ts` encodes the kernel's committed state and reads it
back. A snapshot is a header line, `confect-kernel-snapshot 4 sha256:<digest>`,
then the body as JSON. The body holds the registered component paths, the
version and latest commit timestamp, the clock's floor, the identity counters
(the next document ID, the latest creation time handed out, the next held
attempt's ID), every component's rows with the version that wrote each, every
committed job's target, standing and world name, and the write log with each
change's before and after values. Components, tables, rows and jobs are sorted,
so the bytes do not depend on the order a world met them. Each document keeps
its own field order, which a query on the kernel returns, so a restored world
answers the same bytes. The binary keeps an object's fields sorted
(`ConvexObject.fields` is a `BTreeMap`, `crates/value/src/object.rs:51` at
`precompiled-2026-10-28-cccbade`), which the kernel, like convex-test, does not.

Values use Convex's encoded JSON (`convexToJson`), the binary's
`ConvexEncodedJSON`, which the websocket and the HTTP API's
`format: "convex_encoded_json"` return (`crates/value/src/export.rs:20-24`,
`:45-50`, `crates/local_backend/src/public_api.rs:75-81`). An int64 is
`{"$integer": <base64, little-endian>}`, bytes are `{"$bytes": …}`, and a
negative zero, an infinity or a NaN is `{"$float": …}`
(`crates/value/src/json/mod.rs:103-127`). A throwaway probe through
`packages/server/test/local-backend/LocalBackend.ts` stamped a `commitStamps`
row on the binary, read it back through `/api/query` in that format, and
stamped the same row on the kernel with the binary's commit timestamp: both
encode the row's `at` and `label` as
`{"at":{"$integer":"zWXE04qE5xg="},"label":"probe é"}`.

The write log is carried whole. `Kernel.conflict` finds the commits after a
snapshot version by position in the log, so a restored world whose log were cut
would validate a later attempt against the wrong commits. A job's world is
recorded by its name and resolved among the worlds the restore is given. A
backend holding attempts refuses to export, since a held attempt is a running
closure, not state. Restore refuses a backend that committed or holds attempts,
registers other components, or is not given a job's world. Subscriptions are
the client's, not the kernel's, and are not carried.

Not simulated: the binary's own snapshot import and export. The binary exports
a ZIP of `<table>/documents.jsonl` in `ConvexExportJSON`
(`crates/exports/src/zip_uploader.rs:57-65`) and imports ZIP, JSONL, JSON and
CSV files (`crates/application/src/snapshot_import/parse.rs:173-258`). A kernel
snapshot is neither, so there is no binary import to drive against it. Native
import compatibility stays on the binary.

The digest binds integrity, not origin. Bytes a writer rehashes after editing
pass the digest, so a restore checks that the body is state the kernel could
have reached before it installs any of it, each rule with its own refusal:

- `SnapshotRowInconsistent`: replaying the write log from the empty world,
  each change replacing the value the log last published, gives exactly the
  rows, each at the version that last wrote it, under its ID's table and in a
  registered component.
- `SnapshotAllocatorBehind`: the next document ID is past every ID's counter,
  the latest creation time at or past every document's, the next attempt ID
  positive and the identity epoch non-negative. A rewound counter would hand
  out an identity the state already holds, and the next insert would overwrite
  its row.
- `SnapshotTimestampInconsistent`: commit timestamps strictly increase through
  the log, and the latest is the log's last.
- `SnapshotJobInconsistent`: every job names a committed job row, a registered
  component and a function that component exports, every job row has its job,
  and no job is running.

A world refuses to export or restore while any live registry the contract
names is non-empty. These are calls from the test, scheduler walks, function
executions (nested and detached ones included) and held attempts, refused with
`SnapshotWorldRunning` or `SnapshotWorldBusy`. A restore also refuses while a
subscriber is registered, with `SnapshotSubscribed`: subscriptions are live
client state, and a restore would rewind an existing subscriber's identity
version so its next `authenticate` reused one. A scheduled action awaiting
something would otherwise commit after the export, and a nested mutation an
action leaves running would write after it. The binary lets detached work
finish within its function's lifetime (#122), so a snapshot waits for it
rather than cancel it.

Before any map is built, a restore checks the decoded body, so its order
cannot change the result. Components, tables, a component's rows and jobs
each appear once, and every stored or logged document has an `_id` string and
a finite, non-negative `_creationTime`, logged under its own ID. A duplicate
table listed empty first would otherwise be overwritten by its populated
twin, and a missing creation time would make the allocator check compare
against `NaN`.

The identity epoch is #125's identity version made world-wide. A subscriber
starts at the world's epoch, and each `authenticate` advances it, so a
restored world continues the versions its source handed out and replays the
same identity transitions.

`Snapshot.contract` lists every piece of kernel state as exported or excluded
with its reason. Its comment names the limit of the fresh-world field test, which
cannot see lazy, symbol-keyed, `#private` or closure-held state, so every live
registry is also listed in `contract.live`, reported by a `liveCounts` typed
against it, and refused on restore while non-empty. A field added to `Kernel.State`, `Scheduling.Target`,
`Execution.CronJob` or `Storage.File` without an entry fails to compile. A `World`'s fields are private, so a test
compares a fresh world's own fields with the contract. Subscriptions and their
callers are live client state, so a restore starts with none. Owed when they
land: component init markers.

Cron state (#133) is in the snapshot, from format version 2. Storage state
(#138) joined it as version 3: `files` and the identity counters `nextFile` and
`nextUploadToken`. Each declared job
exports its declaration (name, function, arguments as Convex JSON with secrets
marked as a job's arguments are, and schedule, a cron expression by its text),
its next run, its latest outcome and its world by name. A failed outcome's text
is whatever the function threw, so it can hold a kept secret: the export writes
it through `Redaction.mark`, a marker a restore unmarks, and `crons()` reports it
through `Redaction.failure`. The raw text stays in the job's replay state. A cron job's fields are
checked by type against `Execution.CronJob`. A restore never redeclares a cron
and never draws a fresh random value. The world reads its app's declarations
when its modules load, which draws nothing, and only the call that opens the
backend schedules first runs, the one step that draws. A restore loads without
that step, refuses with `SnapshotCronMismatch` unless the app declares exactly
the snapshot's jobs with the same function, arguments and schedule, resolves
each job's world by name among `worlds` and the backend's own, and installs the
snapshot's runs. A clock schedule restored with no world is refused with
`CronRandomUnavailable`. A snapshot taken before its backend opened holds no
cron jobs, so restoring it into an app that declares some refuses.

## Transaction limits (row 6)

`src/internal/Metering.ts` is the kernel's one record of what an attempt has
used, and `1.0/getTransactionMetrics` reads it, so `TransactionMetadata` and
the limit checks share a single writer. The limits, the counting rules and the
messages are convex-backend's at the local backend's pin,
`precompiled-2026-10-28-cccbade`:

| Metric                                                         | Default                                     | Counted when                                                                                                         | Message on crossing                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `documentsRead`, `bytesRead`                                   | 32000, 16 MiB (`knobs.rs:641-647`)          | a get, patch, replace, delete or query reads a user document, sized as `getConvexSize` sizes it (`reads.rs:365-445`) | `Too many documents read …`, `Too many bytes read … (limit: N bytes)`, each with the binary's help sentence |
| `databaseQueries`                                              | 4096 (`knobs.rs:657-658`)                   | a read adds a disjoint interval to its index's merged set (`reads.rs:447-480`, `interval_set.rs:150-230`)            | `Too many reads …` with the help sentence                                                                   |
| `documentsWritten`, `bytesWritten`                             | 16000, 16 MiB (`knobs.rs:406-412`)          | each user write, a delete with no bytes (`writes.rs:241-310`)                                                        | `Too many writes …`, `Too many bytes written … (limit: 16 MiB)`                                             |
| `functionsScheduled`, `scheduledFunctionArgsBytes`             | 1000, 16 MiB (`knobs.rs:514-536`)           | a schedule, checked before it counts, its arguments sized as `[args]` (`scheduled_jobs/mod.rs:162-196`)              | `Too many functions scheduled by this mutation …`, `Too large total size of the arguments …`                |
| `filesWritten`, `fileWriteBytes`, `filesRead`, `fileReadBytes` | 10, 16 MiB, 10, 16 MiB (`knobs.rs:539-556`) | never yet: the storage row counts them                                                                               | none yet                                                                                                    |

A failed nested mutation's writes leave the count with its frame; its reads,
intervals and schedules stay, as the binary keeps them outside its
subtransaction token (`transaction.rs:418-454`). A stale-snapshot query meters
on a clone that keeps the caller's scheduling counters and starts reads and
writes from zero, and the caller drops it (`clone_for_snapshot_query`,
`transaction.rs:1460-1485`). A nested call's `transactionLimits` budget
tightens only that call, from what the transaction has used, never above its
caller's ceiling (`execution_size.rs:97-160`, `async_syscall.rs:700-706`). A
patch or replace that changes nothing reads the document and writes nothing
(`transaction.rs:713-790`). Whether it changed anything is structural, so a
pending commit timestamp equals only another pending timestamp, at any depth
(`PendingValue` derives `PartialEq`, `pending.rs:56-75`). Each retried attempt
counts from zero. A limit refuses inside the function with a catchable error,
as on the binary.

`databaseQueries` follows `record_indexed_directly` (`reads.rs:447-480`): a
read drops the total by its index's interval count before the read, saturating
at zero, and adds the count after. An inserted ID joins its table's `by_id`
intervals without counting (`register_new_id`, `writes.rs:426-441`;
`record_indexed_derived`, `reads.rs:333-344`), so a later read of that index
can saturate the total. After 100 inserts, reading one inserted ID answers 100
on both targets, and a `by_id` scan then answers 1. The total is never
negative: `Metering.ts` asserts it.

### What stays on the binary

`packages/server/test/mock-backend/kernelBoundaries.ts` records each accepted
difference by name. `SystemTableReadIntervals` is the one this row adds. The
binary's `databaseQueries` also counts the system-table intervals it reads to
run a function: the backend state, the module, the UDF config and the
component. On the local-backend fixture a root mutation starts at 23, its first
nested call adds 2, and a stale-snapshot query starts at 23 again. That share
depends on the deployment, so the kernel does not simulate it.

Each read maps a total `x` to `max(0, x - before) + after`, which never
decreases and never moves two totals apart. So the binary's count stays between
the kernel's and the kernel's plus the system share:

- While neither count saturates, the binary's is exactly the kernel's plus the
  share, and the binary refuses `TooManyReads` that many reads sooner.
- A read that covers inserted IDs can saturate only the kernel's lower count,
  and the gap shrinks. One insert and a read of its ID answer 23 on the binary
  and 1 on the kernel, a gap of 22.
- Once a read saturates both, they agree. 100 inserts and a read of one answer
  100 on both.

The binary refuses no later than the kernel, and at most the system share
sooner. CPU, heap and duration stay on the binary, as the design says.

### Boundary check

`packages/server/test/local-backend/transactionControls.test.ts` runs each case
on the local backend and on `TestConfect.layer(registry, { target: "kernel" })`.

- `groups/transactions:metrics` runs one fixed workload over three seeded
  notes: an index read, a read by ID, a write, a write that changes nothing, a
  delete, a nested query, a nested mutation that fails and one that commits, an
  insert and a schedule. Every metric but `databaseQueries` is equal at the
  start and the end. `databaseQueries` on the binary is the kernel's plus the
  boundary's `rootMutationStart` at the start, and plus `firstNestedCall` too at
  the end. The case reads both amounts from the entry, and its name is the
  entry's `probe`.
- `groups/transactions:insertedIntervals` pins the saturating count above,
  with 100 inserts where both counts saturate, and with 1 insert where only the
  kernel's does and the gap shrinks to 18.
- `groups/transactions:staleMetrics` pins a stale-snapshot query's scheduling
  counters, 1 function and 4 bytes.
- `groups/commitTs:maxAfterPending` pins that a pending timestamp patched to
  `9223372036854775807n` is a second write that stores the integer.

## Redaction (row 6)

`src/internal/Redaction.ts` finds secret schema nodes and marks what they
hold. A secret node is a `Schema.Redacted` declaration, which
`Schema.RedactedFromValue` decodes to (its representation id is
`effect/schema/Redacted`). Convex validators carry no secret flag, and a
Confect-registered function keeps only its validators at runtime, so the
kernel cannot read secret nodes from the modules it loads. A policy names them:
`tablesOf` reads a Confect database schema's tables, and a declaration names
argument and return schemas per function and tables per component. Each schema
is a thunk built the first time the kernel needs it, so Confect's lazy table
schemas stay unbuilt until then. `TestConfect.layer`'s kernel target passes the
app's tables merged with its `secrets` option, or the generated registry's
`secrets`, which row 8's codegen fills from the Confect specs.

A policy hands out shapes, the type side of each schema's AST, and every
marking walks a value together with its shape. The value bounds the walk, so a
recursive schema ends at the value's depth, and a suspension reused at another
field is walked again there. A union applies each member the value fits,
and a secret member fits only what its inner type encodes to. Where the value's
structure departs from a shape that holds a secret beneath it, the walk treats
the value as secret whole. The walk never enters a marker, so overlapping union
members mark a shared field once and marking is idempotent.

The kernel keeps every value at a secret position, before it validates it, in
the world's `Secrets` store: a function's arguments as it is called, a job's
arguments as it is scheduled, a return value, and a document's fields as they
are written. A compound secret is kept whole, and every string beneath it is
kept for searching free text. The store is replay state. It lives in memory,
positions values in the order first seen, and no artifact writes it. The
writers:

- A snapshot export marks each secret position of a document, by its table's
  shape and, for a job row, its target's argument shape at `args.0`, with
  `{ "$redacted": <n> }`, `n` its position in the store. Convex's encoded JSON
  allows no object key that starts with `$` (`crates/value/src/json/mod.rs:9`
  at `precompiled-2026-10-28-cccbade`), so no stored value reads as a marker. A
  restore given the store puts the raw values back and adopts a copy of it, so
  its own exports are the same bytes. It puts them back before any body check, so a
  document's system fields and IDs are checked as the kernel stored them, and
  still before any map is built. Without the store it refuses with
  `SnapshotSecretMissing`.
- A failure report, whether a rejection or the error in a held attempt's
  outcome, is a separate report of whatever was thrown. A string, an `Error`,
  a frozen `Error` and a plain object all get their text, data and causes
  marked as `[redacted]`. When something is marked, the report is a copy with
  the thrown value's prototype and fields, so its class and tag read the same.
  The thrown value is never changed, so a subscription's cached error compares
  as it was. The report is built in two passes: the first finds
  whether anything reachable holds a kept secret, and the second copies every
  reachable error, array and plain object, registering each copy before its
  fields are walked. An array copy keeps its own properties, such as a
  `code`, beside its entries. So an error whose cause is itself, or two errors that are
  each other's cause, report copies that cycle to each other, never to a raw
  error.
- A subscription diff marks each outcome by the shape of what its query
  returns, and a commit cause's documents by their tables' shapes. A
  subscription's own value is replay state and stays raw.
- Read records, in held attempts and a subscription's `current()`, mark a key
  or range bound on a field its table's shape holds secret. Each field-path segment
  consumed starts a fresh ancestry, so a suspension reused down the path, as
  in `data.child.child.token`, is followed again.
- A held attempt's outcome, in `prepare`, `held` and a conflict's next attempt,
  and an applied result are marked by the shape of what the attempt's mutation
  returns: the held view carries its `functionPath`. A normal call returns its
  value to its caller, which is replay state, so it stays raw.
- `projectArguments` marks a function's arguments by its argument shape. #137's
  `commands()` writes each provider command's input through it when the stacks
  meet.

Every value artifact then passes a string backstop: a string holding a kept
secret of four characters or more is marked. The backstop never marks a document's `_id` or
`_creationTime`: an ID is its document's identity, not a secret value, even
when a secret field holds the same ID. Free text has no schema, so a
failure report's message and stack are searched for kept secret strings. A
secret string shorter than four characters is marked in values by its schema,
not in free text.

The binary has no schema-level secret marking. It redacts by visibility: with
logging blocked, a client's log lines are dropped and an error reads "Server
Error" (`crates/application/src/redaction.rs:39-50`, `:96-140`). Rejecting
credential-shaped text by pattern stays with the artifact filer, not here. The
kernel writes no logs of its own, and a handler's `console` output goes to the
host unmarked. Each wire canary lands with its wire.

Canaries cover every route found so far. These are an argument never stored, an
argument stored in a secret field, a row written directly, a provider's
answer, a bare throw and a frozen error. They also include a failing
subscription, a compound secret, a reused suspension, a recursive value, two
union members sharing a field, and an index read on a secret field. None
reaches the snapshot, a failure report, a diff or a read record.

## Upstream 10.6.0 on the kernel lane

The fork moved to upstream Confect 10.6.0 and Effect 4.1.4 after row 6's
first parts landed. Upstream's release adds mock-backend cases that the
inventory above never placed, so the lane met them on the merge.

- `TestConfect JWT signing` waits for row 6's JWT signing and verification.
- `TestConfect Blob storage` runs on the kernel since the storage row landed,
  and so do two `mutation Blob transactions` cases. Of the rest, the four that
  pass a deployment-wide `transactionLimits` option to `convexTest` wait for
  row 6, which refuses that option. The two that store a file with no content
  type are placed `binary`: the binary and the kernel store a `null`
  `contentType`, which Confect's `_storage` schema refuses, where convex-test
  stores none.
- `mock search compatibility` and the search case of `mock query
  compatibility` read through a text search, so they are placed `binary`
  beside the Doc decoder's search case.
- `mock query compatibility > pins the Effect clock inside TestConfect.run`
  fakes `Date` after its layer built the backend. The kernel wrapped the realm's
  `Date` only when the backend opened, so the test's fake replaced the wrapper
  and the run read the moved host time. Each kernel function now wraps the
  realm's `Date` again as it enters, as it installs `globalThis.Convex` again,
  and the case runs on the kernel.
- The local-backend fixture moved to `tools/local-backend` and deploys more
  modules and components, so `SystemTableReadIntervals` was measured again on
  the same binary. A root mutation and a stale-snapshot query now start at 21,
  where `main`'s fixture measured 18 once the storage row's probe functions
  joined it. The first nested call still adds 2.
- The convex-test lane's two HTTP route error exceptions were checked on
  convex-test 0.0.65. Upstream's release moves the lane to 0.0.67, which still
  rejects the fetch with the thrown error, so both exceptions hold and name
  0.0.67.

## JWT verification and signing (row 6)

`src/internal/Identity.ts` holds the kernel's verifier and its deployment
signer. The rules come from the pinned binary, `precompiled-2026-10-28-cccbade`
(convex-backend `cccbade4`), and its `biscuit` fork at `05bdaab2`.

At open the kernel loads the app's `auth.config.ts` or `auth.config.js` beside
its functions, as the CLI pushes it, and reads its default export's providers
on the first presented token. A `customJwt` provider needs a string issuer and
JWKS, an RS256 or ES256 algorithm and an optional string `applicationID`. Any
other entry is an OIDC provider with a string domain and `applicationID`
(`common/src/auth.rs:120-139`). An issuer or domain without a scheme gets
`https://` (`:209-241`). A provider the binary would refuse at push fails with
`InvalidAuthConfig`.

`t.withToken(token)` is the backend as a client that presents `token`. Each
call verifies it at the kernel's time before any function runs, as the binary
verifies a client's token on every request (`application/src/lib.rs:3297-3328`):

1. The unverified payload's `iss` and `aud` pick the first provider whose
   issuer matches, ignoring trailing slashes, and whose `applicationID`, if
   set, is among the audiences (`common/src/auth.rs:48-82`). None matching is
   `NoAuthProvider` (`authentication/src/lib.rs:161-200`).
2. An OIDC provider refuses with `RequiresBinary` `oidcDiscovery`. A
   `customJwt` JWKS must be a `data:` URL, decoded as the binary's `data-url`
   crate 0.3.1 does (`:439-456`). Tabs and newlines are ignored, the body stops
   at the first `#`, so a fragment is dropped, and it is percent-decoded and
   then base64-decoded when the media type ends `;base64`
   (`data-url/src/lib.rs:73-120`, `:283-353`). Any other URL refuses with
   `RequiresBinary` `remoteJwks`, so the test owns every key the kernel trusts.
3. The header's `kid` names the key. The JWK's `alg`, when present, must equal
   the header's and the provider's, and otherwise the header's must equal the
   provider's (`biscuit/src/jws/compact.rs:142-212`). The key must be one the
   binary's `ring` 0.17.14 takes (`biscuit/src/jwa.rs:368-445`). An RS256
   modulus is odd, over 2,040 bits rounded up to whole bytes and at most 8,192,
   and its exponent is odd, at most five bytes and from 3 to 2^33 - 1
   (`ring/src/rsa/public_modulus.rs:47-71`, `public_exponent.rs:46-80`,
   `verification.rs:205-219`). An ES256 key is its `x` and `y`, 32 bytes each,
   whatever `crv` it names (`biscuit/src/jwk.rs:373-380`). The signature must
   hold.
4. The issuer and audience are checked again, then `exp`, `nbf` and `iat` with
   five seconds of skew (`authentication/src/lib.rs:371-407`,
   `biscuit/src/lib.rs:906-966`). A timestamp is a number from 0 up to 2^64,
   rounded to the nearest second, and any other value fails the payload
   (`biscuit/src/serde_custom/numeric_type.rs:52-91`). The clock is whole
   seconds (`authentication/src/lib.rs:155-159`), and a failure's message is
   `biscuit`'s, counting the seconds: `Token expired 60 seconds ago`, or
   `Token will be valid in 60 seconds` for `nbf` and `iat`
   (`biscuit/src/errors.rs:213-218`).
5. `sub`, `iss` and `exp` must be present. The identity is `tokenIdentifier`
   (`iss|sub`), `issuer`, `subject` and every other claim under its own name.
   Nested objects flatten to `outer.inner` keys, and `aud`, `exp`, `iat`,
   `nbf`, `jti` and `fva` are dropped (`keybroker/src/broker.rs:512-551`,
   `:681-695`). A `customJwt` token's `name` or `email` is a custom claim with
   that name, not an OIDC field.

Steps 2 to 5 fail with `InvalidAuthHeader`. Both codes come as `InvalidToken`,
the transport refusal, which the binary answers with HTTP 401. A token is
verified on every call, so a call past its expiry plus five seconds of the
kernel's clock is refused.

Verifying the token is part of its call. A query, mutation, action, `run`,
`prepare` or `fetch` that presents a token reaches the verifier inside its own
live call, so while the backend loads the modules the verifier needs, an export
or a restore refuses with `SnapshotWorldRunning`, as it does for a call that
presents none.

An HTTP request is the exception the binary makes. Its handler runs whatever
the verifier decides: a refused token leaves the request an unknown identity
that holds the verifier's error (`local_backend/src/http_actions.rs:165-169`).
A verified token gives `getUserIdentity` its identity. For a refused one,
`getUserIdentity` throws the error
(`isolate/src/environment/action/task_executor.rs:205-216`), which reaches the
handler as a plain `Error` with the verifier's message and no `data`
(`isolate/src/environment/helpers/promise.rs:74-76`, `errors/src/lib.rs:25-26`,
`convex` 1.49 `src/server/impl/syscall.ts:47-52`). A function in the host the
handler calls through `ctx.runQuery`, `ctx.runMutation` or `ctx.runAction`
gets the same unknown identity (`model/src/components/auth.rs:6-19`). An action
throws the error again from `getUserIdentity`. A query or mutation reads its
transaction's identity, which for an unknown identity is none, so it sees
`null` (`isolate/src/environment/udf/async_syscall.rs:1111-1142`,
`database/src/transaction.rs:390-396`). A component's function sees no
identity either way. The local-backend suite's plain fixture checks each of the
three calls on both targets, through `/token-review-hop`.

`ctx.auth.signJwt` in a mutation now signs with an ES256 key, and `t.jwks()`
answers its public half. The rules are convex-test 0.0.65's, which match the
binary's `mint` (`keybroker/src/deployment_jwt.rs`,
`udf/src/deployment_jwt.rs`). The token is issued at the mutation's start
time, as the binary signs at the function's timestamp
(`isolate/src/environment/udf/async_syscall.rs:1149-1179`).

A token can reach committed state, so no host randomness goes into it. On first
use the key's seed is 32 values from the random stream of the invocation's world
bound then, or else the backend's own world, the stream a cron delay draws from
(row 5). The key is derived from the seed as the binary derives its key from
the deployment's root secret: an HMAC of a label and an attempt counter,
retried while the scalar is out of range
(`keybroker/src/deployment_jwt.rs:162-176`). A backend with neither world
refuses with `SigningKeyRandomUnavailable`, as a clock cron refuses with
`CronRandomUnavailable`. `TestConfect.layer`'s kernel target gives its backend a
world seeded by its `seed` option, so one seed draws one key. The signature is
`@noble/curves` 2.4.0's ES256, whose nonce is RFC 6979's. The binary's signer
draws a random nonce (`:308`), which no verifier can tell from a deterministic
one. `test/fixtures/signedReplay.ts` stores signed tokens through
`TestConfect.layer`, two processes with the default seed print the same bytes,
and a process with another seed signs under another key.
`components.test.ts:84` gives its backend a world through `convexTest`'s
options, which convex-test ignores.

A snapshot carries the key. The seed is kept as a secret when it is drawn, so an
export writes `signingKey` as a marker and no artifact shows the seed raw. A
restore puts the seed back from the source's `secrets()` and installs it without
drawing, so the restored backend verifies the tokens in its tables and signs
under the same key. A restore without the secrets refuses with
`SnapshotSecretMissing`. The field took the format to version 4. #134 keeps
snapshot format 4, and #137 takes 5. The snapshot contract lists `deploymentKey`
as exported, and `authConfig` and `providers` as excluded, since the restoring
backend loads its own `auth.config`.

`tools/local-backend/fixtures/minted.ts` mints five tokens with keys the test
makes: a valid control, a wrong issuer, a wrong audience, a foreign key under
the declared key's `kid`, and an expired token. `test/Identity.test.ts` runs
them on the kernel, and `packages/server/test/local-backend/jwt.test.ts` runs
them against the binary through the fixture's own `auth.config.ts` and its
`groups/components:identity` query. Both targets give the same outcome, the
refusal code and the valid control's identity included. Both also send each
token to an HTTP action at `/token-review`, which answers 200 with what
`getUserIdentity` gave or threw (`tools/local-backend/fixtures/tokenReview.ts`).
The thrown error's class, `data` and message are the same on both targets. An
expired token's message counts the seconds on the verifier's clock, so the
binary test accepts the message for any second between its clock reads before
and after the request. `components.test.ts:84`, signing and the deployment JWKS,
now runs in the kernel lane, and its placement is gone. Upstream's "rejects
tokens from another TestConfect instance" builds its second layer with `seed: 1`
through the lane's `TestConfect.layerWith`, so on the kernel the second backend
draws another key, as a second deployment has its own. convex-test ignores the
seed. The case runs in the kernel lane, and its placement is gone.

## Component identity (row 6)

Row 2 gave every function in a mounted component no identity, on the premise
that Convex gives a component no `ctx.auth` of its caller's. The binary
disagrees, and the kernel now follows it (`callIdentity` in `Execution.ts`),
convex-backend `cccbade4`:

- A query's or mutation's nested call runs on its caller's transaction, and
  `getUserIdentity` reads that transaction's identity in a component as in the
  app (`crates/isolate/src/environment/udf/async_syscall.rs:629-724`,
  `:1111-1141`). A component a query or a mutation calls sees the caller, at
  every depth.
- An action's call passes its identity through `propagate_component_auth`,
  which keeps it only from the app to the app
  (`crates/isolate/src/environment/action/async_syscall.rs:166`,
  `crates/model/src/components/auth.rs:6-19`). A component an action calls
  sees none, and so does every call below it.
- A client reaches only the app's functions, so a test that calls a component
  directly gets no identity, as a component's HTTP action does
  (`crates/function_runner/src/server.rs:450-455`).

Confect still drops `ctx.auth` from a Confect component's context. That is its
API's rule, separate from parity, and the probe below reads `ctx.auth` through
plain Convex functions for that reason.

### Boundary check

The local-backend fixture's `left` (parent), `left/deep` (middle) and
`left/deep/child` (inner) mounts each expose a plain Convex `identityChain`
query. It reads `ctx.auth.getUserIdentity()` and its component path, then calls
the next mount's. `groups/componentIdentity` calls the chain from a query, a
mutation and an action, beside the host's own reading.
`test/fixtures/componentIdentityProbe.ts` holds the one answer both targets
give: the caller at every depth from the query and the mutation, none from the
action. `packages/server/test/local-backend/componentIdentity.test.ts` gets it
from the binary with a token the fixture's `auth.config` accepts, measured on
`precompiled-2026-10-28-cccbade`, and `test/ComponentIdentity.test.ts` from the
kernel under `withIdentity`.

## Request metadata (row 6)

`ctx.meta.getRequestMetadata()` answers `ip`, `userAgent`, `requestId`,
`scheduledFunctionId` and `authToken` in a mutation or an action; a query's
`ctx.meta` has no such method (`convex/src/server/impl/meta_impl.ts`, 1.49). The
binary's rules (convex-backend `cccbade4`):

- A client's HTTP call is a request of its own. Its ID is 8 random bytes in
  lowercase hex (`crates/common/src/execution_context.rs:204-208`), unless the
  client sends `convex-request-id` (`common/src/http/mod.rs:1022-1041`). Its
  address is `x-forwarded-for`'s first entry, or else the peer's, and its agent
  is `user-agent` (`:1062-1092`).
- A nested call keeps its caller's request: a mutation's nested call clones the
  caller's context (`isolate/src/environment/udf/async_syscall.rs:715-735`), and
  an action's calls pass its request ID and metadata on
  (`application/src/application_function_runner/mod.rs:2206-2289`).
- A scheduled job starts a fresh request with no address or agent
  (`application/src/scheduled_jobs/mod.rs:743-758`), runs with no identity
  (`:1072-1080`), and reports its own ID as `scheduledFunctionId`, which every call
  under it inherits (`udf/async_syscall.rs:1053-1058`,
  `action/async_syscall.rs:425-447`).
- `authToken` is the token the request was authenticated with, or `null`.

The kernel already followed every rule but the ID's format. Its request IDs
were `kernel-request-N`; they are now a counter in the binary's format, 16
lowercase hex digits, so each request in the process has its own and a replay
draws nothing from the random stream. The real address and headers stay on the
binary; a test sets them with `withRequestMetadata`.

### Boundary check

`groups/requests` in the local-backend fixture reads the request from a client
mutation and its nested mutation, from a client action and its nested mutation
and action, and from a mutation that schedules a mutation and an action, which
record what they and the action's nested mutation read.
`test/fixtures/requestProbe.ts` replaces each value a target chooses by its
role, a request ID by `request N` in first-seen order or `malformed`, and holds
the one literal both targets must answer.
`packages/server/test/local-backend/requestMetadata.test.ts` calls the binary
with a token its `auth.config` accepts, `x-forwarded-for` and `user-agent`, and
`test/RequestMetadata.test.ts` calls the kernel with the same identity, address
and agent.

## Sync protocol (row 7)

`src/internal/Sync.ts` is the kernel's side of the Convex client sync
protocol, as `convex` 1.49.0 speaks it (`src/browser/sync/protocol.ts`) and the
pinned binary's sync worker serves it (`crates/sync/src/worker.rs` at
`cccbade4`). `sync()` on the shim gives its `WebSocket`, a constructor the
unmodified `BaseConvexClient` takes as its `webSocketConstructor`. Every event
reaches the client in a later turn, in order.

Each socket runs as one worker does (`worker.rs:403-517`, `:598-901`):

- Client messages run one at a time in arrival order. Mutations run one at a
  time in their own order, and actions at once.
- A `ModifyQuerySet` whose base is not the version last received, or whose new
  version is not greater, is refused (`state.rs:223-243`). So is an
  `Authenticate` whose base is not the identity version last received
  (`state.rs:257-268`), a timestamp the client observed past the latest commit
  (`worker.rs:601-644`), a call to a non-root component (`:581-596`), and a
  duplicate or unknown query ID (`state.rs:339-360`). Each is
  `SyncProtocolViolation` with the binary's reason, answered with `FatalError`
  and a closed socket, which the client takes as fatal (`client.ts:504-507`).
- A `User` token is verified with row 6's verifier before the identity version
  moves, and a refused one answers `AuthError` with `authUpdateAttempted` and
  closes (`worker.rs:857-864`, `:1333-1341`). Before each mutation, action and
  update the token's expiry is checked at the kernel's time, as the binary's
  `revalidate_identity` checks it (`:503`, `:671`, `:781`, `:903-912`): a user
  identity is expired once the time reaches its `exp`, with no skew
  (`state.rs:282-305`, `keybroker/src/broker.rs:676-678`). An expired one
  answers `AuthError` without `authUpdateAttempted`, before anything runs, and
  closes. Every `AuthError` carries the identity version the socket last sent,
  as the binary's does (`local_backend/src/subs/mod.rs:276-292`). An `Admin`
  token refuses with `RequiresBinary` `adminAuthentication`: the kernel holds no
  admin key.
- A transition is scheduled by a query-set change, an identity change, an
  answered mutation or action, or a commit that changed what one of the
  socket's queries read (`World.watch`, called as each commit publishes). It
  applies the pending modifications, reruns the stale queries until none is
  stale, then ends at the latest commit timestamp and the identity version
  received, read in the same turn as that last check (`:933-1061`,
  `:1253-1324`). A query whose value did not change sends nothing, as the
  binary's result hash does (`state.rs:414-460`). After every answered request
  a transition follows, even an empty one, so a successful mutation's client
  sees a state at or past its commit and resolves it
  (`request_manager.ts:169-191`).

A query that cannot run at all, because its function does not exist or its
validator refuses its arguments, answers `QueryFailed` and stays in the set
until the client removes it, as on the binary; the socket lives. A failure with
no `ConvexError` data leaves `errorData` out, as the binary does, so the client
reads a plain error. A query whose first run ends after its socket closed is
unsubscribed at once.

The probe found one divergence outside this row: the kernel's argument
validator, convex-test's, words a refusal `Validator error: Expected
\`string\`, got \`5\``, where the binary answers `ArgumentValidationError:
Value does not match validator.` with the path, value and validator. Both fail
the query; only the text differs. Validation text belongs to the validator, so
leg 1 does not compare it, and it is recorded here for that row.

Each socket's queries are subscriptions of row 4's registry under one
subscriber that `Sync` pushes. A commit makes one stale by row 4's rule. An
identity change makes every one stale, as the binary's worker takes every
subscription when the identity version moves (CX-737, `worker.rs:948-962`).
A test's own subscriber keeps row 4's narrower rule. A pushed subscriber's
reruns go through a model of the binary's query cache
(`application/src/cache/mod.rs`): a result is stored under its function, its
arguments, its journal and, only when it read the identity, that identity
(`:151-230`); a lookup tries the identity first and then no identity; a commit
since the result ran that changed what it read drops it; and a result that read
the time is dropped once it is older or newer than `MAX_CACHE_AGE`
(`:768-823`), 17 s by default (`:112-122`, `common/src/knobs.rs:982-994`) and
`queryCacheAge` on the shim. So an identity change answers a time query that
reads no identity with the value it sent until that value has expired, and a
new time after: leg 1 checks both on the binary. `refresh` without a subscriber skips
pushed subscribers, so a test's refresh never takes a change a socket is owed,
and `reference` still reruns them. `Subscriber.present(token)` is the
Authenticate step: it verifies the token and bumps the identity version. The
shim's `withToken(token).subscriber()` presents its token the same way, so
row 6's `KernelRowPending` naming row 7 is gone; a refused token rejects that
subscriber's subscriptions with `InvalidToken`.

Each session keeps a request ledger, which `Sync` alone writes. A successful
mutation enters it as its commit is applied, with its request ID, function,
attempt number, commit timestamp, result and the SHA-256 of its arguments'
artifact form (marked by the argument shape, keys sorted). A mutation resent
under a recorded request ID is answered from the ledger with the original
timestamp, and one resent while it runs waits for it. This is the binary's
`_session_requests` (`application_function_runner/mod.rs:999-1004`,
`:1063-1066`, `:2118-2178`), which records successes only (`:2163`), so a
failed mutation runs again when resent. A resend is told from a reuse by the
digest of its raw canonical arguments, which stays in memory beside the
secrets store and never reaches an artifact. The artifact digest marks secrets
first, so it changes once a call registers a secret, and it cannot identify a
request. A session outlives its sockets, so a client that reconnects under it
is answered from its ledger. `ledger()` is the read side for the System driver.

### Conformance exception: `SyncRequestReused`

The one place `Sync` departs from the binary on purpose.

- **Case.** A session sends a mutation under a request ID its ledger already
  holds, with arguments whose raw canonical digest differs from the recorded
  one.
- **Binary.** It answers the recorded outcome, with the original timestamp,
  and runs nothing. Its record has no arguments to compare: a
  `SessionRequestRecord` is the session, the request ID, the outcome and the
  identity (`model/src/session_requests/types.rs:35-43`), and
  `check_mutation_status` looks the request up by session and request ID alone
  before the mutation runs (`application_function_runner/mod.rs:999-1004`,
  `:2121-2150`).
- **Kernel.** It refuses with `SyncRequestReused`, answers `FatalError` and
  closes the socket. The failure report names the recorded and sent artifact
  digests, never the raw ones.
- **Why.** The unmodified client never reuses a request ID with other
  arguments: it resends the same message (`request_manager.ts:193-230`). A
  client that does is a bespoke client with a bug, and the binary's answer, the
  outcome of another call, would hide it.
- **Pinned by** `test/Sync.test.ts`, "a successful mutation enters its
  session's ledger…", which resends request 0 with other arguments. Owner: row 7.

The protocol's artifacts are the ledger, `transcript()`, every message sent and
received, and `failures()`, each refusal with the client message that caused
it. Each leaves marked: arguments by their function's argument shape, values by
the return shape, a token's value replaced by the marker, and every string
holding a kept secret marked by row 6's backstop (`World.redactJson`). The wire
to the client carries raw values, as a call's caller gets them. Messages carry
no log lines, since the kernel captures no handler output, and no pings or
transition chunks.

The snapshot contract lists open sockets under `live.sockets`, which blocks a
restore (`SnapshotSocketsOpen`). A socket's subscriber outlives it, as any
subscriber does, so a backend a socket ever opened on refuses a restore with
`SnapshotSubscribed` too. `World.watchers` is excluded as live client state, and
`outside.sync`, the sessions, ledgers, query sets, versions and presented
tokens, is excluded: a ledger names commits of the world it answered.

### The binary probe

The probe compares the kernel with the binary, across its three legs. The
convex-test lane runs separately and is not part of it.

`packages/server/test/local-backend/syncProbe.test.ts` runs three legs of the
unmodified client (`test/fixtures/syncLegs.ts`) against a binary the run starts
through `LocalBackend.syncLayer` (port `CONFECT_LOCAL_BACKEND_PORT` + 30, the
`fixtures/sync` app) and against the kernel on the same app
(`test/fixtures/syncApp.ts`):

| Leg                 | Compared                                                                                                     | Required on both     |
| ------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------- |
| Observable protocol | Each socket's query values with consecutive duplicates removed, normalised mutation outcomes, terminal views | No message thrown on |
| OCC counter         | Whether contention showed, whether the counter ended at the increments that succeeded                        | Both true            |
| Client acceptance   | No message thrown on, each token confirmed, each mutation settled, a reconnect, the terminal counter         | All of them          |

Leg 1 waits after each step until both clients see a barrier counter reach it,
so batching never changes a sequence. Leg 2's contention on the binary is the
function log's `sync:increment` executions with OCC information, read with
`convex logs --jsonl` from the fixture project, whose CLI holds its own
credentials (`local_backend/src/logs.rs:79-280`); on the kernel it is the
ledger's increments that committed on a later attempt. Leg 3 loses one
mutation response with its socket, so the client reconnects under its session
and resends.

Each leg writes `.sync-probe/<leg>.json`: the binding, the digests of the app,
the legs and the kernel's sync and subscription sources, and both sides'
observations, through the kernel's redaction. The binding finds the process
that owns the cloud port through `/proc`, refuses unless the runner is its
ancestor, and records the worktree, revision, a dirty flag, the executable's
release directory and SHA-256, the ports and the PID. It takes ports, never a
URL. `SyncProbe.runLeg` writes the record `incomplete` before the leg runs, so
an earlier run's verdict never stands for this one. Every step of a leg has a
deadline, and each side has one too: a side that throws or passes it leaves
the record `incomplete`, naming that side, with both sides' partial
observations. A finished leg whose sides differ records both and fails as
`disagree`. Off Linux, which has no `/proc`, the probe is skipped with that
reason in its name before any backend starts.

Plants, each a one-line source edit (script and output in the PR):

| Plant                                                                  | Leg it fails |
| ---------------------------------------------------------------------- | ------------ |
| A subscription skips the first commit after its run                    | 1            |
| A held attempt publishes without validating its reads                  | 2            |
| A transition starts one query-set version past the client's            | 3            |
| A transition never advances the identity version                       | 3            |
| A resent mutation runs again instead of being answered from the ledger | 3            |
| The backstop leaves a protocol artifact as it is                       | canary       |
| A message's arguments reach the transcript unmarked                    | canary       |
| The ledger hands out a mutation's raw result                           | canary       |
| A probe record is written without its marks                            | canary       |

The canary (`test/Sync.test.ts`) sends a secret argument through the
unmodified client into a mutation that echoes it, one that fails with it, a
query that answers with it, and a two-character secret only its argument shape
can mark; it then sends one in a call the kernel refuses. Neither secret is in
the ledger, the transcript, a failure report or a probe record, and each holds
the marker.

### Row 7 fix round 1

A review of `d3a242e2` found five gaps, each now fixed with a case that fails
without it:

| Gap                                                                                                                        | Fix                                                                                             | Case, and the plant that turns it red                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| An identical resend failed once a call registered a secret, since resends were compared by the marked digest               | Compare by the raw canonical digest, kept in memory                                             | `Sync.test.ts`, "a mutation whose call registers a secret is answered from the ledger…"; comparing by the marked digest                               |
| Updates skipped auth revalidation                                                                                          | Check `exp` before each update and request                                                      | "a token that expires between two updates…"; skipping the update check, and skipping the request check                                                |
| The narrower identity invalidation was visible: a time query past the cache age changes on the binary after an auth update | Every query of a socket reruns on an identity change, through the cache model                   | leg 1 on both targets and on the kernel; the narrower rule, and no cache                                                                              |
| The probe failed instead of skipping off Linux                                                                             | Skipped with its reason before any backend starts                                               | a run with `process.platform` set to `darwin` and `win32`                                                                                             |
| A rejected transition could leave a leg waiting and an earlier `agree` record standing                                     | Deadlines on every step and side, an `incomplete` record first, partial observations on failure | `syncProbeRecord.test.ts`; no incomplete record first, a failure left unrecorded, no side deadline; and the probe under the wrong start-version plant |

### Row 7 fix round 2

- #134's round 2 (`2583a6cb`, on `main` `4fb64502`) is merged in, never
  rebased. #134's own files take #134's version, without the temporary
  disables row 7 had put on them. `Identity.test.ts`'s subscriber case no
  longer expects #134's `KernelRowPending` naming row 7: a subscriber that
  presents a token subscribes under the verified identity. Its HTTP case
  stays #134's.
- Sync never drew from `KernelRuntime.random`, which #134 removed: it signs
  nothing and draws nothing, so the world stream needs no change here.
- The snapshot body is unchanged by this row. Its contract gains the open
  sockets, the commit watchers, Sync's sessions and the sync query cache, all
  excluded or live, so this row takes no format version; #134's version 4
  stands.
- The legs, the probe and the tests are Effect programs under #140's rules.
  Every step and side is bounded by `Effect.timeoutOrElse`, clients are
  scoped resources, the binary's contention reads `convex logs` through
  Effect's `ChildProcess`, records are encoded through `Schema`, and the
  tests narrow with `assertIs`. The disables left sit on exact lines with
  their rule and reason: the `on*` handlers of the kernel's socket, a Convex
  query's `Date.now()`, and Node imports for `/proc`, hashing and temporary
  directories.

### Row 7 fix round 3

- A failed query is never cached. The binary stores a result only when its
  execution succeeded ("We do not cache JSErrors",
  `crates/application/src/cache/mod.rs:500-510`), and a client keeps a
  failure's `errorData` visible (`convex` 1.49
  `src/browser/sync/remote_query_set.ts:58-71`). So the kernel's cache stores
  successful runs only, under both the run's journal and its alias. Leg 1's
  third client also watches `sync:failingClock`, which fails with
  `ConvexError({ time: Date.now() })`: its error changes on the sign-in within
  the cache age and on the one after it, on both targets. The binary pins it
  in the probe, and the kernel's leg 1 test fails when a failure is cached.
- #134's round 3 (`f5fdcad3`) and `main` (`38ca5de4`, #151 and #152) are
  merged in, never rebased. #134 now runs an HTTP handler under an invalid
  token and lets `getUserIdentity` throw, so this row's case expecting an HTTP
  token to refuse is gone; its subscriber case stays. #134 made
  `World.authenticate` private, so a presented token reaches the verifier
  through `World.verify`, one live call as #134's own calls are.

## Randomness (row 6)

The binary gives every function a seeded generator, and `Math.random`,
`crypto.getRandomValues` and `crypto.randomUUID` draw from it in a query, a
mutation and an action alike (`crates/isolate/src/ops/random.rs:7-11`,
`ops/crypto.rs:8-31`, convex-backend `cccbade4`). A nested query or mutation
gets its own seed from its caller's generator
(`isolate/src/environment/udf/phase.rs:357-385`). A module may draw while it
loads, from a generator each push seeds once and stores in the deployment's
`UdfConfig` (`udf/phase.rs:186-193`, `action/phase.rs:184`,
`environment/analyze.rs:284`, `model/src/udf_config/types.rs:21`). Only a
module deployed without that seed refuses, with `NoRandomDuringImport`
(`udf/phase.rs:500-507`). A push of a module that calls `Math.random` or
`getRandomValues` at module scope deploys on `precompiled-2026-10-28-cccbade`.

On the kernel a bound invocation's `Math.random`, `getRandomValues` and
`randomUUID` draw from its supplied stream. `randomUUID` builds a version 4
UUID from 16 bytes of the stream, as the binary's `op_crypto_random_uuid`
builds one from 16 bytes of its generator (`ops/crypto.rs:8-12`).
`getRandomValues` answers as the binary's does rather than the host's
(`npm-packages/udf-runtime/src/00_crypto.ts:28-53`):

- a fill of more than 65,536 bytes throws `TypeError` "Byte length (N) exceeds
  the number of bytes of entropy available via this API (65536)", where Node
  throws `QuotaExceededError`;
- a non-integer array throws `TypeMismatchError` "The provided ArrayBufferView
  is not an integer array type", where Node's message differs;
- a detached or rebound call draws, where Node throws `TypeError`, because the
  binary's method never reads its receiver.

### Every function, and every kept reference

Row 1 pinned randomness through the Confect bridge, so a plain Convex query,
mutation or action, a component's function and a module an action imported
lazily read the host's sources under a bound invocation. The kernel now gives
every execution its own `Math` and `crypto` (`Entropy.ts`), placed in the copy
of the globals each function and each module load runs with (`installEntropy`
in `Execution.ts`, called from `enter` and from `World.load`). They resolve
their source on every call: the load running and its stream, or else the
running function's type and its bound invocation's stream. A reference a module
keeps while it loads therefore draws, when a handler later calls it, from that
handler's stream rather than the load's, and one kept during an open with no
world refuses nothing later. On the kernel the bridge leaves these in place.
Elsewhere it pins a handler's to its invocation as before.

A function with no invocation bound draws from the backend's own world, the
one the driver gave the backend, which for `TestConfect.layer` is the stream
its `seed` starts. A deployment JWT's signing seed resolves the same way
(#134): the bound invocation's world first, then the backend's. An unbound
`TestConfect.layer` call is therefore seeded and replays. With neither stream,
a draw refuses with `FunctionRandomUnavailable` (`componentPath`, `udfPath`),
a kernel refusal that never reads the host's. Like `RequiresBinary`, a
function can catch it, as it can the binary's own query error. The
mock-backend kernel lane's `convex-test` is a shim
(`packages/server/test/mock-backend/kernelShim.ts`) that opens each backend
under a world seeded 0, as `TestConfect.layer` does by default, so its one
case that draws, `integration.test.ts > ActionRunner > getNumberViaRunner`,
runs on the kernel. No other kernel-lane case changes its outcome under that
seed.

The kernel's `Math` and `crypto` go into each copy by assignment through
`Globals`' accessors. A test can leave a global as a property `Globals` cannot
redefine: a frozen value, or a getter with no setter, either non-configurable.
The assignment then does not take, and the copy would keep the host's sources.
`installEntropy` checks that both globals hold the kernel's after it assigns
them. If either does not, it refuses with `UnguardableGlobal` (`reason:
"notConfigurable"`, `globals`) before the load's or the function's code runs,
and its message names each global and what it holds. It never carries on with
the host's. The class is #136's, at #136's place, so the I/O guards and the
entropy install refuse alike. `test/fixtures/unguardableEntropy.ts` freezes
`Math`, freezes `crypto` or leaves `crypto` a getter, each in a process of its
own because a frozen global cannot be undone. In each case the open refuses
before the module loads. A `Math` frozen after the open makes the next function
refuse before its handler runs.

### The globals contract

For every own-descriptor shape of `Math` and `crypto`, the kernel does one of
two things. It installs its own objects and confirms that by reading the
global back. Or it refuses with `UnguardableGlobal` (`reason`, `globals`)
before any module or function code runs.

Every failure is a tagged refusal. Each global's install runs in one boundary,
`installGuarded` in `Execution.ts`, from the first read of its descriptor
(`Globals.prepare`, whose `readsThrough` calls a test's getter) through the
assignment to the read-back. A step that throws, an assignment that returns
false, or a read-back of another object becomes `UnguardableGlobal`, never a
raw error and never a carry-on. Its `reason` is `notConfigurable` when every
failing global is non-configurable, and `installFailed` otherwise, as for a
configurable getter that throws. Its message describes each global and what
was thrown through helpers that never throw (`heldAs`, `describeThrown`): each
reads behind its own try and falls back to fixed text, such as "a thrown value
that could not be described".

The kernel's own work uses the host's `Math` and `crypto`, captured once when
its modules load and before any install (`HostGlobals.ts`). That covers
building its wrappers, its `subtle`, the blinding bytes its P-256 signing draws
(`Identity.ts`, a curve built with `randomBytes` from that capture), and the
invocation bridge's `pin`. It never re-reads `globalThis`, which in a
function's copy, or in place, can hold the kernel's own wrappers. A
replacement a test installs before `@confect/test`'s first import is what the
kernel captures as the host, and that is within the contract.

Fix round 4 closed the two shapes that broke this. A `crypto` left
non-configurable but writable installs by assignment, in place, so the old
`Globals.host` read of it answered the kernel's wrapper. Signing then drew 112
stream values instead of the seed's 32, and a worldless restore refused
signing with `FunctionRandomUnavailable`. A non-configurable accessor whose
setter throws let that raw error escape the open. Both are tested in a process
of their own, and each has a plant. Fix round 5 closed the reads that still
sat outside the guard, a getter that throws, called by `readsThrough`, and an
error whose `message` getter throws, read while describing it, and made
`pin` build over the captured references. A bound Confect handler had failed
with its generic "cannot pin" error under a non-configurable but writable
`crypto`, because `pin` saw the kernel's object in place and took it for one it
had assigned. A further descriptor shape that keeps this contract is not a
finding.

Row 7's Sync serving runs every query, mutation and action through the same
`enter`, so each gets the kernel's `Math` and `crypto`. Its runs had leaked
context, though. A commit wakes a socket's update from inside the committing
mutation's turn, and the update ran in that turn's async context. So a rerun
of a query the commit invalidated drew from the committer's bound invocation's
stream, consuming the committer's draws. A frame's handling likewise ran in
the context of whatever code sent it. Each socket now keeps the async context
of the code that opened it, its client, and runs every frame and update in it.
This mirrors the binary, which runs each of a socket's requests as the
socket's own. An unbound socket's runs draw from the backend's own world, and a
socket opened under a bound invocation draws from that invocation's stream,
whoever committed or sent the frame. `World.verify` runs no user code of its
own beyond the open's module loads, which already go through the install.

One reference stays the host's. A reference taken outside every kernel copy,
before the kernel ran any code, such as a module a test file imports, keeps
what it read. That is the lazy-loading contract #136 states for `fetch` and
timers. Its setup file is not on `main`, so there is no earlier point to
install from yet.

### Cryptographic randomness

`crypto.subtle` draws from a `CryptoRng`, not the seeded generator.
`generateKey` asks for it always, `encrypt` for RSA-OAEP and `sign` for ECDSA
and RSA-PSS (`ops/subtle_crypto/mod.rs:326-333`, `:401`, `:472`;
`webcrypto/src/lib.rs:349-373`, `:478-481`, `:525-531`;
`webcrypto/src/rsa.rs:471-475`). A query's and a mutation's environment
refuses it in every phase, with `not_allowed_in_udf("CryptoRng", ...)`
(`environment/udf/mod.rs:264-272`, `:290-292`). A function sees a plain
`Error`: "Can't use cryptographic randomness in queries and mutations. Please
consider using an action. See https://docs.convex.dev/functions/actions for
more details." An action's environment gives the system's
(`environment/action/mod.rs:1576-1578`). Measured on the pinned binary, a
query and a mutation get that error at run time and from a module-scope
`generateKey`. An action generates the key in both places. A push of that
module succeeds.

The kernel rejects those operations with the binary's error in a query, a
mutation and a module load. In an action it rejects them with `RequiresBinary`
(`subtleGenerateKey`, `subtleEncrypt`, `subtleSign`): system entropy cannot be
replayed, and the kernel never draws the host's in its place. The kernel loads
each module once for every function type, so a load for an action gets the
queries' error, where the binary generates the key. Both action cases are
exact conformance entries in `packages/server/test/mock-backend/kernelBoundaries.ts`:
`ActionCryptoRandomness` and `ActionLoadCryptoRandomness`. Digest, import,
export, decrypt, verify, derivation, AES encryption with a given IV, and HMAC,
Ed25519 or RSASSA-PKCS1-v1_5 signing run as on the host in every phase.

### Load draws

The kernel holds no generator, so a module's draws while it loads come from
the driver too. `World.load` loads each module under its own copy of the
globals, whose `Math.random`, `getRandomValues` and `randomUUID` draw from the
random stream of the world the backend opens in: the bound invocation's world,
or else the world given to the backend, which for `TestConfect.layer` is the
stream its `seed` starts, the one row 5c's cron delays draw from. Modules load
one at a time, components in registration order and each component's modules
in its map's order, so the draws land in one order and a replay with the same
seed draws them again. A restore that loads the modules draws from the
restoring backend's world, as a push draws from its own seed. What a module
drew is code state, which a snapshot does not carry.

With neither world, a module that draws refuses with `LoadRandomUnavailable`
(`componentPath`, `modulePath`), and so does the open, even when the module
caught the draw. A module that draws nothing loads as before. The binary
refuses only a module deployed without a seed (`udf/phase.rs:500-507`), which
a push never is, so the refusal stands where the kernel has no seed to give,
as `CronRandomUnavailable` does for a cron's delay.

The host runtime evaluates a module once per process, so only the first
backend to load it draws. A later backend in the same test file sees the first
one's values, where each binary push draws its own.

### Boundary check

`groups/randomness` in the local-backend fixture is one Confect query, mutation
and action that each try `Math.random`, a 4-byte and a 65,536-byte fill, a
65,537-byte fill, a `Float64Array` fill, a detached fill, `randomUUID`, an HMAC
`generateKey` and a SHA-256 digest, and record whether each ran, its error and
what it produced. They also return what their module drew while it loaded:
`Math.random`, a 4-byte fill, `randomUUID` and `generateKey`.
`test/fixtures/randomnessProbe.ts` keeps what both targets fix: fill lengths,
the UUID's length and version 4 layout, the digest and every refusal. It
replaces only the values a target chooses by what they must satisfy: a draw
in (0, 1), 4 bytes not all zero, a 65,536-byte fill that is not constant. It
holds the binary's answer and the kernel's, which differs by the two entries
above. A test checks that a zero-filled replacement of any chosen value fails
it. `packages/server/test/local-backend/randomness.test.ts`
gets it from the binary and `test/Randomness.test.ts` from the kernel, which
also checks that `Math.random` and the 4-byte fill are the supplied stream's
first draws in all three function types, and that the module's load draws are
its world's stream's first draws. `test/fixtures/loadDrawReplay.ts` opens a
module that draws from all three sources while it loads, through
`TestConfect.layer` on the kernel target. `test/Randomness.test.ts` runs it in
two processes with one seed and gets the same bytes, and with another seed
gets others. `test/fixtures/handlerDrawReplay.ts` runs a plain query,
mutation and action, a component's query the host calls, and an action that
imports a drawing module lazily, each under its own bound stream. Two
processes print the same bytes, each equal to its stream's draws.
`test/Randomness.test.ts` also checks both kept-reference cases, and that a
`Math.random` kept before the kernel ran stays the host's. `test/Entropy.test.ts`
checks the `subtle` refusals for every drawing operation in every phase, and
the deterministic operations in every phase.

### Left on the binary

- The native seeding policy, as the design says.
- An action's cryptographic randomness, at run time and while a module loads
  for it (`ActionCryptoRandomness`, `ActionLoadCryptoRandomness`).
- The per-push seed itself: the kernel draws a load from the driver's stream,
  and a module evaluated once per process draws once per process.
- A nested query's or mutation's own seed: the kernel's nested call draws on
  from its caller's stream.
