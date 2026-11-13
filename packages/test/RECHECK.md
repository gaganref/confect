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

A function in a component runs with no identity, whoever called it, since
Convex gives a component no `ctx.auth` of its caller's. A nested call in the
host takes its parent's identity, even when that is none, and a test's caller
reaches only the function the test called.

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

## I/O bans (row 6)

Convex refuses I/O inside a query or mutation. At the local backend's pinned
`precompiled-2026-10-28-cccbade` (convex-backend `cccbade4`), a query's or
mutation's async op is refused by `start_async_op`
(`crates/isolate/src/environment/udf/mod.rs:367-375`) with
`not_allowed_in_udf` (`:264-272`): `No{Name}InQueriesOrMutations`, "Can't use
{description} in queries and mutations. Please consider using an action. See
https://docs.convex.dev/functions/actions for more details." The names and
descriptions are `AsyncOpRequest::name_for_error` and `description_for_error`
(`crates/isolate/src/environment/async_op.rs:47-66`). The error reaches
JavaScript as a plain, catchable `Error` with that message
(`handle_syscall_or_op_error` in `crates/isolate/src/request_scope.rs`).

- `fetch(url)` goes through `fetchWithoutRedirect`, which rewraps the op error
  as a `TypeError` naming the target without its query string:
  `fetch to <origin><path> failed: Can't use fetch() in queries and mutations.
  …` (`npm-packages/udf-runtime/src/26_fetch.ts:78-113`). The handler can catch
  it and go on.
- `setTimeout` and `setInterval` return their ID, then their sleep op rejects
  with no handler (`02_timers.ts:64-80`), so the function ends with "Can't use
  setTimeout in queries and mutations. …" at its next microtask checkpoint
  (`run_inner`'s unhandled rejection check, `udf/mod.rs:1121-1137`), whatever
  the handler catches. `clearTimeout` and `clearInterval` are plain map
  deletes and are allowed.
- `formData()` on a multipart body with a boundary goes through
  `parseFormData`'s `form/parseMultiPart` op, refused as `NoFormParse…`: the
  call rejects with a plain `Error`, "Can't use formData() in queries and
  mutations. …", after the body is read (`21_formdata.ts:126-150`,
  `23_request.ts:220-224`, `23_response.ts:203-207`). A multipart type without
  a boundary is a `TypeError`, "Missing boundary parameter in mime type of
  multipart formdata.", and a urlencoded body parses in JavaScript and is
  allowed. A handler reaches this with the runtime's own `Request` and
  `Response`, so the kernel guards it.
- The isolate defines no `setImmediate` and no `queueMicrotask`
  (`npm-packages/udf-runtime/src/setup.ts:32-66` installs neither, and V8
  provides neither), in queries, mutations and actions alike. A Node action
  runs in Node and has both.

The kernel's `src/internal/IoBans.ts` makes each of `fetch`, `setTimeout`,
`setInterval`, `setImmediate` and `queueMicrotask` an accessor on `globalThis`,
as `Globals.ts` does for `Date`, `Math` and `crypto`. It reads as a guard of the
implementation beneath, one guard per implementation, and a guard checks the
kernel function running in the caller's async context at every call. An
assignment stores the new implementation beneath, so a stub or a handler that
assigns the global mid-invocation is still guarded, and assigning a guard back,
as fake timers do when they uninstall, stores the implementation it guards. A
reference keeps the implementation it was read with, as a kept reference to
the host's function would: convex-test keeps the real `setTimeout` when it
loads (`dist/index.js:2205`) and yields on it beside fake timers, so a single
guard that followed the fakes made its drain loop forever. `formData()` is guarded on `Request`'s
and `Response`'s prototypes. `@confect/test/setup` (`src/setup.ts`), a Vitest
setup file, installs the guards before any test module loads, so a reference a
module takes when it is imported is the guard. The kernel installs them again
when a world opens and whenever a function starts, which guards again a global
a test redefined with `Object.defineProperty`, as `vi.stubGlobal` does.

Whenever a kernel function starts, the kernel checks each guarded global's
descriptor. A replacement a test made, by `Object.defineProperty`, by `delete`
and a fresh assignment, or by `vi.stubGlobal`, becomes the implementation
beneath a fresh guard, so a stub keeps working outside a function and stays
refused inside one. A replacement the kernel cannot redefine, a non-configurable
one, refuses the function before it runs with `UnguardableGlobal`
(`reason: "notConfigurable"`) naming the global. A timer's promisified form (`util.promisify(setTimeout)`, which reads
`util.promisify.custom`) is guarded too, and ends a query or mutation as the
timer does.

A descriptor replaced while a function runs, such as a handler's
`Object.defineProperty(globalThis, "fetch", …)`, takes the global out from under
its guard until the next entry, so a call made through the replacement is not
blocked. The kernel is a parity aid, not a sandbox: such a call needs a
deliberate redefinition of a global mid-invocation, and the guards never hand
out the host's raw function. Locking the descriptors while a function runs would
need them non-configurable, which cannot be undone and would break stubbing
between tests, and running handlers in their own VM realm is out of scope. So
the escape is always reported instead: each function's entry records the
guarded descriptors (`IoBans.watch`), and when the function settles, returned,
failed or ended, the kernel compares them. A changed descriptor fails the
function with `UnguardableGlobal` (`reason: "replacedWhileRunning"`) naming the
global, whatever it returned, before a mutation's commit point, so a mutation
publishes none of its writes, and the guard is installed again. An accessor
another library lays over a guard, as convex-test lays its own before each of
its handlers (`index.ts:3054-3060` at 0.0.65), still reads through the guard
and is no replacement. An assignment stores beneath the guard and replaces
nothing. Remaining window: a call made between a mid-invocation replacement and
the function's settlement reaches the replacement unchecked, and the function is
always reported for it.

The exemption for Node's own modules reads the caller with `util.getCallSites`
(Node 22.9 and later), kept when `IoBans.ts` loads, which does not go through
`Error.prepareStackTrace`, so a user's override cannot fake it. The caller is
the first frame outside `IoBans.ts`, and it must be one of the exact `node:`
URLs the kernel's suites showed reading these globals: only
`node:internal/deps/undici/undici`, Node's `fetch`, `Request` and `Response`. A
script that names itself after a Node module does not pass.

A module's runtime comes from its `"use node"` directive, read from its source
when the world opens, as the bundler's `determineEnvironment` decides
(`npm-packages/convex/src/bundler/index.ts:558-588`, with the directive from
Babel's `program.directives` at `:508-548`). The test supplies the sources as a
`?raw` glob of the same files from any test file, matched to its module by
its path below the directory that holds `_generated`, through the kernel
shim's `sources`,
`registerComponent`'s `{ sources }`, a component kit's `sources`, or the
`sources` option of each of `TestConfect.layer`'s three forms. A generated
registry may carry them too, and a layer's own option takes their place. With
sources, every function module needs one, `"use node"` in `http`, `crons`,
`schema` or `auth.config` is refused with the bundler's message
(`mustBeIsolate`, `:551-574`), and Confect's mark is a cross-check: a Confect
Node action in a module without the directive, or a Confect isolate action in a
module with it, is refused with `ModuleRuntime` (`reason: "markerDisagrees"`).

Without sources, Confect's mark decides a Confect action's runtime, and a plain
Convex action has none the kernel can tell. So when the world opens, a component
with no sources whose modules export an action with no mark is refused with
`ActionRuntimeUnknown`, naming the component, the module and its exports, before
any function runs. A package's test kit registers its modules without sources
(`@convex-dev/workflow`'s registers Workpool, whose `worker:runActionWrapper` is
a plain action), and a test cannot add them, so the layer and the kernel shim
take `componentRuntimes`, the runtime each listed component's plain actions run
in, such as `{ "workflow/workpool": "isolate" }`. The refusal's message names
the option. Build-order row 8's generated test subject supplies the modules'
sources and emits these declarations for package mounts from each kit's
metadata. The fork's mock-backend layer passes sources.

- In a query or mutation: `fetch` rejects with the binary's `TypeError`; a
  timer returns an ID and ends its function; multipart `formData()` rejects
  with the binary's error.
- In a query, a mutation or an isolate action, `setImmediate` and
  `queueMicrotask` read `undefined`, and a reference to either taken earlier
  throws `ReferenceError: <name> is not defined`. Node's own modules still find
  them: its `fetch` and web streams read and call `queueMicrotask` while doing a
  function's work, where the binary's built-ins need neither, so the guard
  checks whether the calling frame is a `node:` module.
- A Node action has Node's globals. `@confect/server` marks the actions it
  registers with `Symbol.for("@confect/server/NodeAction")`: `true` from
  `RegisteredNodeFunction.make`, `false` from `RegisteredConvexFunction`, since
  a module's `"use node"` directive is gone once it loads. A plain Convex action
  carries no mark, and its runtime comes from its module's source or its
  component's declared runtime.

A timer ends its function through `Execution.ts`'s `endings`. Each running
function has an ending signal, and its invocation settles with the ending as
soon as it fires, so a handler that awaits its timer fails promptly with the
binary's message instead of hanging, and a mutation publishes none of its
writes.

`test/IoBans.test.ts` runs each call on the kernel, and
`packages/server/test/local-backend/ioBans.test.ts` runs the same calls on the
binary through `LocalBackend.ts`: the fetch, timer and awaited-timer
refusals, both globals' absence in a query and an isolate action and their
presence in a Node action, the clears, the multipart, boundaryless and
urlencoded `formData()` cases, and an action's fetch and timers.

convex-test 0.0.65 disagrees with the binary here and the kernel follows the
binary: its `disallowedInTransaction` throws "`fetch` is not supported in Convex
queries or mutations…" synchronously, and it also refuses `clearTimeout` and
`clearInterval` (`index.ts:2929-2968`).

Open: a reference to one of these globals taken before `@confect/test/setup`
runs, by an earlier setup file or a global setup, stays the host's. The test
project's Vitest config owns the order, and for Frame that is the generated
test backend's preset (row 8), which lists the setup file first. A test that
does not list it still gets the guards from the first world that opens, so only
a reference taken before then escapes.

Not covered: storage and stream ops are also refused in a query or mutation;
their rows are storage and HTTP. Cryptographic randomness
(`crypto.subtle.generateKey` and the algorithms that draw from `crypto_rng`,
`udf/mod.rs:290-292`) belongs to the randomness row. Effect picks its
scheduler's timer from the host realm when it loads, and its scheduler falls
back to a microtask when `setImmediate` reads `undefined`, where the binary's
would use `setTimeout`. Confect's queries and mutations run on Effect's
`"sync"` scheduler (`RegisteredConvexFunction.ts:268`, `:385`), which sets no
timer.

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
are conformance exceptions in the convex-test lane. #137 moved them from
`vitest.mock-backend.config.ts`'s file exclusions into `conformance.ts`, the
lane's one mechanism: each case now runs on convex-test, records the fetch's
outcome (`fetchOutcome` in `serverError.ts`: the response's status, or the
rejection's tag and message) and asserts the binary's 500 through `departs`, so
the lane takes its failure only for that departure, with the recorded outcome,
`Error` "The route failed." and `ConvexError` `{"code":"denied","attempt":2}`
on convex-test 0.0.67. The body check runs where there is a response. The
mounted case runs on both lanes, since the bridge is the adapter's own.

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

## Action egress (row 6)

The binary performs a raw `fetch` in an action. An action's `start_async_op`
starts it as a task (`crates/isolate/src/environment/action/mod.rs:1639-1645`),
which `task_executor.rs:151` hands to `run_fetch` (`action/fetch.rs:34`). Only a
cloud proxy's 407 refuses a host (`crates/http_client/src/lib.rs:131-134`), and
a local backend has none. A Node action runs in Node, where `fetch` is Node's.
`packages/server/test/local-backend/egress.test.ts` shows both on the pinned
binary: an action and a Node action each reach a loopback server.

The kernel departs from this on purpose, its one deliberate departure. A raw
`fetch` in an action, a Node action included, dies with `BackendRefusal`
`UndeclaredFetch` (`src/internal/KernelRefusal.ts`). It names the action's
component path, its `module:export` and the URL's host, with `failed`,
`because`, `instead` and a `docs` anchor. The call rejects with it, and the
action ends through the same ending signal as a timer in a query: it settles
with the refusal at once, whatever its handler catches and whether or not the
handler ever settles, and runs no later syscall, `ctx.runQuery`,
`ctx.runMutation` or `ctx.runAction`. The fetch never leaves the process.

A function's later `console` calls are dropped once it has settled, whether
it returned, failed or was ended. On the binary none of its JavaScript runs
after that: an action's run loop (`action/mod.rs:1043`) breaks once its promise
rejects (`:1125-1128`) or its result is collected (`:1151`), so no later call
reaches `trace` (`:1545-1570`), the only way an action logs, and a query's or
mutation's `run_inner` loop (`udf/mod.rs:1113`) stops the same way. The kernel
cannot stop a handler, so `IoBans.ts` wraps `console`'s methods and drops what a
settled function logs, a continuation released after an isolate action
returned included.

Egress goes through a provider port (`src/internal/Egress.ts`). Inside a kernel
action a port's call is held as a `{ kind: "provider", port, input }` command,
listed by the shim's `commands()` and settled by `answer(id, output)`. Each
command belongs to its action. Once the action ends, by a refusal or by
settling on its own, a port call it makes is refused (with its refusal, or
`ActionEnded`), its held commands are cancelled and never settle, and an answer
to a cancelled command is refused with `StaleCommand` `cancelled`. An answer to
a command already answered or never held is `StaleCommand` `notHeld`. A
snapshot carries the command allocator (`identity.nextCommandId`) and the
cancelled commands (`cancelledCommands`), so after a restore the next command's
ID and a stale answer's reason are the uninterrupted run's. It refuses an
allocator at or behind a cancelled command's number, and a cancelled ID the
kernel never mints. Held commands stay out: a snapshot waits for every function
to settle, and an action's commands close with it. The format is
`confect-kernel-snapshot 4`. In a query
or mutation, outside the kernel and in production, a port calls its live
provider, whose own `fetch` the I/O bans then answer as the binary does. The
kernel finds ports through `Symbol.for("@confect/test/Egress")` on `globalThis`,
as `@confect/server` finds the invocation bridge, so a port defined outside this
package holds the same way.

`test/mock-backend/egress.test.ts` asserts the refusal for a Confect action and
a Confect Node action. It passes in the kernel lane. In the convex-test lane,
where convex-test performs the fetch as the binary does, it is one of the
lane's three conformance exceptions (`test/mock-backend/conformance.ts`),
re-checked on convex-test 0.0.67, and the only one where the kernel departs
from the binary; in the other two, the route errors above, convex-test does.
Its entry names one exact case, the
binary behaviour, the outcome each function it calls has there (both return
`reached /ping`), an owner, the convex-test version and the evidence above. The
case records each function's outcome, a return value or an error's tag and
message, before it asserts. Its departure assertion runs through `departs`, which
records the failure's message and the file that called it. The lane takes the
failure for the departure only when the case failed with exactly that one
error, from its own file, with the message the entry pins (`departure`), and
the recorded outcomes match. It checks in `onTestFinished`, after every hook,
since an `afterEach` that throws stops the hooks after it: a failing hook adds
an error of its own and fails the lane. `convexTestLane.ts` refuses an entry that names a
describe block, a pattern, no case, a missing file or another convex-test
version, or expects no outcome. An excepted case that passes on convex-test
fails the lane ("Expect test to fail"). One that records other outcomes, or
fails on anything but its own assertions, keeps its own failure, so an unrelated
throw in one action is not taken for the departure. One that did not run, skipped or filtered out of a run that includes its
file, fails the run through `conformanceReporter.ts`, since Vitest runs no hook
of a file whose cases are all skipped.

Not covered: Node's `http`, `https`, `net` and `tls` modules in a Node action
are not intercepted. The row names `fetch`.

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
component. That share depends on the deployment's modules: a root mutation on the
local-backend fixture has started at 19, 20 and 21 as groups were added,
`groups/ioBans` among them. So the kernel does not
simulate it, and the probes no longer pin it. `groups/transactions:systemShare`,
a mutation that touches no user table, measures it on the binary at run time:
a root mutation's count at its start, what its first nested call adds, and a
stale-snapshot query's count at its start. The kernel answers 0 for each, and
each probe compares the binary less the measured share with the kernel.

Each read maps a total `x` to `max(0, x - before) + after`, which never
decreases and never moves two totals apart. So the binary's count stays between
the kernel's and the kernel's plus the system share:

- While neither count saturates, the binary's is exactly the kernel's plus the
  share, and the binary refuses `TooManyReads` that many reads sooner.
- A read that covers inserted IDs can saturate only the kernel's lower count,
  and the gap shrinks. One insert and a read of its ID answer the root share on
  the binary and 1 on the kernel, a gap of the share less 1. These saturation
  checks stay separate from the additive ones, since there the share is no
  constant offset.
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
