import type { FunctionReference_future } from "convex/server";
import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { describe, expect, expectTypeOf, it, test } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as MutableRef from "effect/MutableRef";
import * as Schema from "effect/Schema";
import { vi } from "vitest";

import * as Callback from "@confect/core/Callback";
import * as FunctionSpec from "@confect/core/FunctionSpec";
import * as GroupSpec from "@confect/core/GroupSpec";
import * as Ref from "@confect/core/Ref";
import * as Refs from "@confect/core/Refs";
import * as SchemaToValidator from "@confect/core/SchemaToValidator";
import * as TestSpec from "./TestSpec";

class EventRejected extends Schema.TaggedError<EventRejected>()(
  "EventRejected",
  { reason: Schema.String },
) {}

const Status = Schema.Literals(["queued", "sent", "bounced"]);

const OnEvent = Callback.mutation("counter/onEvent", {
  args: () => ({ run: Schema.String, status: Status }),
  returns: () => Schema.FiniteFromString,
  error: () => EventRejected,
});

const Other = Callback.mutation("other/onEvent", {
  args: () => ({ run: Schema.String, status: Status }),
  returns: () => Schema.FiniteFromString,
  error: () => EventRejected,
});

const handleText = "function://;callbacks:onEvent";

describe("contract", () => {
  test("declaring a contract and a spec that stores its handle builds no schema", () => {
    const args = vi.fn(() => ({ run: Schema.String }));
    const returns = vi.fn(() => Schema.Null);
    const error = vi.fn(() => EventRejected);
    const Lazy = Callback.action("lazy/onEvent", { args, returns, error });

    const spec = TestSpec.fromGroups({
      deliveries: GroupSpec.make().addFunction(
        FunctionSpec.publicMutation({
          name: "send",
          args: () => ({ onEvent: Callback.handle(Lazy) }),
          returns: () => Schema.Null,
        }),
      ),
    });
    const refs = Refs.make(spec);
    const handle = Callback.handle(Lazy);

    expect([
      args.mock.calls.length,
      returns.mock.calls.length,
      error.mock.calls.length,
    ]).toEqual([0, 0, 0]);
    expect(Ref.getConvexFunctionName(refs.public.deliveries.send)).toBe(
      "deliveries:send",
    );
    expect(Schema.decodeSync(handle)(handleText).convexFunctionName).toBe(
      handleText,
    );
  });

  test("an id names the component and the event", () => {
    // @ts-expect-error a contract id is "<component>/<event>"
    Callback.mutation("onEvent", { returns: () => Schema.Null });
    expect(OnEvent.id).toBe("counter/onEvent");
    expect(OnEvent.functionType).toBe("mutation");
  });
});

describe("handle", () => {
  it.effect(
    "decodes a handle string to a ref that runs it through the contract's codecs",
    () =>
      Effect.gen(function* () {
        const handle = yield* Schema.decodeEffect(Callback.handle(OnEvent))(
          handleText,
        );
        const seen = MutableRef.make<ReadonlyArray<unknown>>([]);
        const result = yield* Ref.runWithCodec(
          handle,
          { run: "a", status: "sent" },
          (functionReference, encodedArgs) => {
            MutableRef.set(seen, [functionReference, encodedArgs]);
            return Promise.resolve("7");
          },
        );
        expect(result).toBe(7);
        expect(MutableRef.get(seen)).toEqual([
          handleText,
          { run: "a", status: "sent" },
        ]);
      }),
  );

  it.effect("delivers the contract's declared error by tag", () =>
    Effect.gen(function* () {
      const handle = yield* Schema.decodeEffect(Callback.handle(OnEvent))(
        handleText,
      );
      const reason = yield* Ref.runWithCodec(
        handle,
        { run: "a", status: "bounced" },
        () =>
          Promise.reject(
            new ConvexError({ _tag: "EventRejected", reason: "bounced" }),
          ),
      ).pipe(
        Effect.as("accepted"),
        Effect.catchTag("EventRejected", (error) =>
          Effect.succeed(error.reason),
        ),
      );
      expect(reason).toBe("bounced");
    }),
  );

  it.effect("encodes a handle back to its string", () =>
    Effect.gen(function* () {
      const codec = Callback.handle(OnEvent);
      const handle = yield* Schema.decodeEffect(codec)(handleText);
      expect(yield* Schema.encodeEffect(codec)(handle)).toBe(handleText);
    }),
  );

  it.effect("refuses to encode a handle made for another contract", () =>
    Effect.gen(function* () {
      const other = yield* Schema.decodeEffect(Callback.handle(Other))(
        handleText,
      );
      const exit = yield* Effect.exit(
        Schema.encodeUnknownEffect(Callback.handle(OnEvent))(other),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const own = yield* Schema.decodeEffect(Callback.handle(Other))(
        handleText,
      );
      expect(yield* Schema.encodeEffect(Callback.handle(Other))(own)).toBe(
        handleText,
      );
    }),
  );

  test("compiles to a string validator", () => {
    expect(
      SchemaToValidator.compileArgsSchema(
        Schema.Struct({ onEvent: Callback.handle(OnEvent) }),
      ),
    ).toEqual({ onEvent: v.string() });
  });

  test("toFuture keeps the handle's reference", () => {
    const handle = Schema.decodeSync(Callback.handle(OnEvent))(handleText);
    expect(Callback.toFuture(handle)).toBe(handleText);
  });
});

describe("types", () => {
  type Handle = Callback.Handle<typeof OnEvent>;

  test("a handle runs with the contract's args, returns and error", () => {
    expectTypeOf<Ref.Args<Handle>>().toEqualTypeOf<
      Callback.Args<typeof OnEvent>
    >();
    expectTypeOf<Callback.Args<typeof OnEvent>>().toEqualTypeOf<{
      readonly run: string;
      readonly status: "queued" | "sent" | "bounced";
    }>();
    expectTypeOf<Ref.Returns<Handle>>().toEqualTypeOf<number>();
    expectTypeOf<Ref.Error<Handle>>().toEqualTypeOf<EventRejected>();
    expectTypeOf<
      Callback.Error<typeof OnEvent>
    >().toEqualTypeOf<EventRejected>();
    expectTypeOf<Handle>().toExtend<Ref.AnyMutation>();
    expectTypeOf<
      Schema.Schema.Type<ReturnType<typeof Callback.handle<typeof OnEvent>>>
    >().toEqualTypeOf<Handle>();
  });

  test("C1: the component cannot call the handle outside its contract", () => {
    const ok: Ref.Args<Handle> = { run: "a", status: "sent" };
    // @ts-expect-error C1 "opened" is not a status the contract sends
    const outside: Ref.Args<Handle> = { run: "a", status: "opened" };
    void [ok, outside];
  });

  test("a handle for another contract with the same shape is a different type", () => {
    expectTypeOf<Callback.Handle<typeof Other>>().not.toExtend<Handle>();
  });

  test("toFuture views a handle with its wire types", () => {
    expectTypeOf<ReturnType<typeof Callback.toFuture<Handle>>>().toEqualTypeOf<
      FunctionReference_future<
        "mutation",
        "internal",
        {
          readonly run: string;
          readonly status: "queued" | "sent" | "bounced";
        },
        string
      >
    >();
  });
});
