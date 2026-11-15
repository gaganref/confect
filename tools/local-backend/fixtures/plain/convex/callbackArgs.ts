import {
  actionGeneric,
  componentsGeneric,
  createFunctionHandle,
  internalMutationGeneric,
  makeFunctionReference,
  mutationGeneric,
} from "convex/server";
import { v, type Value } from "convex/values";

// A function handle called with arguments its target's validator refuses. Each
// caller catches what reaches it and returns it, so a probe sees what the
// binary hands a component whose callback slot it called with bad arguments.

/**
 * The arguments the host function a handle names takes, one of each kind of
 * validator, so a refusal shows how the binary prints each value and
 * validator.
 */
export const shape = {
  token: v.string(),
  count: v.number(),
  big: v.int64(),
  flag: v.boolean(),
  nothing: v.null(),
  tags: v.array(v.string()),
  nested: v.object({ a: v.string(), b: v.optional(v.number()) }),
  kind: v.union(v.literal("a"), v.literal(2)),
  scores: v.record(v.string(), v.number()),
  blob: v.bytes(),
  anything: v.any(),
  maybe: v.optional(v.string()),
};

export const onShape = mutationGeneric({
  args: shape,
  handler: () => Promise.resolve(null),
});

/**
 * The validator kinds `shape` leaves out: an id of a table, a function handle,
 * a commit timestamp, and bytes, which a refusal of a large value shows.
 */
export const kinds = {
  doc: v.id("documents"),
  callback: v.function(),
  stamp: v.commitTs(),
  blob: v.bytes(),
};

export const onKinds = mutationGeneric({
  args: kinds,
  handler: () => Promise.resolve(null),
});

/**
 * Three fields whose first problem is a missing field before a mismatch in key
 * order: `a` is required, `b` an object, `z` a number.
 */
export const order = {
  a: v.string(),
  b: v.object({ x: v.string() }),
  z: v.number(),
};

export const onOrder = mutationGeneric({
  args: order,
  handler: () => Promise.resolve(null),
});

/**
 * Literal fields, which the binary refuses with its literal message, and a
 * float literal it prints with a signed exponent.
 */
export const literal = {
  kind: v.literal("ready"),
  large: v.optional(v.literal(1e16)),
};

export const onLiteral = mutationGeneric({
  args: literal,
  handler: () => Promise.resolve(null),
});

/**
 * A host function that returns the value it is given, declaring `literal`.
 */
export const literalReturn = mutationGeneric({
  args: { value: v.any() },
  returns: v.object(literal),
  handler: (_ctx, { value }) => Promise.resolve(value as never),
});

/**
 * A host function whose declared return its answer may break: it returns the
 * ticket it is given, and declares a ticket an id of `documents`.
 */
export const badReturn = mutationGeneric({
  args: { ticket: v.string() },
  returns: v.object({ ticket: v.id("documents") }),
  handler: (_ctx, { ticket }) => Promise.resolve({ ticket } as never),
});

/**
 * A handle for a host function, as a host creates one for a component's slot:
 * `onShape` unless `target` names another, in this module unless `module` names
 * another.
 */
export const handle = mutationGeneric({
  args: { target: v.optional(v.string()), module: v.optional(v.string()) },
  handler: (_ctx, { target, module }) =>
    createFunctionHandle(
      makeFunctionReference<"mutation", Record<string, Value>, null>(
        `${module ?? "callbackArgs"}:${target ?? "onShape"}`,
      ),
    ),
});

/**
 * A new document of `table`'s id, for an argument an id validator accepts.
 */
export const makeDocument = mutationGeneric({
  args: { table: v.union(v.literal("documents"), v.literal("others")) },
  handler: (ctx, { table }) => ctx.db.insert(table, {}),
});

export const noop = internalMutationGeneric({
  args: {},
  handler: () => Promise.resolve(null),
});

const children = componentsGeneric() as unknown as {
  readonly aaa: {
    readonly ids: {
      readonly mint: never;
      readonly store: never;
    };
  };
  readonly bbb: { readonly ids: { readonly mint: never } };
};

/**
 * A new document's id in each table and a scheduled job's, here and in the
 * child component `aaa`, and a document's id in each of `bbb`'s drawn tables.
 * Each child's tables are numbered in its own namespace.
 */
export const mint = mutationGeneric({
  args: {},
  handler: (ctx) =>
    Promise.all([
      ctx.db.insert("documents", {}),
      ctx.db.insert("others", {}),
      ctx.scheduler.runAfter(
        1e9,
        makeFunctionReference<"mutation">("callbackArgs:noop"),
        {},
      ),
    ]).then(([documents, others, scheduled]) =>
      Promise.all([
        ctx.runMutation(children.aaa.ids.mint, {}),
        ctx.runMutation(children.bbb.ids.mint, {}),
      ]).then(([aaa, bbb]: [Value, Value]) => ({
        root: { documents, others, scheduled },
        aaa,
        bbb,
      })),
    ),
});

/**
 * A stored file's id here and in `aaa`.
 */
export const store = actionGeneric({
  args: {},
  handler: (ctx) =>
    ctx.storage
      .store(new Blob(["root"]))
      .then((root) =>
        ctx
          .runAction(children.aaa.ids.store, {})
          .then((child: string) => ({ root, aaa: child })),
      ),
});

/**
 * What reached the caller: the error's class and message, or that the call
 * returned.
 */
export type Refusal =
  | { readonly returned: true }
  | {
      readonly returned: false;
      readonly name: string;
      readonly message: string;
    };

const refusal = (call: () => Promise<unknown>): Promise<Refusal> =>
  call().then(
    (): Refusal => ({ returned: true }),
    (error: unknown): Refusal => ({
      returned: false,
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    }),
  );

const callerArgs = { handle: v.string(), args: v.any() };

export const fromMutation = mutationGeneric({
  args: callerArgs,
  handler: (ctx, { handle: text, args }) =>
    refusal(() => ctx.runMutation(text as never, args as Value as never)),
});

export const fromAction = actionGeneric({
  args: callerArgs,
  handler: (ctx, { handle: text, args }) =>
    refusal(() => ctx.runMutation(text as never, args as Value as never)),
});

const batchArgs = { calls: v.array(v.object(callerArgs)) };

/**
 * Each call's outcome, in order, one call after another.
 */
const inOrder = (
  calls: ReadonlyArray<{ handle: string; args: unknown }>,
  run: (handle: string, args: unknown) => Promise<unknown>,
): Promise<Array<Refusal>> => {
  let outcomes = Promise.resolve<Array<Refusal>>([]);
  for (const { handle: text, args } of calls)
    outcomes = outcomes.then((prior) =>
      refusal(() => run(text, args)).then((outcome) => [...prior, outcome]),
    );
  return outcomes;
};

/**
 * Each call's outcome, in order, for a batch of calls a mutation makes.
 */
export const fromMutationBatch = mutationGeneric({
  args: batchArgs,
  handler: (ctx, { calls }) =>
    inOrder(calls, (text, args) =>
      ctx.runMutation(text as never, args as Value as never),
    ),
});

/**
 * Each call's outcome, in order, for a batch of calls an action makes.
 */
export const fromActionBatch = actionGeneric({
  args: batchArgs,
  handler: (ctx, { calls }) =>
    inOrder(calls, (text, args) =>
      ctx.runMutation(text as never, args as Value as never),
    ),
});
