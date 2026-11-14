/**
 * What the binary hands a component that calls a host's function handle with
 * arguments the target's validator refuses, compared with the test kernel,
 * where the same handle names a callback slot that declares the same validator
 * (`packages/test/src/internal/ArgumentValidation.ts`). Both refuse before the
 * target runs, with an `Error` whose message is the binary's
 * `ArgumentValidationError`, one newline longer for an action's call.
 */
import { expect, layer } from "@effect/vitest";
import { makeFunctionReference } from "convex/server";
import { v, type GenericValidator } from "convex/values";
import { pipe } from "effect/Function";
import * as Str from "effect/String";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Rec from "effect/Record";
import * as LocalBackend from "confect-local-backend/LocalBackend";
import { convexTest } from "../../../test/src/internal/ConvexTest";
import {
  kinds,
  shape,
  type Refusal,
} from "../../../../tools/local-backend/fixtures/plain/convex/callbackArgs";
import schema from "../../../../tools/local-backend/fixtures/plain/convex/schema";

const valid: Readonly<Record<string, unknown>> = {
  token: "t",
  count: 1.5,
  big: 7n,
  flag: true,
  nothing: null,
  tags: ["x"],
  nested: { a: "y" },
  kind: "a",
  scores: { s: 1 },
  blob: new Uint8Array([1, 2]).buffer,
  anything: { deep: [1] },
};

const without = (key: string) => Rec.remove(valid, key);

/**
 * Each argument shape the probe sends, the valid one first.
 */
const shapes: Readonly<Record<string, unknown>> = {
  valid,
  missing: without("token"),
  extra: { ...valid, extra: 1 },
  missingAndExtra: { ...without("token"), aaa: 1 },
  missingAndMismatch: { ...without("token"), count: "x" },
  extraAndMismatch: { ...valid, zzz: 1, count: "x" },
  twoMismatches: { ...valid, tags: [1], count: "x" },
  nestedPath: { ...valid, nested: { a: 1 } },
  nestedMissing: { ...valid, nested: {} },
  nestedExtra: { ...valid, nested: { a: "y", z: 1 } },
  arrayIndex: { ...valid, tags: ["x", 2] },
  arrayNotArray: { ...valid, tags: "x" },
  objectNotObject: { ...valid, nested: "x" },
  union: { ...valid, kind: "c" },
  int64AsNumber: { ...valid, big: 3 },
  numberAsInt64: { ...valid, count: 4n },
  record: { ...valid, scores: { s: "no" } },
  bytes: { ...valid, blob: "nope" },
  optional: { ...valid, maybe: 5 },
  null: { ...valid, nothing: false },
  negativeZero: { ...valid, token: -0 },
  largeFloat: { ...valid, token: 1e21 },
  nan: { ...valid, token: Number.NaN },
  empty: {},
};

type Caller = "fromMutation" | "fromAction";

const callers = {
  fromMutation: makeFunctionReference<
    "mutation",
    { handle: string; args: unknown },
    Refusal
  >("callbackArgs:fromMutation"),
  fromAction: makeFunctionReference<
    "action",
    { handle: string; args: unknown },
    Refusal
  >("callbackArgs:fromAction"),
};

interface Calls {
  readonly mutation: (reference: any, args: any) => Promise<any>;
  readonly action: (reference: any, args: any) => Promise<any>;
}

const refusalIn = (
  calls: Calls,
  caller: Caller,
  handle: string,
  args: unknown,
): Promise<Refusal> =>
  caller === "fromMutation"
    ? calls.mutation(callers.fromMutation, { handle, args })
    : calls.action(callers.fromAction, { handle, args });

const fixture = {
  handle: makeFunctionReference<"mutation", { target?: string }, string>(
    "callbackArgs:handle",
  ),
  makeDocument: makeFunctionReference<
    "mutation",
    { table: "documents" | "others" },
    string
  >("callbackArgs:makeDocument"),
};

/**
 * What a backend gives the probe: a handle for each target, a handle it minted
 * for a `v.function()` argument, and an id of `documents` and of `others`.
 */
interface Probe {
  readonly calls: Calls;
  readonly handles: Readonly<Record<Target, string>>;
  readonly kindsHandle: string;
  readonly doc: string;
  readonly other: string;
}

type Target = "onShape" | "onKinds" | "badReturn";

/**
 * The declared validators of each target, which the kernel's sink slots take.
 */
const declared: Readonly<
  Record<
    Target,
    { readonly args: GenericValidator; readonly returns: GenericValidator }
  >
> = {
  onShape: { args: v.object(shape), returns: v.null() },
  onKinds: { args: v.object(kinds), returns: v.null() },
  badReturn: {
    args: v.object({ ticket: v.string() }),
    returns: v.object({ ticket: v.id("documents") }),
  },
};

const slotOf = (slot: string) =>
  pipe(slot, Str.slice("fixture/".length)) as Target;

/**
 * The plain fixture on the test kernel, with a sink slot per target that
 * declares that target's validators and answers as the target does: `null`, or
 * for `badReturn` the ticket it was given.
 */
const kernelProbe = (): Promise<Probe> => {
  const t = convexTest({
    schema,
    modules: {
      "_generated/server.ts": () => Promise.resolve({}),
      "callbackArgs.ts": () =>
        import("../../../../tools/local-backend/fixtures/plain/convex/callbackArgs"),
    },
    sink: {
      args: (slot) => declared[slotOf(slot)]?.args,
      returns: (slot) => declared[slotOf(slot)]?.returns,
      call: ({ slot, args }) =>
        Promise.resolve(
          slotOf(slot) === "badReturn"
            ? { ticket: (args as { ticket: string }).ticket }
            : null,
        ),
    },
  });
  const calls: Calls = {
    mutation: (reference, args) => t.mutation(reference, args),
    action: (reference, args) => t.action(reference, args),
  };
  return Promise.all([
    calls.mutation(fixture.makeDocument, { table: "documents" }),
    calls.mutation(fixture.makeDocument, { table: "others" }),
    calls.mutation(fixture.handle, { target: "onKinds" }),
  ]).then(([doc, other, kindsHandle]) => ({
    calls,
    handles: {
      onShape: "function://~sink;fixture/onShape",
      onKinds: "function://~sink;fixture/onKinds",
      badReturn: "function://~sink;fixture/badReturn",
    },
    kindsHandle,
    doc,
    other,
  }));
};

/**
 * The same probe on the binary, whose handles name the real targets.
 */
const binaryProbe = (client: {
  readonly mutation: (reference: any, args: any) => Promise<any>;
  readonly action: (reference: any, args: any) => Promise<any>;
}): Promise<Probe> => {
  const calls: Calls = {
    mutation: (reference, args) => client.mutation(reference, args),
    action: (reference, args) => client.action(reference, args),
  };
  return Promise.all([
    calls.mutation(fixture.makeDocument, { table: "documents" }),
    calls.mutation(fixture.makeDocument, { table: "others" }),
    calls.mutation(fixture.handle, {}),
    calls.mutation(fixture.handle, { target: "onKinds" }),
    calls.mutation(fixture.handle, { target: "badReturn" }),
  ]).then(([doc, other, onShape, onKinds, badReturn]) => ({
    calls,
    handles: { onShape, onKinds, badReturn },
    kindsHandle: onKinds,
    doc,
    other,
  }));
};

/**
 * One probe call: a target, and the arguments a backend's own ids and handles
 * build.
 */
interface Case {
  readonly target: Target;
  readonly args: (probe: Probe) => unknown;
  readonly expected:
    | "returned"
    | "ArgumentValidationError"
    | "ReturnsValidationError";
}

const kindsWith =
  (overrides: (probe: Probe) => Record<string, unknown>) => (probe: Probe) => ({
    doc: probe.doc,
    callback: probe.kindsHandle,
    stamp: 5n,
    blob: new Uint8Array([1, 2]).buffer,
    ...overrides(probe),
  });

const cases: Readonly<Record<string, Case>> = {
  ...Rec.map(shapes, (args, name): Case => ({
    target: "onShape",
    args: () => args,
    expected: name === "valid" ? "returned" : "ArgumentValidationError",
  })),
  kindsValid: {
    target: "onKinds",
    args: kindsWith(() => ({})),
    expected: "returned",
  },
  commitTsNumber: {
    target: "onKinds",
    args: kindsWith(() => ({ stamp: 5 })),
    expected: "ArgumentValidationError",
  },
  commitTsString: {
    target: "onKinds",
    args: kindsWith(() => ({ stamp: "nope" })),
    expected: "ArgumentValidationError",
  },
  commitTsNull: {
    target: "onKinds",
    args: kindsWith(() => ({ stamp: null })),
    expected: "ArgumentValidationError",
  },
  idNotAnId: {
    target: "onKinds",
    args: kindsWith(() => ({ doc: "not-an-id" })),
    expected: "ArgumentValidationError",
  },
  idOtherTable: {
    target: "onKinds",
    args: kindsWith((probe) => ({ doc: probe.other })),
    expected: "ArgumentValidationError",
  },
  idNumber: {
    target: "onKinds",
    args: kindsWith(() => ({ doc: 7 })),
    expected: "ArgumentValidationError",
  },
  functionNumber: {
    target: "onKinds",
    args: kindsWith(() => ({ callback: 123 })),
    expected: "ArgumentValidationError",
  },
  functionString: {
    target: "onKinds",
    args: kindsWith(() => ({ callback: "not-a-handle" })),
    expected: "ArgumentValidationError",
  },
  functionMalformedHandle: {
    target: "onKinds",
    args: kindsWith(() => ({ callback: "function://nope#x:y" })),
    expected: "ArgumentValidationError",
  },
  bytes200k: {
    target: "onKinds",
    args: kindsWith(() => ({ blob: new Uint8Array(200_000).buffer })),
    expected: "returned",
  },
  bytes1MiB: {
    target: "onKinds",
    args: kindsWith(() => ({ blob: new Uint8Array(1024 * 1024).buffer })),
    expected: "returned",
  },
  returnsNotAnId: {
    target: "badReturn",
    args: () => ({ ticket: "nope" }),
    expected: "ReturnsValidationError",
  },
  returnsOtherTable: {
    target: "badReturn",
    args: (probe) => ({ ticket: probe.other }),
    expected: "ReturnsValidationError",
  },
  returnsValid: {
    target: "badReturn",
    args: (probe) => ({ ticket: probe.doc }),
    expected: "returned",
  },
};

/**
 * What reached the caller, with the backend's own `others` id written as a
 * placeholder, since the two backends mint different ids.
 */
const normalized = (refusal: Refusal, probe: Probe): Refusal =>
  refusal.returned
    ? refusal
    : {
        ...refusal,
        message: pipe(
          refusal.message,
          Str.replaceAll(probe.other, "<others id>"),
        ),
      };

layer(LocalBackend.plainLayer, { timeout: "300 seconds" })(
  "callback handle arguments and returns on the binary",
  (it) => {
    it.effect.each(
      Arr.flatMap(Rec.keys(cases), (name) =>
        Arr.map(["fromMutation", "fromAction"] as const, (caller) => ({
          name,
          caller,
        })),
      ),
    )(
      "a handle called $caller with the $name case reaches its caller as on the test kernel's sink",
      ({ name, caller }) =>
        Effect.gen(function* () {
          const { client } = yield* LocalBackend.LocalBackend;
          const probeCase = cases[name]!;
          const binary = yield* Effect.promise(() => binaryProbe(client));
          const binaryOutcome = yield* Effect.promise(() =>
            refusalIn(
              binary.calls,
              caller,
              binary.handles[probeCase.target],
              probeCase.args(binary),
            ),
          );
          const binaryRefusal = normalized(binaryOutcome, binary);
          if (probeCase.expected === "returned")
            expect(binaryRefusal).toEqual({ returned: true });
          else
            expect(binaryRefusal).toMatchObject({
              returned: false,
              name: "Error",
              message: expect.stringMatching(
                new RegExp(`^${probeCase.expected}: `),
              ),
            });
          const kernel = yield* Effect.promise(kernelProbe);
          const kernelOutcome = yield* Effect.promise(() =>
            refusalIn(
              kernel.calls,
              caller,
              kernel.handles[probeCase.target],
              probeCase.args(kernel),
            ),
          );
          const kernelRefusal = normalized(kernelOutcome, kernel);
          expect(kernelRefusal).toEqual(binaryRefusal);
        }),
    );
  },
);
