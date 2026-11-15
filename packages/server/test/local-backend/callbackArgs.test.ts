/**
 * What the binary hands a component that calls a host's function handle with
 * arguments the target's validator refuses, or that the target answers with a
 * return its validator refuses, compared with the test kernel, where the same
 * handle names a callback slot that declares the same validators
 * (`packages/test/src/internal/ArgumentValidation.ts`). Both refuse with an
 * `Error` whose message is the binary's, one newline longer for an action's
 * call. These are fixed cases, each regression the seeded differential in
 * `validationDifferential.test.ts` or a review found among them.
 */
import { expect, layer } from "@effect/vitest";
import { v, type GenericValidator } from "convex/values";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import * as LocalBackend from "confect-local-backend/LocalBackend";
import {
  kinds,
  literal,
  order,
  shape,
} from "../../../../tools/local-backend/fixtures/plain/convex/callbackArgs";
import {
  binaryCalls,
  type Caller,
  type Calls,
  handleOf,
  idNames,
  kernelCalls,
  mint,
  type Minted,
  normalized,
  refusalIn,
  sinkOf,
} from "./callbackProbe";

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

type Target =
  | "onShape"
  | "onKinds"
  | "badReturn"
  | "onOrder"
  | "onLiteral"
  | "literalReturn";

const targets: ReadonlyArray<Target> = [
  "onShape",
  "onKinds",
  "badReturn",
  "onOrder",
  "onLiteral",
  "literalReturn",
];

/**
 * The declared validators of each target, which the kernel's sink slots take.
 */
const declared: Readonly<
  Record<
    Target,
    {
      readonly args: GenericValidator;
      readonly returns: GenericValidator | undefined;
    }
  >
> = {
  onShape: { args: v.object(shape), returns: undefined },
  onKinds: { args: v.object(kinds), returns: undefined },
  badReturn: {
    args: v.object({ ticket: v.string() }),
    returns: v.object({ ticket: v.id("documents") }),
  },
  onOrder: { args: v.object(order), returns: undefined },
  onLiteral: { args: v.object(literal), returns: undefined },
  literalReturn: {
    args: v.object({ value: v.any() }),
    returns: v.object(literal),
  },
};

const slotOf = (slot: string) =>
  pipe(slot, Str.slice("fixture/".length)) as Target;

/**
 * What a backend gives the probe: a handle for each target, a handle it minted
 * for a `v.function()` argument, and its ids of each kind.
 */
interface Probe {
  readonly calls: Calls;
  readonly handles: Readonly<Record<Target, string>>;
  readonly kindsHandle: string;
  readonly ids: Minted;
}

/**
 * The plain fixture on the test kernel, with a sink slot per target that
 * declares that target's validators and answers as the target does: `null`, or
 * for `badReturn` the ticket it was given and for `literalReturn` its value.
 */
const kernelProbe = (): Promise<Probe> => {
  const calls = kernelCalls(
    sinkOf(
      (slot) => declared[slotOf(slot)],
      (slot, args) => {
        switch (slotOf(slot)) {
          case "badReturn":
            return { ticket: (args as { ticket: string }).ticket };
          case "literalReturn":
            return (args as { value: unknown }).value;
          default:
            return null;
        }
      },
    ),
  );
  return Promise.all([mint(calls), handleOf(calls, "onKinds")]).then(
    ([ids, kindsHandle]) => ({
      calls,
      handles: Rec.fromEntries(
        Arr.map(
          targets,
          (target) => [target, `function://~sink;fixture/${target}`] as const,
        ),
      ) as Record<Target, string>,
      kindsHandle,
      ids,
    }),
  );
};

/**
 * The same probe on the binary, whose handles name the real targets.
 */
const binaryProbe = (client: Calls): Promise<Probe> => {
  const calls = binaryCalls(client);
  return Promise.all([
    mint(calls),
    Promise.all(Arr.map(targets, (target) => handleOf(calls, target))),
  ]).then(([ids, made]) => {
    const handles = Rec.fromEntries(
      Arr.map(targets, (target, index) => [target, made[index]!] as const),
    ) as Record<Target, string>;
    return { calls, handles, kindsHandle: handles.onKinds, ids };
  });
};

/**
 * One probe call: a target, the arguments a backend's own ids and handles
 * build, and what the binary must answer, in part.
 */
interface Case {
  readonly target: Target;
  readonly args: (probe: Probe) => unknown;
  readonly expected:
    | "returned"
    | "ArgumentValidationError"
    | "ReturnsValidationError";
  /**
   * Text the binary's refusal holds, after its ids are named.
   */
  readonly holds?: string;
}

const kindsWith =
  (overrides: (probe: Probe) => Record<string, unknown>) => (probe: Probe) => ({
    doc: probe.ids["root.documents"],
    callback: probe.kindsHandle,
    stamp: 5n,
    blob: new Uint8Array([1, 2]).buffer,
    ...overrides(probe),
  });

const refused = (target: Target, args: Case["args"], holds: string): Case => ({
  target,
  args,
  expected:
    target === "badReturn" || target === "literalReturn"
      ? "ReturnsValidationError"
      : "ArgumentValidationError",
  holds,
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
  commitTsNumber: refused(
    "onKinds",
    kindsWith(() => ({ stamp: 5 })),
    "Path: .stamp",
  ),
  commitTsString: refused(
    "onKinds",
    kindsWith(() => ({ stamp: "nope" })),
    "Path: .stamp",
  ),
  commitTsNull: refused(
    "onKinds",
    kindsWith(() => ({ stamp: null })),
    "Path: .stamp",
  ),
  idNotAnId: refused(
    "onKinds",
    kindsWith(() => ({ doc: "not-an-id" })),
    "Value does not match validator.",
  ),
  idOtherTable: refused(
    "onKinds",
    kindsWith((probe) => ({ doc: probe.ids["root.others"] })),
    'Found ID "<root.others>" from table `others`',
  ),
  idNumber: refused(
    "onKinds",
    kindsWith(() => ({ doc: 7 })),
    "Value does not match validator.",
  ),
  // A child's id resolves by its table number in the host's namespace: `aaa`
  // numbers `others` first, as it has an index, so its `documents` id names
  // the host's `others`, and its `others` id the host's `documents`.
  idChildDocuments: refused(
    "onKinds",
    kindsWith((probe) => ({ doc: probe.ids["aaa.documents"] })),
    'Found ID "<aaa.documents>" from table `others`, which does not match the table name in validator `v.id("documents")`.Path: .doc',
  ),
  idChildOthers: {
    target: "onKinds",
    args: kindsWith((probe) => ({ doc: probe.ids["aaa.others"] })),
    expected: "returned",
  },
  idScheduled: refused(
    "onKinds",
    kindsWith((probe) => ({ doc: probe.ids["root.scheduled"] })),
    'Found ID "<root.scheduled>" from a system table, which does not match the table name in validator `v.id("documents")`.Path: .doc',
  ),
  idChildStorage: refused(
    "onKinds",
    kindsWith((probe) => ({ doc: probe.ids["aaa.storage"] })),
    'Found ID "<aaa.storage>" from a system table, which does not match the table name in validator `v.id("documents")`.Path: .doc',
  ),
  functionNumber: refused(
    "onKinds",
    kindsWith(() => ({ callback: 123 })),
    "Path: .callback",
  ),
  functionString: refused(
    "onKinds",
    kindsWith(() => ({ callback: "not-a-handle" })),
    "Path: .callback",
  ),
  functionMalformedHandle: refused(
    "onKinds",
    kindsWith(() => ({ callback: "function://nope#x:y" })),
    "Path: .callback",
  ),
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
  // Each declared field is checked in key order, so a missing `a` comes
  // before the mismatched `z`.
  missingBeforeMismatch: refused(
    "onOrder",
    () => ({ b: { x: "ok" }, z: "bad" }),
    "Object is missing the required field `a`.",
  ),
  literalString: refused(
    "onLiteral",
    () => ({ kind: "failed" }),
    '`"failed"` does not match literal validator `v.literal("ready")`.Path: .kind',
  ),
  literalSignedExponent: refused(
    "onLiteral",
    () => ({ kind: "ready", large: 5 }),
    "`5.0` does not match literal validator `v.literal(1e+16)`.Path: .large",
  ),
  returnsLiteral: refused(
    "literalReturn",
    () => ({ value: { kind: "failed" } }),
    '`"failed"` does not match literal validator `v.literal("ready")`.Path: .kind',
  ),
  returnsNotAnId: refused(
    "badReturn",
    () => ({ ticket: "nope" }),
    "Value does not match validator.",
  ),
  returnsOtherTable: refused(
    "badReturn",
    (probe) => ({ ticket: probe.ids["root.others"] }),
    "from table `others`",
  ),
  returnsSystemTable: refused(
    "badReturn",
    (probe) => ({ ticket: probe.ids["root.storage"] }),
    "from a system table",
  ),
  returnsValid: {
    target: "badReturn",
    args: (probe) => ({ ticket: probe.ids["root.documents"] }),
    expected: "returned",
  },
};

const namesOf = (probe: Probe) =>
  Arr.map(idNames, (name) => [probe.ids[name], name] as const);

layer(LocalBackend.plainLayer, { timeout: "300 seconds" })(
  "callback handle arguments and returns on the binary",
  (it) => {
    it.effect.each(
      Arr.flatMap(Rec.keys(cases), (name) =>
        Arr.map(["fromMutation", "fromAction"] as const, (caller: Caller) => ({
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
            refusalIn(binary.calls, caller, {
              handle: binary.handles[probeCase.target],
              args: probeCase.args(binary),
            }),
          );
          const binaryRefusal = normalized(binaryOutcome, namesOf(binary));
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
          if (probeCase.holds !== undefined && !binaryRefusal.returned)
            expect(binaryRefusal.message).toContain(probeCase.holds);
          const kernel = yield* Effect.promise(kernelProbe);
          const kernelOutcome = yield* Effect.promise(() =>
            refusalIn(kernel.calls, caller, {
              handle: kernel.handles[probeCase.target],
              args: probeCase.args(kernel),
            }),
          );
          expect(normalized(kernelOutcome, namesOf(kernel))).toEqual(
            binaryRefusal,
          );
        }),
    );
  },
);
