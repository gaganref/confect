import { recording } from "./internal/recording";
import * as RegisteredFunction from "@confect/server/RegisteredFunction";
import { assert, describe, expect, it } from "@effect/vitest";
import { ConvexError } from "convex/values";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as ConvexLogger from "@confect/server/ConvexLogger";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as TestConsole from "effect/testing/TestConsole";
import { vi } from "vitest";

describe("runHandlerPromise", () => {
  const errorSchemas = [
    { schemaLabel: "without", errorSchema: undefined },
    { schemaLabel: "with", errorSchema: Schema.String },
  ];

  describe.each(errorSchemas)(
    "$schemaLabel an error schema",
    ({ errorSchema }) => {
      it.effect.each([
        {
          signal: "Workpool NonRetryableError",
          data: { __convexWorkpoolNonRetryable: true, message: "stop" },
        },
        {
          signal: "Convex native InvalidCursor",
          data: { isConvexSystemError: true, paginationError: "InvalidCursor" },
        },
        {
          signal: "Confect InvalidCursor",
          data: { paginationError: "InvalidCursor" },
        },
        { signal: "arbitrary ConvexError", data: { code: "X" } },
      ])("rethrows the $signal defect bare with its data", ({ data }) =>
        Effect.promise(() => {
          const defect = new ConvexError(data);
          const result = RegisteredFunction.runHandlerPromise(errorSchema)(
            Effect.die(defect),
          );
          return Promise.all([
            expect(result).rejects.toBe(defect),
            expect(result).rejects.toHaveProperty("data", data),
          ]);
        }),
      );

      it.effect("rejects other defects as plain errors", () =>
        Effect.promise(() => {
          const result = RegisteredFunction.runHandlerPromise(errorSchema)(
            Effect.die(new Error("bug")),
          );
          return Promise.all([
            expect(result).rejects.toThrow("bug"),
            expect(result).rejects.not.toBeInstanceOf(ConvexError),
          ]);
        }),
      );
    },
  );

  it.effect("rethrows an undeclared ConvexError failure bare", () =>
    Effect.promise(() => {
      const failure = new ConvexError({ code: "X" });
      const result = RegisteredFunction.runHandlerPromise(undefined)(
        Effect.fail(failure),
      );
      return Promise.all([
        expect(result).rejects.toBe(failure),
        expect(result).rejects.toHaveProperty("data", { code: "X" }),
      ]);
    }),
  );

  it.effect("encodes declared errors as ConvexError data", () =>
    Effect.promise(() => {
      const result = RegisteredFunction.runHandlerPromise(
        Schema.FiniteFromString,
      )(Effect.fail(42));
      return Promise.all([
        expect(result).rejects.toBeInstanceOf(ConvexError),
        expect(result).rejects.toMatchObject({ data: "42" }),
      ]);
    }),
  );

  it.effect.each(errorSchemas)(
    "keeps a defect alongside a typed failure $schemaLabel an error schema",
    ({ errorSchema }) =>
      Effect.promise(() => {
        const result = RegisteredFunction.runHandlerPromise(errorSchema)(
          Effect.failCause(
            Cause.combine(Cause.fail("rejected"), Cause.die(new Error("bug"))),
          ),
        );
        return Promise.all([
          expect(result).rejects.toBeInstanceOf(Error),
          expect(result).rejects.not.toBeInstanceOf(ConvexError),
          expect(result).rejects.toThrow("bug"),
          expect(result).rejects.toMatchObject({
            cause: {
              reasons: [{ _tag: "Fail", error: "rejected" }, { _tag: "Die" }],
            },
          }),
        ]);
      }),
  );

  it.effect("encodes the first of two concurrent declared failures", () =>
    Effect.promise(() => {
      const errorSchema = Schema.TaggedStruct("PaymentDeclined", {
        invoice: Schema.String,
      });
      const branch = (invoice: string) =>
        Effect.promise(() => Promise.resolve()).pipe(
          Effect.andThen(Effect.fail({ _tag: "PaymentDeclined", invoice })),
          Effect.uninterruptible,
        );
      const result = RegisteredFunction.runHandlerPromise(errorSchema)(
        Effect.all([branch("invoice-1"), branch("invoice-2")], {
          concurrency: 2,
        }),
      );
      return Promise.all([
        expect(result).rejects.toBeInstanceOf(ConvexError),
        expect(result).rejects.toMatchObject({
          data: { _tag: "PaymentDeclined", invoice: "invoice-1" },
        }),
      ]);
    }),
  );

  it.effect(
    "encodes a declared failure alongside a concurrent interruption",
    () =>
      Effect.promise(() => {
        const failure = Effect.promise(() => Promise.resolve()).pipe(
          Effect.andThen(Effect.fail("rejected")),
          Effect.uninterruptible,
        );
        const result = RegisteredFunction.runHandlerPromise(Schema.String)(
          Effect.all([failure, Effect.interrupt], { concurrency: 2 }),
        );
        return Promise.all([
          expect(result).rejects.toBeInstanceOf(ConvexError),
          expect(result).rejects.toMatchObject({ data: "rejected" }),
        ]);
      }),
  );

  it.effect.each([
    {
      label: "a defect before a declared failure",
      cause: Cause.combine(Cause.die(new Error("bug")), Cause.fail("rejected")),
      message: "bug",
      reasons: [{ _tag: "Die" }, { _tag: "Fail" }],
    },
    {
      label: "a declared failure and a Workpool non-retryable defect",
      cause: Cause.combine(
        Cause.fail("rejected"),
        Cause.die(
          new ConvexError({
            __convexWorkpoolNonRetryable: true,
            message: "stop",
          }),
        ),
      ),
      message: "stop",
      reasons: [{ _tag: "Fail" }, { _tag: "Die" }],
    },
    {
      label: "a pagination signal and a defect",
      cause: Cause.combine(
        Cause.die(new ConvexError({ paginationError: "InvalidCursor" })),
        Cause.die(new Error("bug")),
      ),
      message: "bug",
      reasons: [{ _tag: "Die" }, { _tag: "Die" }],
    },
    {
      label: "a pagination signal and interruption",
      cause: Cause.combine(
        Cause.die(new ConvexError({ paginationError: "InvalidCursor" })),
        Cause.interrupt(),
      ),
      message: "InvalidCursor",
      reasons: [{ _tag: "Die" }, { _tag: "Interrupt" }],
    },
    {
      label: "interruption alone",
      cause: Cause.interrupt(),
      message: "interrupted",
      reasons: [{ _tag: "Interrupt" }],
    },
  ])("treats $label as a defect", ({ cause, message, reasons }) =>
    Effect.promise(() => {
      const result = RegisteredFunction.runHandlerPromise(Schema.String)(
        Effect.failCause(cause),
      );
      return Promise.all([
        expect(result).rejects.toBeInstanceOf(Error),
        expect(result).rejects.not.toBeInstanceOf(ConvexError),
        expect(result).rejects.toThrow(message),
        expect(result).rejects.toMatchObject({ cause: { reasons } }),
      ]);
    }),
  );

  it.effect("treats an invalid declared error as a defect", () =>
    Effect.promise(() => {
      const result = RegisteredFunction.runHandlerPromise(Schema.String)(
        Effect.fail(42),
      );
      return Promise.all([
        expect(result).rejects.toBeInstanceOf(Error),
        expect(result).rejects.not.toBeInstanceOf(ConvexError),
        expect(result).rejects.toThrow("Expected string"),
        expect(result).rejects.toMatchObject({
          cause: {
            reasons: [
              {
                _tag: "Fail",
                error: {
                  _tag: "SchemaError",
                  issue: { _tag: "InvalidType" },
                },
              },
            ],
          },
        }),
      ]);
    }),
  );

  it.effect("treats a pagination signal from error encoding as a defect", () =>
    Effect.promise(() => {
      const errorSchema = Schema.String.pipe(
        Schema.decodeTo(Schema.String, {
          decode: SchemaGetter.passthrough(),
          encode: SchemaGetter.transformEffect(() =>
            Effect.die(new ConvexError({ paginationError: "InvalidCursor" })),
          ),
        }),
      );
      const result = RegisteredFunction.runHandlerPromise(errorSchema)(
        Effect.fail("rejected"),
      );
      return Promise.all([
        expect(result).rejects.toBeInstanceOf(Error),
        expect(result).rejects.not.toBeInstanceOf(ConvexError),
        expect(result).rejects.toThrow("InvalidCursor"),
        expect(result).rejects.toMatchObject({
          cause: {
            reasons: [
              {
                _tag: "Die",
                defect: { data: { paginationError: "InvalidCursor" } },
              },
            ],
          },
        }),
      ]);
    }),
  );

  it.effect("preserves a successful handler value", () =>
    Effect.promise(() =>
      expect(
        RegisteredFunction.runHandlerPromise(Schema.String)(
          Effect.succeed({ answer: 42 }),
        ),
      ).resolves.toEqual({ answer: 42 }),
    ),
  );

  it.effect("preserves the complete cause of a plain handler defect", () =>
    Effect.promise(() => {
      const bug = new Error("bug");
      const cause = Cause.die(bug);
      const result = RegisteredFunction.runHandlerPromise(Schema.String)(
        Effect.failCause(cause),
      );
      return Promise.all([
        expect(result).rejects.toThrow("bug"),
        expect(result).rejects.toHaveProperty("cause", cause),
      ]);
    }),
  );

  it.effect("keeps the captured console across overlapping invocations", () =>
    Effect.gen(function* () {
      const original = globalThis.console;
      const first = { ...original, info: vi.fn() };
      const second = { ...original, info: vi.fn() };
      const release = yield* Deferred.make<void>();
      const run = RegisteredFunction.runHandlerPromise(undefined);
      yield* Effect.promise(() => {
        globalThis.console = first;
        const firstResult = run(
          Deferred.await(release).pipe(Effect.andThen(Effect.log("first"))),
        );
        globalThis.console = second;
        const secondResult = run(Effect.log("second")).finally(() =>
          Deferred.doneUnsafe(release, Effect.void),
        );
        return Promise.all([firstResult, secondResult]).finally(() => {
          globalThis.console = original;
        });
      });
      expect(first.info).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: "first" }),
      );
      expect(second.info).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: "second" }),
      );
    }),
  );

  it.effect(
    "binds each invocation's console even after Effect caches a default",
    () =>
      Effect.gen(function* () {
        const original = globalThis.console;
        Context.get(Context.empty(), Console.Console);
        const first = { ...original, info: vi.fn(), log: vi.fn() };
        const second = { ...original, info: vi.fn(), log: vi.fn() };
        const run = RegisteredFunction.runHandlerPromise(undefined);
        yield* Effect.promise(() => {
          globalThis.console = first;
          return run(Effect.log("first"))
            .then(() => {
              globalThis.console = second;
              return run(Effect.log("second"));
            })
            .finally(() => {
              globalThis.console = original;
            });
        });
        expect(first.info).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ message: "first" }),
        );
        expect(second.info).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ message: "second" }),
        );
        expect(first.log).not.toHaveBeenCalled();
        expect(second.log).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    "keeps Info filtering and tracer logging while allowing handler overrides",
    () =>
      Effect.gen(function* () {
        const console = {
          ...(yield* TestConsole.make),
          debug: vi.fn(),
          info: vi.fn(),
        };
        const run = RegisteredFunction.runHandlerPromise(undefined);
        const loggers = yield* Effect.promise(() =>
          run(
            Effect.gen(function* () {
              yield* Effect.logTrace("hidden trace");
              yield* Effect.logDebug("hidden debug");
              yield* Effect.logInfo("visible");
              expect(yield* References.MinimumLogLevel).toBe("Info");
              expect(
                (yield* Effect.context<never>()).mapUnsafe.has(Clock.Clock.key),
              ).toBe(false);
              return yield* Logger.CurrentLoggers;
            }).pipe(Effect.provideService(Console.Console, console)),
          ),
        );
        expect(loggers.has(Logger.tracerLogger)).toBe(true);
        expect(loggers.has(ConvexLogger.logger)).toBe(true);
        expect(console.debug).not.toHaveBeenCalled();
        expect(console.info).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ message: "visible" }),
        );

        const custom = vi.fn();
        yield* Effect.promise(() =>
          run(
            Effect.logInfo("custom").pipe(
              Effect.provideService(
                Logger.CurrentLoggers,
                new Set([Logger.make(custom)]),
              ),
              Effect.provideService(Console.Console, console),
            ),
          ),
        );
        expect(custom).toHaveBeenCalledOnce();
        expect(console.info).toHaveBeenCalledOnce();
      }),
  );
});

it.each([false, true])(
  "keeps origin/main client messages (instrumented %s)",
  // oxlint-disable-next-line effecttsgo/async-function -- Exercise the public Promise boundary.
  async (instrumented) => {
    const { spans, observability, invocation, lifecycle } = recording();
    const defect = new Error("broken");
    defect.stack = "Error: broken\n    at handler (app.ts:1:1)";
    const scenarios: Array<Effect.Effect<unknown, string>> = [
      Effect.die(defect),
      Effect.failCause(Cause.interrupt()),
      Effect.failCause(Cause.combine(Cause.fail("denied"), Cause.die(defect))),
      Schema.decodeEffect(Schema.FiniteFromString)("bad").pipe(Effect.orDie),
      Schema.encodeEffect(Schema.FiniteFromString)(NaN).pipe(Effect.orDie),
    ];
    const messages = await Promise.all(
      scenarios.map((effect) =>
        RegisteredFunction.runHandlerPromise(Schema.String, {
          invocation: instrumented
            ? invocation
            : Effect.die("metadata must not run"),
          observability: instrumented ? observability : undefined,
        })(effect).catch((error: Error) => error.message),
      ),
    );
    expect(messages).toEqual([
      "Error: broken\n    at handler (app.ts:1:1)",
      "InterruptError: All fibers interrupted without error {\n  [cause]: InterruptCause: The fiber was interrupted by:\n      at fiber (unknown)\n}",
      "Error: denied\nError: broken\n    at handler (app.ts:1:1)",
      "SchemaError: Expected a finite number",
      "SchemaError: Expected a finite number",
    ]);
    expect(spans).toHaveLength(instrumented ? 5 : 0);
    expect(lifecycle).toEqual({ builds: instrumented ? 1 : 0, releases: 0 });
  },
);

it.each([false, true])(
  "ends after error encoding with its final outcome (%s)",
  // oxlint-disable-next-line effecttsgo/async-function -- Exercise the public Promise boundary.
  async (broken) => {
    const { spans, messages, observability, invocation } = recording();
    const original = new Error("denied");
    const defect = new Error("encoding failed");
    const error = Schema.String.pipe(
      Schema.decodeTo(Schema.instanceOf(Error), {
        decode: SchemaGetter.transform(() => original),
        encode: SchemaGetter.transformEffect(() =>
          Effect.gen(function* () {
            yield* Effect.logWarning("encoding");
            expect(spans[0]!.status._tag).toBe("Started");
            return broken ? yield* Effect.die(defect) : "denied";
          }),
        ),
      }),
    );
    const result = RegisteredFunction.runHandlerPromise(error, {
      invocation,
      observability,
    })(Effect.fail(original));
    if (broken)
      await expect(result).rejects.toHaveProperty("message", defect.stack);
    else await expect(result).rejects.toHaveProperty("data", "denied");
    expect(messages).toEqual([["encoding"]]);
    const status = spans[0]!.status;
    expect(spans[0]!.attributes.get("componentPath")).toBe("counter");
    assert(status._tag === "Ended" && Exit.isFailure(status.exit));
    expect(Cause.squash(status.exit.cause)).toBe(broken ? defect : original);
  },
);

it.each([false, true])(
  "ends an undeclared failure as a defect (instrumented %s)",
  // oxlint-disable-next-line effecttsgo/async-function -- Exercise the public Promise boundary.
  async (instrumented) => {
    const { spans, observability, invocation } = recording();
    const undeclared = new Error("undeclared");
    const signal = new ConvexError({ paginationError: "InvalidCursor" });
    const run = (effect: Effect.Effect<never, Error>) =>
      RegisteredFunction.runHandlerPromise(undefined, {
        invocation: instrumented ? invocation : Effect.die("unused"),
        observability: instrumented ? observability : undefined,
      })(effect).catch((error: unknown) => error);
    expect(await run(Effect.fail(undeclared))).toBe(undeclared);
    expect(await run(Effect.fail(signal))).toBe(signal);
    if (!instrumented) return;
    const [failed, passed] = spans.map(({ status }) => {
      assert(status._tag === "Ended" && Exit.isFailure(status.exit));
      return status.exit.cause.reasons;
    });
    expect(failed).toEqual([
      expect.objectContaining({ _tag: "Die", defect: undeclared }),
    ]);
    expect(passed).toEqual([
      expect.objectContaining({ _tag: "Fail", error: signal }),
    ]);
  },
);
