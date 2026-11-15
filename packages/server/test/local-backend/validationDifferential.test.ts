/**
 * A seeded differential of the binary's validation against the test kernel's
 * (`packages/test/src/internal/ArgumentValidation.ts`). Each case is one of the
 * fixture's validator shapes (`differentialShapes.ts`) and a value drawn for
 * it, valid or broken in one or more places. The value goes to the shape's host
 * function as its arguments and, through an echo, as its declared return, from
 * a mutation or an action. On the binary the handles name the deployed
 * functions; on the kernel, sink slots that declare the same validators. What
 * reached the caller must agree byte for byte. A failure prints the value seed;
 * `CONFECT_VALIDATION_SEED` replays it.
 */
import { expect, layer } from "@effect/vitest";
import {
  convexToJson,
  v,
  type GenericValidator,
  type Value,
} from "convex/values";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Str from "effect/String";
import * as LocalBackend from "confect-local-backend/LocalBackend";
import { stringify } from "../../../test/src/internal/Json";
import {
  fieldNames,
  pick,
  shapes,
  stream,
} from "../../../../tools/local-backend/fixtures/plain/convex/differentialShapes";
import {
  binaryCalls,
  type Call,
  type Caller,
  type Calls,
  handleOf,
  idNames,
  kernelCalls,
  mint,
  type Minted,
  normalized,
  type Refusal,
  refusalsIn,
  sinkOf,
} from "./callbackProbe";

/**
 * The seed of the drawn values. The shapes' seed is the fixture's, since the
 * binary deploys them.
 */
const valueSeed = Config.Number("CONFECT_VALIDATION_SEED").pipe(
  Config.withDefault(20261115),
);

const VALUES_PER_SHAPE = 50;

const BATCH = 100;

/**
 * A placeholder a drawn value holds for a backend's own id or handle, which
 * each backend replaces with its own before the call.
 */
const token = (name: string) => `\u{E000}${name}`;

const FUNCTION = token("handle");

const floats = [
  0,
  -0,
  1,
  1.5,
  -2.25,
  0.0001,
  0.00001,
  1e-7,
  1e15,
  1e16,
  1e21,
  123456.789,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  5e-324,
];

const ints = [0n, 5n, -7n, 7n, 9223372036854775807n, -9223372036854775808n];

const strings = [
  "",
  "a",
  "ready",
  "Z",
  "hé",
  'q"uote',
  "back\\slash",
  "new\nline",
  "tab\t",
  "cr\r",
  "\u0001",
  "\u007f",
  "nb sp",
  "é",
  "😀",
  "日本",
  "zero​width",
  "line sep",
  "not-an-id",
  "function://",
  "function://;",
];

const bytesOf = (draw: () => number): ArrayBuffer =>
  new Uint8Array(
    Arr.makeBy(Math.floor(draw() * 5), () => Math.floor(draw() * 256)),
  ).buffer;

const rootIds: Readonly<Record<string, string>> = {
  documents: token("root.documents"),
  others: token("root.others"),
  _storage: token("root.storage"),
  _scheduled_functions: token("root.scheduled"),
};

/**
 * A value of any kind, which a drawn value puts where its validator wants
 * another: every id and the handle among them.
 */
const anyValue = (draw: () => number): unknown =>
  pick(draw, [
    () => null,
    () => pick(draw, floats),
    () => pick(draw, ints),
    () => draw() < 0.5,
    () => pick(draw, strings),
    () => bytesOf(draw),
    () => [],
    () => [pick(draw, floats)],
    () => ({}),
    () => ({ x: pick(draw, strings) }),
    () => token(pick(draw, idNames)),
    () => token(pick(draw, idNames)),
    () => FUNCTION,
  ])();

/**
 * A value `validator` accepts, broken at each node with probability `breaks`: a
 * node replaced by a value of any kind, an object's required field left out, or
 * an extra field added.
 */
const valueOf = (
  validator: GenericValidator,
  draw: () => number,
  breaks: number,
  top = false,
): unknown => {
  if (!top && draw() < breaks)
    // A broken id is most often another table's or component's id.
    return validator.kind === "id" && draw() < 0.7
      ? token(pick(draw, idNames))
      : anyValue(draw);
  switch (validator.kind) {
    case "any":
      return anyValue(draw);
    case "null":
      return null;
    case "float64":
      return pick(draw, floats);
    case "int64":
    case "commitTs":
      return pick(draw, ints);
    case "boolean":
      return draw() < 0.5;
    case "string":
      return pick(draw, strings);
    case "bytes":
      return bytesOf(draw);
    case "function":
      return FUNCTION;
    case "id":
      return rootIds[validator.tableName]!;
    case "literal":
      return validator.value;
    case "union":
      return valueOf(pick(draw, validator.members), draw, breaks);
    case "array":
      return Arr.makeBy(Math.floor(draw() * 4), () =>
        valueOf(validator.element, draw, breaks),
      );
    case "record": {
      const record: Record<string, unknown> = {};
      for (let count = Math.floor(draw() * 4); count > 0; count--)
        record[pick(draw, fieldNames)] = valueOf(validator.value, draw, breaks);
      return record;
    }
    case "object": {
      const object: Record<string, unknown> = {};
      const fields = validator.fields as Readonly<
        Record<string, GenericValidator>
      >;
      for (const [name, field] of Rec.toEntries(fields)) {
        const optional = field.isOptional === "optional";
        if (optional && draw() < 0.5) continue;
        if (!optional && draw() < breaks / 2) continue;
        object[name] = valueOf(field, draw, breaks);
      }
      if (draw() < breaks / 2) {
        const extra = pick(draw, [...fieldNames, "extra"]);
        if (!(extra in fields)) object[extra] = anyValue(draw);
      }
      return object;
    }
  }
};

/**
 * `value` with each placeholder replaced by `names`' string for it.
 */
const resolved = (
  value: unknown,
  names: Readonly<Record<string, string>>,
): unknown => {
  if (typeof value === "string") return names[value] ?? value;
  if (Arr.isArray(value))
    return Arr.map(value, (item) => resolved(item, names));
  if (
    value instanceof ArrayBuffer ||
    value === null ||
    typeof value !== "object"
  )
    return value;
  return Rec.map(value as Record<string, unknown>, (item) =>
    resolved(item, names),
  );
};

/**
 * One case: a shape, a value drawn for it, and the caller its batch runs in.
 */
interface Case {
  readonly shape: number;
  readonly value: unknown;
  readonly valid: boolean;
}

const casesOf = (seed: number): ReadonlyArray<Case> => {
  const draw = stream(seed);
  return Arr.flatMap(
    Arr.makeBy(shapes.length, (shape) => shape),
    (shape) =>
      Arr.makeBy(VALUES_PER_SHAPE, (index) => {
        const valid = index % 4 === 0;
        return {
          shape,
          valid,
          value: valueOf(shapes[shape]!, draw, valid ? 0 : 0.25, true),
        };
      }),
  );
};

const pad = (index: number) => pipe(String(index), Str.padStart(2, "0"));

/**
 * A backend's strings for each placeholder, and its strings by name for the
 * refusals.
 */
interface Backend {
  readonly calls: Calls;
  readonly handles: (shape: number) => { arg: string; echo: string };
  readonly tokens: Readonly<Record<string, string>>;
  readonly names: ReadonlyArray<readonly [string, string]>;
}

const backendOf = (
  calls: Calls,
  minted: Minted,
  handle: string,
  handles: Backend["handles"],
): Backend => ({
  calls,
  handles,
  tokens: {
    ...Rec.fromEntries(Arr.map(idNames, (name) => [token(name), minted[name]])),
    [FUNCTION]: handle,
  },
  names: [
    ...Arr.map(idNames, (name) => [minted[name], name] as const),
    [handle, "handle"] as const,
  ],
});

const kernelBackend = (): Promise<Backend> => {
  const slot = (name: string) => {
    const index = Number(pipe(name, Str.slice(-2)));
    return pipe(name, Str.startsWith("differential/echo"))
      ? { args: v.object({ value: v.any() }), returns: shapes[index]! }
      : { args: shapes[index]!, returns: undefined };
  };
  const calls = kernelCalls(
    sinkOf(slot, (name, args) =>
      pipe(name, Str.startsWith("differential/echo"))
        ? (args as { value: unknown }).value
        : null,
    ),
  );
  const handles = (shape: number) => ({
    arg: `function://~sink;differential/shape${pad(shape)}`,
    echo: `function://~sink;differential/echo${pad(shape)}`,
  });
  return mint(calls).then((minted) =>
    backendOf(calls, minted, handles(0).arg, handles),
  );
};

const binaryBackend = (client: Calls): Promise<Backend> => {
  const calls = binaryCalls(client);
  return Promise.all([
    mint(calls),
    Promise.all(
      Arr.makeBy(shapes.length, (shape) =>
        Promise.all([
          handleOf(calls, `shape${pad(shape)}`, "differential"),
          handleOf(calls, `echo${pad(shape)}`, "differential"),
        ]),
      ),
    ),
  ]).then(([minted, made]) => {
    const handles = (shape: number) => ({
      arg: made[shape]![0],
      echo: made[shape]![1],
    });
    return backendOf(calls, minted, handles(0).arg, handles);
  });
};

/**
 * Each case's two calls on `backend`, in order: the value as the shape's
 * arguments, then as its echo's return.
 */
const run = (
  backend: Backend,
  cases: ReadonlyArray<Case>,
): Promise<ReadonlyArray<Refusal>> => {
  const calls: ReadonlyArray<Call> = Arr.flatMap(cases, (entry) => {
    const handles = backend.handles(entry.shape);
    const value = resolved(entry.value, backend.tokens);
    return [
      { handle: handles.arg, args: value },
      { handle: handles.echo, args: { value } },
    ];
  });
  const batches = Arr.chunksOf(calls, BATCH);
  return Promise.all(
    Arr.map(batches, (batch, index) =>
      refusalsIn(
        backend.calls,
        (index % 2 === 0 ? "fromMutation" : "fromAction") as Caller,
        batch,
      ),
    ),
  ).then((outcomes) =>
    Arr.map(Arr.flatten(outcomes), (refusal) =>
      normalized(refusal, backend.names),
    ),
  );
};

const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * The table number a binary document id encodes: its base32 bytes begin with
 * the number as a little-endian varint (convex-backend `cccbade4`,
 * `crates/value/src/id_v6.rs`).
 */
const tableNumber = (id: string): number => {
  let bits = 0n;
  for (const character of id)
    bits =
      (bits << 5n) |
      BigInt(Option.getOrElse(pipe(alphabet, Str.indexOf(character)), () => 0));
  const length = Math.floor((id.length * 5) / 8);
  const bytes = Arr.makeBy(length, (index) =>
    Number((bits >> BigInt(id.length * 5 - 8 * (index + 1))) & 0xffn),
  );
  let number = 0;
  for (const [index, byte] of bytes.entries()) {
    number |= (byte & 0x7f) << (7 * index);
    if (byte < 0x80) break;
  }
  return number;
};

const printed = (value: unknown) =>
  stringify(convexToJson(resolved(value, {}) as Value));

layer(LocalBackend.plainLayer, { timeout: "600 seconds" })(
  "the binary's validation errors, by a seeded differential",
  (it) => {
    it.effect(
      "numbers each component's user tables as a fresh push does, which the kernel models: indexed tables first, each group in name order",
      () =>
        Effect.gen(function* () {
          const { client } = yield* LocalBackend.LocalBackend;
          const ids = yield* Effect.promise(() => mint(binaryCalls(client)));
          expect({
            "root.documents": tableNumber(ids["root.documents"]),
            "root.others": tableNumber(ids["root.others"]),
            "aaa.others": tableNumber(ids["aaa.others"]),
            "aaa.documents": tableNumber(ids["aaa.documents"]),
          }).toEqual({
            "root.documents": 10001,
            "root.others": 10002,
            "aaa.others": 10001,
            "aaa.documents": 10002,
          });
        }),
    );

    it.effect(
      "refuses each drawn value as the binary does, as arguments and as a held return",
      () =>
        Effect.gen(function* () {
          const seed = yield* valueSeed;
          const cases = casesOf(seed);
          const { client } = yield* LocalBackend.LocalBackend;
          const binary = yield* Effect.promise(() => binaryBackend(client));
          const kernel = yield* Effect.promise(kernelBackend);
          const [onBinary, onKernel] = yield* Effect.promise(() =>
            Promise.all([run(binary, cases), run(kernel, cases)]),
          );
          const differing = Arr.filterMap(onBinary, (expected, index) => {
            const actual = onKernel[index]!;
            if (stringify(expected) === stringify(actual))
              return Result.failVoid;
            const entry = cases[Math.floor(index / 2)]!;
            return Result.succeed({
              case: Math.floor(index / 2),
              shape: entry.shape,
              as: index % 2 === 0 ? "arguments" : "return",
              caller:
                Math.floor(index / BATCH) % 2 === 0
                  ? "fromMutation"
                  : "fromAction",
              value: printed(entry.value),
              binary: expected,
              kernel: actual,
            });
          });
          const refused = Arr.filter(onBinary, (outcome) => !outcome.returned);
          expect(cases.length).toBeGreaterThanOrEqual(2000);
          // Most broken values are refused, and every valid one returns.
          expect(refused.length).toBeGreaterThan(cases.length / 2);
          expect(
            Arr.filter(
              Arr.map(cases, (entry, index) => ({
                entry,
                outcomes: [onBinary[2 * index]!, onBinary[2 * index + 1]!],
              })),
              ({ entry, outcomes }) =>
                entry.valid &&
                !Arr.every(outcomes, (outcome) => outcome.returned),
            ).length,
          ).toBe(0);
          expect(
            Arr.take(differing, 5),
            `value seed ${seed}: ${differing.length} of ${onBinary.length} calls differ`,
          ).toEqual([]);
        }),
    );
  },
);
