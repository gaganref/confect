import { getFunctionReference } from "@confect/core/RefInternal";
import {
  Callback as CoreCallback,
  FunctionSpec,
  GenericId,
  GroupSpec,
  IdScope,
  type MiddlewareAttachment,
  MiddlewareSpec,
  Ref,
  Refs,
  Spec,
} from "@confect/core";
import type * as FunctionProvenance from "@confect/core/FunctionProvenance";
import type * as RuntimeAndFunctionType from "@confect/core/RuntimeAndFunctionType";
import * as Callback from "@confect/server/Callback";
import * as MutationRunner from "@confect/server/MutationRunner";
import * as ActionRunner from "@confect/server/ActionRunner";
import * as Scheduler from "@confect/server/Scheduler";
import * as RegisteredFunction from "@confect/server/RegisteredFunction";
import * as Forwarding from "./internal/forwarding";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import type { GenericId as ConvexId } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { vi } from "vitest";
import * as Arr from "effect/Array";

// oxlint-disable-next-line effecttsgo/schema-class-missing-brand -- Structural on purpose: Rebuilt below copies this tag and fields, and the test proves Callback.create accepts the copy, which a brand would reject at compile time.
class EventRejected extends Schema.TaggedError<EventRejected>()(
  "EventRejected",
  { reason: Schema.String },
) {}

class Unrelated extends Schema.TaggedError<
  Unrelated,
  { readonly brand: unique symbol }
>()("Unrelated", {
  reason: Schema.String,
}) {}

const Status = Schema.Literals(["queued", "sent", "bounced"]);

const OnEvent = CoreCallback.mutation("counter/onEvent", {
  args: () => ({ run: Schema.String, status: Status }),
  returns: () => Schema.Null,
  error: () => EventRejected,
});

const host = <Spec extends FunctionSpec.AnyWithProps>(spec: Spec) =>
  Ref.make("callbacks", spec);

const onEvent = Ref.make(
  "callbacks",
  FunctionSpec.internalMutation({
    name: "onEvent",
    args: () => ({ run: Schema.String, status: Status }),
    returns: () => Schema.Null,
    error: () => EventRejected,
  }),
);

describe("create", () => {
  it.effect(
    "asks Convex for a handle to the ref and runs the component's calls through it",
    () =>
      Effect.gen(function* () {
        const syscalls: Array<readonly [string, string]> = [];
        vi.stubGlobal("Convex", {
          asyncSyscall: (op: string, arg: string) => {
            syscalls.push([op, arg]);
            return Promise.resolve('"function://;callbacks:onEvent"');
          },
        });
        const handle = yield* Callback.create(OnEvent, onEvent).pipe(
          Effect.ensuring(Effect.sync(() => vi.unstubAllGlobals())),
        );
        const decodedSyscalls = yield* Effect.forEach(syscalls, ([op, arg]) =>
          Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(arg).pipe(
            Effect.map((parsed) => [op, parsed]),
          ),
        );
        expect(decodedSyscalls).toEqual([
          [
            "1.0/createFunctionHandle",
            expect.objectContaining({ name: "callbacks:onEvent" }),
          ],
        ]);
        const calls: Array<unknown> = [];
        yield* Ref.runWithCodec(
          handle,
          { run: "a", status: "sent" },
          (functionReference, encodedArgs) => {
            calls.push(functionReference, encodedArgs);
            return Promise.resolve(null);
          },
        );
        expect(calls).toEqual([
          "function://;callbacks:onEvent",
          { run: "a", status: "sent" },
        ]);
      }),
  );
});

const created = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.suspend(() => {
    vi.stubGlobal("Convex", {
      asyncSyscall: () => Promise.resolve('"function://;callbacks:onEvent"'),
    });
    return Effect.result(effect);
  }).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllGlobals())));

const mismatch = (
  contract: string,
  side: "args" | "returns" | "error",
  expected: Schema.Json,
  actual: Schema.Json,
) =>
  Result.fail(
    Callback.CallbackContractMismatch.make({
      contract,
      side,
      expected,
      actual,
    }),
  );

describe("create checks the host's validators", () => {
  it.effect.each([
    { side: "returns", unsupportedOn: "contract" },
    { side: "returns", unsupportedOn: "host" },
    { side: "returns", unsupportedOn: "both" },
    { side: "args", unsupportedOn: "contract" },
    { side: "args", unsupportedOn: "host" },
    { side: "args", unsupportedOn: "both" },
  ] as const)(
    "fails with a tagged mismatch for unsupported $side schemas ($unsupportedOn)",
    ({ side, unsupportedOn }) =>
      Effect.gen(function* () {
        const template = Schema.TemplateLiteral([Schema.String]);
        const contractSchema =
          unsupportedOn === "host" ? Schema.String : template;
        const hostSchema =
          unsupportedOn === "contract" ? Schema.String : template;
        const argsFor = (
          schema: typeof contractSchema,
        ): FunctionProvenance.ArgsFields =>
          side === "args" ? { text: schema } : {};
        const Text = CoreCallback.mutation("counter/onText", {
          args: () => argsFor(contractSchema),
          returns: () => (side === "returns" ? contractSchema : Schema.Null),
        });
        const text = host(
          FunctionSpec.internalMutation({
            name: "text",
            args: () => argsFor(hostSchema),
            returns: () => (side === "returns" ? hostSchema : Schema.Null),
          }),
        );
        const supported: Schema.Json =
          side === "args"
            ? { kind: "object", fields: { text: { kind: "string" } } }
            : { kind: "string" };
        const unsupported: Schema.Json = {
          kind: "unsupported",
          reason: "Unsupported schema type 'TemplateLiteral'",
        };
        const result = yield* created(Callback.create(Text, text));
        expect(result).toEqual(
          mismatch(
            "counter/onText",
            side,
            unsupportedOn === "host" ? supported : unsupported,
            unsupportedOn === "contract" ? supported : unsupported,
          ),
        );
        if (Result.isFailure(result)) {
          expect(result.failure.message).toContain(
            "Unsupported schema type 'TemplateLiteral'",
          );
        }
      }),
  );

  it.effect(
    "refuses a host error outside the contract's declared set with an error-side mismatch",
    () =>
      Effect.gen(function* () {
        const unrelated = host(
          FunctionSpec.internalMutation({
            name: "unrelated",
            args: () => ({ run: Schema.String, status: Status }),
            returns: () => Schema.Null,
            error: () => Unrelated,
          }),
        );
        const unrelatedResult = yield* created(
          // @ts-expect-error the host's Unrelated error is outside the contract's declared set
          Callback.create(OnEvent, unrelated),
        );
        expect(unrelatedResult).toEqual(
          mismatch(
            "counter/onEvent",
            "error",
            {
              kind: "object",
              fields: {
                _tag: { kind: "literal", value: "EventRejected" },
                reason: { kind: "string" },
              },
            },
            {
              kind: "object",
              fields: {
                _tag: { kind: "literal", value: "Unrelated" },
                reason: { kind: "string" },
              },
            },
          ),
        );
      }),
  );

  it.effect(
    "accepts a host that declares a subset of the contract's errors",
    () =>
      Effect.gen(function* () {
        const Declared = CoreCallback.mutation("counter/onDeclared", {
          returns: () => Schema.Null,
          error: () => Schema.Union([EventRejected, Unrelated]),
        });
        const subset = host(
          FunctionSpec.internalMutation({
            name: "subset",
            returns: () => Schema.Null,
            error: () => EventRejected,
          }),
        );
        const createdResult = yield* created(Callback.create(Declared, subset));
        const handle = Result.getOrThrow(createdResult);
        expect(getFunctionReference(handle)).toBe(
          "function://;callbacks:onEvent",
        );
      }),
  );

  it.effect("refuses args fields the types cannot see", () =>
    Effect.gen(function* () {
      const contractArgs: Record<string, typeof Schema.String> = {
        wanted: Schema.String,
      };
      const hostArgs: Record<string, typeof Schema.String> = {
        other: Schema.String,
      };
      const Keyed = CoreCallback.mutation("counter/onKeyed", {
        args: () => contractArgs,
        returns: () => Schema.Null,
      });
      const keyed = host(
        FunctionSpec.internalMutation({
          name: "keyed",
          args: () => hostArgs,
          returns: () => Schema.Null,
        }),
      );
      const createdResult = yield* created(Callback.create(Keyed, keyed));
      expect(createdResult).toEqual(
        mismatch(
          "counter/onKeyed",
          "args",
          { kind: "object", fields: { wanted: { kind: "string" } } },
          { kind: "object", fields: { other: { kind: "string" } } },
        ),
      );
    }),
  );

  it.effect("preserves args field checks alongside recursive schemas", () =>
    Effect.gen(function* () {
      const tree = Schema.suspend(() => Schema.String);
      const contractArgs: Record<string, Schema.Codec<string>> = {
        wanted: Schema.String,
        tree,
      };
      const hostArgs: Record<string, Schema.Codec<string>> = {
        other: Schema.String,
        tree,
      };
      const Keyed = CoreCallback.mutation("counter/onKeyed", {
        args: () => contractArgs,
        returns: () => Schema.Null,
      });
      const keyed = host(
        FunctionSpec.internalMutation({
          name: "keyed",
          args: () => hostArgs,
          returns: () => Schema.Null,
        }),
      );
      const createdResult = yield* created(Callback.create(Keyed, keyed));
      expect(createdResult).toEqual(
        mismatch(
          "counter/onKeyed",
          "args",
          {
            kind: "object",
            fields: { wanted: { kind: "string" }, tree: { kind: "any" } },
          },
          {
            kind: "object",
            fields: { other: { kind: "string" }, tree: { kind: "any" } },
          },
        ),
      );
    }),
  );

  it.effect("refuses returns the types cannot see", () =>
    Effect.gen(function* () {
      const contractFields: Record<string, typeof Schema.String> = {
        wanted: Schema.String,
      };
      const hostFields: Record<string, typeof Schema.String> = {
        other: Schema.String,
      };
      const Keyed = CoreCallback.mutation("counter/onKeyed", {
        returns: () => Schema.Struct(contractFields),
      });
      const keyed = host(
        FunctionSpec.internalMutation({
          name: "keyed",
          returns: () => Schema.Struct(hostFields),
        }),
      );
      const createdResult = yield* created(Callback.create(Keyed, keyed));
      expect(createdResult).toEqual(
        mismatch(
          "counter/onKeyed",
          "returns",
          { kind: "object", fields: { wanted: { kind: "string" } } },
          { kind: "object", fields: { other: { kind: "string" } } },
        ),
      );
    }),
  );

  it.effect("refuses an application ID where the contract sends a string", () =>
    Effect.gen(function* () {
      const Named = CoreCallback.mutation("counter/onNamed", {
        args: () => ({ id: Schema.String }),
        returns: () => Schema.Null,
      });
      const named = host(
        FunctionSpec.internalMutation({
          name: "named",
          args: () => ({ id: GenericId.GenericId("users") }),
          returns: () => Schema.Null,
        }),
      );
      const namedResult = yield* created(
        // @ts-expect-error the host's validator accepts only IDs of users
        Callback.create(Named, named),
      );
      expect(namedResult).toEqual(
        mismatch(
          "counter/onNamed",
          "args",
          { kind: "object", fields: { id: { kind: "string" } } },
          {
            kind: "object",
            fields: { id: { kind: "id", tableName: "users" } },
          },
        ),
      );
    }),
  );

  it.effect("refuses errors from group middleware whose types are erased", () =>
    Effect.gen(function* () {
      class Blocked extends Schema.TaggedError<
        Blocked,
        { readonly brand: unique symbol }
      >()("Blocked", {}) {}
      class Gate extends MiddlewareSpec.MiddlewareSpec<Gate>()("Gate", {
        error: () => Blocked,
        functionTypes: { query: false, mutation: true, action: false },
      }) {}
      const attachments: ReadonlyArray<MiddlewareAttachment.MiddlewareAttachment> =
        [{ spec: Gate, options: undefined }];
      const Guarded = CoreCallback.mutation("counter/onGuarded", {
        returns: () => Schema.Null,
        error: () => EventRejected,
      });
      const grouped = Ref.make(
        "callbacks",
        FunctionSpec.internalMutation({
          name: "grouped",
          returns: () => Schema.Null,
          error: () => EventRejected,
        }),
        attachments,
      );
      const groupedResult = yield* created(
        // @ts-expect-error the erased attachments may fail with any error
        Callback.create(Guarded, grouped),
      );
      expect(groupedResult).toEqual(
        mismatch(
          "counter/onGuarded",
          "error",
          {
            kind: "object",
            fields: {
              _tag: { kind: "literal", value: "EventRejected" },
              reason: { kind: "string" },
            },
          },
          {
            kind: "object",
            fields: { _tag: { kind: "literal", value: "Blocked" } },
          },
        ),
      );
    }),
  );

  it.effect("refuses a rebuilt error schema Convex cannot compile", () =>
    Effect.gen(function* () {
      const reasoned = () =>
        Schema.TaggedStruct("Reasoned", {
          reason: Schema.TemplateLiteral(["reason-", Schema.String]),
        });
      const Reasoning = CoreCallback.mutation("counter/onReasoning", {
        returns: () => Schema.Null,
        error: reasoned,
      });
      const rebuilt = host(
        FunctionSpec.internalMutation({
          name: "rebuilt",
          returns: () => Schema.Null,
          error: reasoned,
        }),
      );
      const unsupported = {
        kind: "unsupported",
        reason: "Unsupported schema type 'TemplateLiteral'",
      };
      const createdResult = yield* created(Callback.create(Reasoning, rebuilt));
      expect(createdResult).toEqual(
        mismatch("counter/onReasoning", "error", unsupported, unsupported),
      );
    }),
  );

  it.effect(
    "accepts reordered unions and component IDs when the host declares fewer contract errors",
    () =>
      Effect.gen(function* () {
        const definition = IdScope.component("counter");
        const installation = IdScope.instance(IdScope.app, "first");
        const Mixed = CoreCallback.mutation("counter/onMixed", {
          args: () => ({
            id: GenericId.GenericId("deliveries", definition),
            value: Schema.Union([Schema.String, Schema.Finite]),
            note: Schema.optionalKey(Schema.String),
          }),
          returns: () => Schema.Null,
          error: () => Schema.Union([EventRejected, Unrelated]),
        });
        const mixed = host(
          FunctionSpec.internalMutation({
            name: "mixed",
            args: () => ({
              id: GenericId.GenericId("deliveries", installation),
              value: Schema.Union([Schema.Finite, Schema.String]),
              note: Schema.optional(Schema.String),
            }),
            returns: () => Schema.Null,
            error: () => Unrelated,
          }),
        );
        const createdResult = yield* created(Callback.create(Mixed, mixed));
        expect(Result.isSuccess(createdResult)).toBe(true);
      }),
  );

  it.effect("accepts validators that accept the same values", () =>
    Effect.gen(function* () {
      const Flagged = CoreCallback.mutation("counter/onFlagged", {
        args: () => ({ flag: Schema.Boolean, name: Schema.String }),
        returns: () => Schema.Null,
      });
      const flagged = host(
        FunctionSpec.internalMutation({
          name: "flagged",
          args: () => ({
            flag: Schema.Literals([true, false]),
            name: Schema.Union([Schema.String, Schema.Literal("x")]),
          }),
          returns: () => Schema.Null,
        }),
      );
      const createdResult = yield* created(Callback.create(Flagged, flagged));
      expect(Result.isSuccess(createdResult)).toBe(true);
    }),
  );

  it.effect(
    "accepts errors rebuilt with the contract's validators, or shared even when Convex cannot compile them",
    () =>
      Effect.gen(function* () {
        // oxlint-disable-next-line effecttsgo/schema-class-missing-brand -- Structural on purpose: this copy of EventRejected must match it by shape, which a brand would prevent.
        class Rebuilt extends Schema.TaggedError<Rebuilt>()("EventRejected", {
          reason: Schema.String,
        }) {}
        const Reasoned = Schema.TaggedStruct("Reasoned", {
          reason: Schema.TemplateLiteral(["reason-", Schema.String]),
        });
        const Reasoning = CoreCallback.mutation("counter/onReasoning", {
          returns: () => Schema.Null,
          error: () => Schema.Union([EventRejected, Reasoned]),
        });
        const reasoning = host(
          FunctionSpec.internalMutation({
            name: "reasoning",
            returns: () => Schema.Null,
            error: () => Schema.Union([Rebuilt, Reasoned]),
          }),
        );
        const createdResult = yield* created(
          Callback.create(Reasoning, reasoning),
        );
        expect(Result.isSuccess(createdResult)).toBe(true);
      }),
  );
});

describe("create types", () => {
  const publicRef = Ref.make(
    "callbacks",
    FunctionSpec.publicMutation({
      name: "onEventPublic",
      args: () => ({ run: Schema.String, status: Status }),
      returns: () => Schema.Null,
      error: () => EventRejected,
    }),
  );
  const wrongArgs = host(
    FunctionSpec.internalMutation({
      name: "wrongArgs",
      args: () => ({ run: Schema.Finite, status: Status }),
      returns: () => Schema.Null,
      error: () => EventRejected,
    }),
  );
  const missingArg = host(
    FunctionSpec.internalMutation({
      name: "missingArg",
      args: () => ({ run: Schema.String }),
      returns: () => Schema.Null,
      error: () => EventRejected,
    }),
  );
  const aQuery = Ref.make(
    "callbacks",
    FunctionSpec.internalQuery({
      name: "aQuery",
      args: () => ({ run: Schema.String, status: Status }),
      returns: () => Schema.Null,
    }),
  );
  const undeclaredError = host(
    FunctionSpec.internalMutation({
      name: "undeclaredError",
      args: () => ({ run: Schema.String, status: Status }),
      returns: () => Schema.Null,
      error: () => Unrelated,
    }),
  );
  const noError = host(
    FunctionSpec.internalMutation({
      name: "noError",
      args: () => ({ run: Schema.String, status: Status }),
      returns: () => Schema.Null,
    }),
  );
  const wideArgs = host(
    FunctionSpec.internalMutation({
      name: "wideArgs",
      args: () => ({
        run: Schema.String,
        status: Schema.String,
        note: Schema.optionalKey(Schema.String),
      }),
      returns: () => Schema.Null,
    }),
  );

  it("accepts a matching internal or public ref", () => {
    type Created = Effect.Effect<
      CoreCallback.Handle<typeof OnEvent>,
      Callback.CallbackContractMismatch
    >;
    expectTypeOf(Callback.create(OnEvent, onEvent)).toEqualTypeOf<Created>();
    expectTypeOf(Callback.create(OnEvent, publicRef)).toEqualTypeOf<Created>();
    expectTypeOf(Callback.create(OnEvent, noError)).toEqualTypeOf<Created>();
  });

  it("N1: rejects a ref whose args do not match the contract", () => {
    // @ts-expect-error N1 run is a number on the host, a string in the contract
    void Callback.create(OnEvent, wrongArgs);
    // @ts-expect-error N1 the host would reject the status field the component sends
    void Callback.create(OnEvent, missingArg);
    // @ts-expect-error N1 the host declares wider args than the contract sends
    void Callback.create(OnEvent, wideArgs);
  });

  it("N2: rejects a query where the contract needs a mutation", () => {
    // @ts-expect-error N2 the contract needs a mutation
    void Callback.create(OnEvent, aQuery);
  });

  it("rejects a ref that fails with errors the contract does not declare", () => {
    // @ts-expect-error the host may fail with Unrelated, which the component cannot decode
    void Callback.create(OnEvent, undeclaredError);
  });

  it("H1: rejects a ref whose returns or errors are encoded differently", () => {
    const Counted = CoreCallback.mutation("counter/onCounted", {
      args: () => ({ run: Schema.String }),
      returns: () => Schema.FiniteFromString,
    });
    const finiteOnWire = host(
      FunctionSpec.internalMutation({
        name: "finiteOnWire",
        args: () => ({ run: Schema.String }),
        returns: () => Schema.Finite,
      }),
    );
    const finiteFromString = host(
      FunctionSpec.internalMutation({
        name: "finiteFromString",
        args: () => ({ run: Schema.String }),
        returns: () => Schema.FiniteFromString,
      }),
    );
    void Callback.create(Counted, finiteFromString);
    // @ts-expect-error H1 the host returns a number on the wire, the contract decodes a string
    void Callback.create(Counted, finiteOnWire);

    class Rejected extends Schema.TaggedError<
      Rejected,
      { readonly brand: unique symbol }
    >()("Rejected", {
      at: Schema.FiniteFromString,
    }) {}
    class RejectedOnWire extends Schema.TaggedError<
      RejectedOnWire,
      { readonly brand: unique symbol }
    >()("Rejected", { at: Schema.Finite }) {}
    const Guarded = CoreCallback.mutation("counter/onGuarded", {
      returns: () => Schema.Null,
      error: () => Rejected,
    });
    const rejectsOnWire = host(
      FunctionSpec.internalMutation({
        name: "rejectsOnWire",
        returns: () => Schema.Null,
        error: () => RejectedOnWire,
      }),
    );
    // @ts-expect-error H1 the host encodes its error's field as a number, the contract decodes a string
    void Callback.create(Guarded, rejectsOnWire);
  });

  it("N1: rejects a ref that would refuse a nested field the contract sends", () => {
    const Nested = CoreCallback.mutation("counter/onNested", {
      args: () => ({
        payload: Schema.Struct({ run: Schema.String, status: Status }),
        history: Schema.Array(Schema.Struct({ status: Status })),
      }),
      returns: () => Schema.Null,
    });
    const nestedMatch = host(
      FunctionSpec.internalMutation({
        name: "nestedMatch",
        args: () => ({
          payload: Schema.Struct({ run: Schema.String, status: Status }),
          history: Schema.Array(Schema.Struct({ status: Status })),
        }),
        returns: () => Schema.Null,
      }),
    );
    const nestedObject = host(
      FunctionSpec.internalMutation({
        name: "nestedObject",
        args: () => ({
          payload: Schema.Struct({ run: Schema.String }),
          history: Schema.Array(Schema.Struct({ status: Status })),
        }),
        returns: () => Schema.Null,
      }),
    );
    const nestedArray = host(
      FunctionSpec.internalMutation({
        name: "nestedArray",
        args: () => ({
          payload: Schema.Struct({ run: Schema.String, status: Status }),
          history: Schema.Array(Schema.Struct({})),
        }),
        returns: () => Schema.Null,
      }),
    );
    void Callback.create(Nested, nestedMatch);
    // @ts-expect-error N1 the host's validator would reject payload.status
    void Callback.create(Nested, nestedObject);
    // @ts-expect-error N1 the host's validator would reject history[].status
    void Callback.create(Nested, nestedArray);
  });

  it("H1: rejects a ref whose middleware encodes an error differently", () => {
    class Rejected extends Schema.TaggedError<
      Rejected,
      { readonly brand: unique symbol }
    >()("Rejected", {
      at: Schema.FiniteFromString,
    }) {}
    class RejectedOnWire extends Schema.TaggedError<
      RejectedOnWire,
      { readonly brand: unique symbol }
    >()("Rejected", { at: Schema.Finite }) {}
    class Gate extends MiddlewareSpec.MiddlewareSpec<Gate>()("Gate", {
      error: () => RejectedOnWire,
      functionTypes: { query: false, mutation: true, action: false },
    }) {}
    const Guarded = CoreCallback.mutation("counter/onGuarded", {
      returns: () => Schema.Null,
      error: () => Rejected,
    });
    const gated = GroupSpec.make()
      .middleware(Gate)
      .addFunction(
        FunctionSpec.internalMutation({
          name: "onGuarded",
          returns: () => Schema.Null,
        }),
      );
    const refs = Refs.make(
      Spec.fromGroups({ gated }) as Spec.Spec<{
        readonly gated: GroupSpec.NamedAt<typeof gated, "gated">;
      }>,
    );
    // @ts-expect-error H1 the host's middleware encodes Rejected.at as a number
    void Callback.create(Guarded, refs.internal.gated.onGuarded);
  });

  it("N1: rejects a host whose union args would refuse what the contract sends", () => {
    const Tagged = CoreCallback.mutation("counter/onTagged", {
      args: () => ({
        event: Schema.Struct({
          kind: Schema.Literal("a"),
          a: Schema.String,
          b: Schema.String,
        }),
      }),
      returns: () => Schema.Null,
    });
    const split = host(
      FunctionSpec.internalMutation({
        name: "split",
        args: () => ({
          event: Schema.Union([
            Schema.Struct({ kind: Schema.Literal("a"), a: Schema.String }),
            Schema.Struct({ kind: Schema.Literal("b"), b: Schema.String }),
          ]),
        }),
        returns: () => Schema.Null,
      }),
    );
    // @ts-expect-error N1 neither branch of the host's union accepts a and b together
    void Callback.create(Tagged, split);
  });

  it("N1 and H1: compare tuples by position and length", () => {
    const Pair = Schema.Tuple([Schema.String, Schema.Finite]);
    const Paired = CoreCallback.mutation("counter/onPaired", {
      args: () => ({ x: Pair }),
      returns: () => Pair,
    });
    const paired = host(
      FunctionSpec.internalMutation({
        name: "paired",
        args: () => ({ x: Pair }),
        returns: () => Pair,
      }),
    );
    const swapped = host(
      FunctionSpec.internalMutation({
        name: "swapped",
        args: () => ({ x: Schema.Tuple([Schema.Finite, Schema.String]) }),
        returns: () => Pair,
      }),
    );
    const listed = host(
      FunctionSpec.internalMutation({
        name: "listed",
        args: () => ({ x: Pair }),
        returns: () =>
          Schema.Array(Schema.Union([Schema.String, Schema.Finite])),
      }),
    );
    void Callback.create(Paired, paired);
    // @ts-expect-error N1 the host decodes x[0] as a number
    void Callback.create(Paired, swapped);
    // @ts-expect-error H1 the host may return an array of any length
    void Callback.create(Paired, listed);
  });

  it("H1: rejects returns narrower than the contract's", () => {
    const Named = CoreCallback.mutation("counter/onNamed", {
      returns: () => Schema.String,
    });
    const literal = host(
      FunctionSpec.internalMutation({
        name: "literal",
        returns: () => Schema.Literal("x"),
      }),
    );
    // @ts-expect-error H1 the host's returns validator is v.literal("x"), not v.string()
    void Callback.create(Named, literal);
  });

  it("accepts a host that types a component's ID with its own scope", () => {
    const definition = IdScope.component("counter");
    const installation = IdScope.instance(IdScope.app, "first");
    const Scoped = CoreCallback.mutation("counter/onScoped", {
      args: () => ({ id: GenericId.GenericId("deliveries", definition) }),
      returns: () => Schema.Null,
    });
    const scoped = host(
      FunctionSpec.internalMutation({
        name: "scoped",
        args: () => ({ id: GenericId.GenericId("deliveries", installation) }),
        returns: () => Schema.Null,
      }),
    );
    expectTypeOf(Callback.create(Scoped, scoped)).toEqualTypeOf<
      Effect.Effect<
        CoreCallback.Handle<typeof Scoped>,
        Callback.CallbackContractMismatch
      >
    >();
  });

  it("H1: rejects a ref built directly whose function middleware encodes an error differently", () => {
    class Rejected extends Schema.TaggedError<
      Rejected,
      { readonly brand: unique symbol }
    >()("Rejected", {
      at: Schema.FiniteFromString,
    }) {}
    class RejectedOnWire extends Schema.TaggedError<
      RejectedOnWire,
      { readonly brand: unique symbol }
    >()("Rejected", { at: Schema.Finite }) {}
    class Gate extends MiddlewareSpec.MiddlewareSpec<Gate>()("Gate", {
      error: () => RejectedOnWire,
      functionTypes: { query: false, mutation: true, action: false },
    }) {}
    const Guarded = CoreCallback.mutation("counter/onGuarded", {
      returns: () => Schema.Null,
      error: () => Rejected,
    });
    const gated = Ref.make(
      "callbacks",
      FunctionSpec.internalMutation({
        name: "gated",
        returns: () => Schema.Null,
      }).middleware(Gate),
    );
    // @ts-expect-error H1 the function's own middleware encodes Rejected.at as a number
    void Callback.create(Guarded, gated);
  });

  it("rejects a parameter that may hold a ref with erased codecs", () => {
    const forward = (
      ref: Ref.Ref<
        RuntimeAndFunctionType.ConvexMutation,
        "internal",
        CoreCallback.Args<typeof OnEvent>,
        null,
        EventRejected
      >,
    ) =>
      // @ts-expect-error a Ref.Ref may be a Confect ref with erased codecs
      Callback.create(OnEvent, ref);
    void forward;
  });

  it("N1: rejects a host that omits an optional field the contract may send", () => {
    const Noted = CoreCallback.mutation("counter/onNoted", {
      args: () => ({
        run: Schema.String,
        note: Schema.optionalKey(Schema.String),
      }),
      returns: () => Schema.Null,
    });
    const unnoted = host(
      FunctionSpec.internalMutation({
        name: "unnoted",
        args: () => ({ run: Schema.String }),
        returns: () => Schema.Null,
      }),
    );
    const noted = host(
      FunctionSpec.internalMutation({
        name: "noted",
        args: () => ({
          run: Schema.String,
          note: Schema.optional(Schema.String),
        }),
        returns: () => Schema.Null,
      }),
    );
    void Callback.create(Noted, noted);
    // @ts-expect-error N1 the host's validator would reject note when it is sent
    void Callback.create(Noted, unnoted);
  });

  it("N1: rejects a host whose args are narrower than an unknown arg", () => {
    const Opaque = CoreCallback.mutation("counter/onOpaque", {
      args: () => ({ payload: Schema.Unknown }),
      returns: () => Schema.Null,
    });
    const empty = host(
      FunctionSpec.internalMutation({
        name: "empty",
        args: () => ({ payload: Schema.Struct({}) }),
        returns: () => Schema.Null,
      }),
    );
    // @ts-expect-error N1 the component may send any value as payload
    void Callback.create(Opaque, empty);
  });

  it("accepts a plain Convex ref with the same wire args", () => {
    const Tagged = CoreCallback.mutation("counter/onTags", {
      args: () => ({ tags: Schema.Array(Schema.String) }),
      returns: () => Schema.Null,
    });
    const native = Ref.fromFunctionReference(
      makeFunctionReference<"mutation", { tags: string[] }, null>(
        "callbacks:tags",
      ),
    );
    expectTypeOf(Callback.create(Tagged, native)).toEqualTypeOf<
      Effect.Effect<
        CoreCallback.Handle<typeof Tagged>,
        Callback.CallbackContractMismatch
      >
    >();
  });

  it("H1: rejects a ref built with group middleware whose errors the contract does not declare", () => {
    class Blocked extends Schema.TaggedError<
      Blocked,
      { readonly brand: unique symbol }
    >()("Blocked", {}) {}
    class Gate extends MiddlewareSpec.MiddlewareSpec<Gate>()("Gate", {
      error: () => Blocked,
      functionTypes: { query: false, mutation: true, action: false },
    }) {}
    const Quiet = CoreCallback.mutation("counter/onQuiet", {
      returns: () => Schema.Null,
    });
    const grouped = Ref.make(
      "callbacks",
      FunctionSpec.internalMutation({
        name: "grouped",
        returns: () => Schema.Null,
      }),
      [{ spec: Gate, options: undefined }],
    );
    // @ts-expect-error H1 the group's middleware may fail with Blocked
    void Callback.create(Quiet, grouped);
  });

  it("rejects a ref whose codecs are erased", () => {
    const erased: Ref.Ref<
      RuntimeAndFunctionType.ConvexMutation,
      "internal",
      CoreCallback.Args<typeof OnEvent>,
      null,
      EventRejected
    > = onEvent;
    // @ts-expect-error a ref typed from values alone cannot prove its encoding
    void Callback.create(OnEvent, erased);
  });

  it("N3: a component arg typed with one contract refuses another contract's handle", () => {
    const Other = CoreCallback.mutation("other/onEvent", {
      args: () => ({ run: Schema.String, status: Status }),
      returns: () => Schema.Null,
      error: () => EventRejected,
    });
    const send = Ref.make(
      "deliveries",
      FunctionSpec.publicMutation({
        name: "send",
        args: () => ({
          run: Schema.String,
          onEvent: CoreCallback.handle(OnEvent),
        }),
        returns: () => Schema.Null,
      }),
    );
    const sendArgs = (
      own: CoreCallback.Handle<typeof OnEvent>,
      other: CoreCallback.Handle<typeof Other>,
    ) => {
      const ok: Ref.Args<typeof send> = { run: "a", onEvent: own };
      // @ts-expect-error N3 a handle for "other/onEvent" is not one for "counter/onEvent"
      const wrong: Ref.Args<typeof send> = { run: "a", onEvent: other };
      return [ok, wrong];
    };
    void sendArgs;
  });

  it("forwards a caller's ref through explicit type arguments", () => {
    const send = <R extends Ref.Any>(
      ref: R & CoreCallback.Check<typeof OnEvent, R>,
    ) => Callback.create<typeof OnEvent, R>(OnEvent, ref);
    void send(onEvent);
    // @ts-expect-error the caller's ref is checked at the caller's call site
    void send(aQuery);
  });
});

describe("callback carrier", () => {
  it.effect.each(Forwarding.cases)(
    "forwards $label through inline and scheduled callback calls",
    ({ forward, enabled }) =>
      Effect.gen(function* () {
        const mutation = yield* MutationRunner.MutationRunner;
        const action = yield* ActionRunner.ActionRunner;
        const scheduled: Array<unknown> = [];
        const enqueue = (
          _when: number | Date,
          _ref: unknown,
          args?: unknown,
        ) => {
          scheduled.push(args);
          return Promise.resolve("job" as ConvexId<"_scheduled_functions">);
        };
        const schedulers = Scheduler.layer({
          runAfter: enqueue,
          runAt: enqueue,
          cancel: () => Promise.resolve(),
        });
        const fields = { count: Schema.FiniteFromString };
        const mutationContract = CoreCallback.mutation("counter/carrier", {
          args: () => fields,
          returns: () => Schema.Unknown,
        });
        const actionContract = CoreCallback.action("counter/carrier", {
          args: () => fields,
          returns: () => Schema.Unknown,
        });
        for (const options of [undefined, { reservedArgument: "observe" }]) {
          const text = "function://;callbacks:carrier";
          const mutationHandle = yield* Schema.decodeEffect(
            CoreCallback.handle(mutationContract, options),
          )(text);
          const actionHandle = yield* Schema.decodeEffect(
            CoreCallback.handle(actionContract, options),
          )(text);
          const args = { count: 1 };
          for (const [boundary, call] of [
            [
              "MutationRunner.runMutation",
              mutation.runMutation(mutationHandle, args),
            ],
            ["ActionRunner.runAction", action.runAction(actionHandle, args)],
          ] as const) {
            const callValue = yield* call;
            expect(callValue).toEqual({
              count: "1",
              ...(enabled && options !== undefined
                ? { observe: { boundary } }
                : {}),
            });
          }
          for (const handle of [mutationHandle, actionHandle]) {
            yield* Effect.gen(function* () {
              const scheduler = yield* Scheduler.Scheduler;
              yield* scheduler.runAfter(Duration.zero, handle, args);
              yield* scheduler.runAt(DateTime.makeUnsafe(0), handle, args);
            }).pipe(Effect.provide(schedulers));
            expect(scheduled.splice(0)).toEqual(
              Arr.map(["Scheduler.runAfter", "Scheduler.runAt"], (boundary) =>
                enabled && options !== undefined
                  ? { count: "1", observe: { boundary } }
                  : { count: "1" },
              ),
            );
          }
          expect(args).toEqual({ count: 1 });
        }
      }).pipe(
        Effect.provide([
          MutationRunner.layer(Forwarding.echo),
          ActionRunner.layer(Forwarding.echo),
          Layer.succeed(RegisteredFunction.Forward, forward),
        ]),
      ),
  );
});
