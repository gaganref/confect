import * as RegisteredFunction from "@confect/server/RegisteredFunction";
import { describe, expect, it } from "@effect/vitest";
import { ConvexError } from "convex/values";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
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

  it.effect.each(errorSchemas)(
    "rejects raw ConvexError defects as plain errors $schemaLabel an error schema",
    ({ errorSchema }) =>
      Effect.promise(() => {
        const result = RegisteredFunction.runHandlerPromise(errorSchema)(
          Effect.die(new ConvexError({ secret: "x" })),
        );
        return Promise.all([
          expect(result).rejects.toBeInstanceOf(Error),
          expect(result).rejects.not.toBeInstanceOf(ConvexError),
        ]);
      }),
  );

  it.effect.each(errorSchemas)(
    "preserves the InvalidCursor signal $schemaLabel an error schema",
    ({ errorSchema }) =>
      Effect.promise(() => {
        const result = RegisteredFunction.runHandlerPromise(errorSchema)(
          Effect.die(new ConvexError({ paginationError: "InvalidCursor" })),
        );
        return Promise.all([
          expect(result).rejects.toBeInstanceOf(ConvexError),
          expect(result).rejects.toMatchObject({
            data: { paginationError: "InvalidCursor" },
          }),
        ]);
      }),
  );

  it.effect.each(errorSchemas)(
    "rejects InvalidCursor data with extra fields as a defect $schemaLabel an error schema",
    ({ errorSchema }) =>
      Effect.promise(() => {
        const result = RegisteredFunction.runHandlerPromise(errorSchema)(
          Effect.die(
            new ConvexError({ paginationError: "InvalidCursor", secret: "x" }),
          ),
        );
        return Promise.all([
          expect(result).rejects.toBeInstanceOf(Error),
          expect(result).rejects.not.toBeInstanceOf(ConvexError),
        ]);
      }),
  );

  it.effect("rejects an undeclared ConvexError failure as a plain error", () =>
    Effect.promise(() => {
      const result = RegisteredFunction.runHandlerPromise(undefined)(
        Effect.fail(new ConvexError({ secret: "x" })),
      );
      return Promise.all([
        expect(result).rejects.toBeInstanceOf(Error),
        expect(result).rejects.not.toBeInstanceOf(ConvexError),
      ]);
    }),
  );

  it.effect("rejects an inherited pagination marker as a defect", () =>
    Effect.promise(() => {
      const data = Object.setPrototypeOf(
        { secret: "x" },
        { paginationError: "InvalidCursor" },
      );
      const result = RegisteredFunction.runHandlerPromise(undefined)(
        Effect.die(new ConvexError(data)),
      );
      return Promise.all([
        expect(result).rejects.toBeInstanceOf(Error),
        expect(result).rejects.not.toBeInstanceOf(ConvexError),
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

  it.effect("keeps a defect alongside a declared failure", () =>
    Effect.promise(() => {
      const result = RegisteredFunction.runHandlerPromise(Schema.String)(
        Effect.failCause(
          Cause.combine(Cause.fail("rejected"), Cause.die(new Error("bug"))),
        ),
      );
      return Promise.all([
        expect(result).rejects.toBeInstanceOf(Error),
        expect(result).rejects.not.toBeInstanceOf(ConvexError),
        expect(result).rejects.toThrow("bug"),
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
      label: "multiple declared failures",
      cause: Cause.combine(Cause.fail("first"), Cause.fail("second")),
      message: "second",
      reasons: [{ _tag: "Fail" }, { _tag: "Fail" }],
    },
    {
      label: "a declared failure and interruption",
      cause: Cause.combine(Cause.fail("rejected"), Cause.interrupt()),
      message: "rejected",
      reasons: [{ _tag: "Fail" }, { _tag: "Interrupt" }],
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

  it.effect("preserves a plain handler defect", () =>
    Effect.promise(() => {
      const bug = new Error("bug");
      return expect(
        RegisteredFunction.runHandlerPromise(Schema.String)(Effect.die(bug)),
      ).rejects.toBe(bug);
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
              return yield* Logger.CurrentLoggers;
            }).pipe(Effect.provideService(Console.Console, console)),
          ),
        );
        expect(loggers.has(Logger.tracerLogger)).toBe(true);
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
