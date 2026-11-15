import { v, type GenericValidator } from "convex/values";

// The validator shapes of the seeded differential in
// `packages/server/test/local-backend/validationDifferential.test.ts`. Each is
// drawn from its own seeded stream when the module loads, so the binary's
// deployed functions and the test kernel's slots declare the same validators.

/**
 * A seeded stream of numbers in [0, 1), mulberry32.
 */
export const stream = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
};

export const pick = <A>(draw: () => number, items: ReadonlyArray<A>): A =>
  items[Math.floor(draw() * items.length)]!;

/**
 * The seed of the first shape's stream; shape `i` draws from `SHAPE_SEED + i`.
 */
export const SHAPE_SEED = 1115;

export const SHAPE_COUNT = 40;

/**
 * The tables an id validator names: the host's two and two system tables.
 */
export const tables = [
  "documents",
  "others",
  "_storage",
  "_scheduled_functions",
] as const;

/**
 * The values a literal validator holds: strings, floats the binary prints apart
 * from its values, an int64 and booleans.
 */
export const literals = [
  "ready",
  "a",
  "",
  'say "hi"',
  0,
  -1,
  1.5,
  0.00001,
  1e-7,
  1e16,
  1e21,
  7n,
  true,
  false,
] as const;

/**
 * The field names an object validator or value draws, which sort apart by case,
 * length and digit.
 */
export const fieldNames = ["a", "b", "z", "A", "Z", "aa", "a1", "x_y", "kind"];

const leaves: ReadonlyArray<(draw: () => number) => GenericValidator> = [
  () => v.null(),
  () => v.number(),
  () => v.int64(),
  () => v.boolean(),
  () => v.string(),
  () => v.bytes(),
  () => v.any(),
  () => v.commitTs(),
  () => v.function(),
  () =>
    v.function({
      fnType: "mutation",
      args: v.object({ x: v.string() }),
      returns: v.null(),
    }),
  (draw) => v.id(pick(draw, tables)),
  (draw) => v.id(pick(draw, tables)),
  (draw) => v.literal(pick(draw, literals)),
  (draw) => v.literal(pick(draw, literals)),
];

const fieldsOf = (
  draw: () => number,
  depth: number,
  count: number,
): Record<string, GenericValidator> => {
  const fields: Record<string, GenericValidator> = {};
  for (let added = 0; added < count;) {
    const name = pick(draw, fieldNames);
    if (name in fields) continue;
    const field = shapeOf(draw, depth + 1);
    fields[name] = draw() < 0.3 ? v.optional(field) : field;
    added++;
  }
  return fields;
};

/**
 * A validator drawn from `draw`, of any kind, nesting at most three deep.
 */
export const shapeOf = (
  draw: () => number,
  depth: number,
): GenericValidator => {
  const composite = depth < 3 ? draw() : 1;
  if (composite < 0.12) return v.array(shapeOf(draw, depth + 1));
  if (composite < 0.22)
    // The binary refuses a record of literal keys at push.
    return v.record(v.string(), shapeOf(draw, depth + 1));
  if (composite < 0.36)
    return v.object(fieldsOf(draw, depth, 1 + Math.floor(draw() * 3)));
  if (composite < 0.5) {
    const members = Array.from({ length: 1 + Math.floor(draw() * 3) }, () =>
      shapeOf(draw, depth + 1),
    );
    return v.union(
      ...(members as [GenericValidator, ...Array<GenericValidator>]),
    );
  }
  return pick(draw, leaves)(draw);
};

/**
 * Each shape: an object validator of two to five fields, the arguments one host
 * function takes and the return another declares.
 */
export const shapes: ReadonlyArray<
  Extract<GenericValidator, { readonly kind: "object" }>
> = Array.from({ length: SHAPE_COUNT }, (_, index) => {
  const draw = stream(SHAPE_SEED + index);
  return v.object(fieldsOf(draw, 0, 2 + Math.floor(draw() * 4)));
});
