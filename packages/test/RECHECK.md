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
supplies them. Row 5 lifts the scheduling refusals, and the limits row lifts
the transaction limits refusal. Text and vector search
refuse with `RequiresBinary`.

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

Open: Convex's own `crons.ts` schedules are not simulated, though the design's
kernel scope lists declared schedules. convex-test does not run them either, and
no inventory case or row-5 check uses them. A raw host timer in a handler is row
6's I/O ban.

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
component. On the local-backend fixture a root mutation starts at 19, its first
nested call adds 2, and a stale-snapshot query starts at 19 again. That share
depends on the deployment, so the kernel does not simulate it.

Each read maps a total `x` to `max(0, x - before) + after`, which never
decreases and never moves two totals apart. So the binary's count stays between
the kernel's and the kernel's plus the system share:

- While neither count saturates, the binary's is exactly the kernel's plus the
  share, and the binary refuses `TooManyReads` that many reads sooner.
- A read that covers inserted IDs can saturate only the kernel's lower count,
  and the gap shrinks. One insert and a read of its ID answer 19 on the binary
  and 1 on the kernel, a gap of 18.
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
