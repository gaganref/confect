/**
 * The plain fixture's callback probe on the binary and on the test kernel: a
 * caller in a mutation or an action that calls a host function's handle and
 * returns what reached it. On the kernel the same handle names a sink slot that
 * declares the host function's validators. Both backends mount the child
 * components `aaa` and `bbb`, whose tables are numbered in their own
 * namespaces.
 */
import { makeFunctionReference } from "convex/server";
import type { GenericValidator } from "convex/values";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Order from "effect/Order";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { convexTest } from "../../../test/src/internal/ConvexTest";
import type { Sink } from "../../../test/src/internal/Sink";
import type { Refusal } from "../../../../tools/local-backend/fixtures/plain/convex/callbackArgs";
import schema from "../../../../tools/local-backend/fixtures/plain/convex/schema";
import aaaSchema from "../../../../tools/local-backend/fixtures/plain/aaa/schema";
import bbbSchema from "../../../../tools/local-backend/fixtures/plain/bbb/schema";
import { childTables } from "../../../../tools/local-backend/fixtures/plain/convex/differentialShapes";

export type { Refusal };

export type Caller = "fromMutation" | "fromAction";

export interface Calls {
  readonly mutation: (reference: any, args: any) => Promise<any>;
  readonly action: (reference: any, args: any) => Promise<any>;
}

export type Call = {
  readonly handle: string;
  readonly args: unknown;
};

const refs = {
  fromMutation: makeFunctionReference<"mutation", Call, Refusal>(
    "callbackArgs:fromMutation",
  ),
  fromAction: makeFunctionReference<"action", Call, Refusal>(
    "callbackArgs:fromAction",
  ),
  fromMutationBatch: makeFunctionReference<
    "mutation",
    { calls: ReadonlyArray<Call> },
    ReadonlyArray<Refusal>
  >("callbackArgs:fromMutationBatch"),
  fromActionBatch: makeFunctionReference<
    "action",
    { calls: ReadonlyArray<Call> },
    ReadonlyArray<Refusal>
  >("callbackArgs:fromActionBatch"),
  handle: makeFunctionReference<
    "mutation",
    { target?: string; module?: string },
    string
  >("callbackArgs:handle"),
  mint: makeFunctionReference<
    "mutation",
    Record<string, never>,
    {
      root: { documents: string; others: string; scheduled: string };
      aaa: Record<string, string>;
      bbb: Record<string, string>;
    }
  >("callbackArgs:mint"),
  store: makeFunctionReference<
    "action",
    Record<string, never>,
    { root: string; aaa: string }
  >("callbackArgs:store"),
};

/**
 * What one call to `handle` with `args` handed `caller`.
 */
export const refusalIn = (
  calls: Calls,
  caller: Caller,
  { handle, args }: Call,
): Promise<Refusal> =>
  caller === "fromMutation"
    ? calls.mutation(refs.fromMutation, { handle, args })
    : calls.action(refs.fromAction, { handle, args });

/**
 * What each call in `batch` handed `caller`, in order, from one caller
 * function.
 */
export const refusalsIn = (
  calls: Calls,
  caller: Caller,
  batch: ReadonlyArray<Call>,
): Promise<ReadonlyArray<Refusal>> =>
  caller === "fromMutation"
    ? calls.mutation(refs.fromMutationBatch, { calls: batch })
    : calls.action(refs.fromActionBatch, { calls: batch });

/**
 * A handle for `target` in `module`, as the host creates one.
 */
export const handleOf = (calls: Calls, target: string, module?: string) =>
  calls.mutation(refs.handle, {
    target,
    ...(module === undefined ? {} : { module }),
  });

/**
 * A backend's ids of each kind, by `<component>.<table>`: a document of each
 * user table, a scheduled job and a stored file, at the root and in `aaa`, and
 * a document of each of `bbb`'s drawn tables.
 */
export type Minted = Readonly<Record<IdName, string>>;

const fixedNames = [
  "root.documents",
  "root.others",
  "root.scheduled",
  "root.storage",
  "aaa.documents",
  "aaa.others",
  "aaa.scheduled",
  "aaa.storage",
] as const;

export type IdName = (typeof fixedNames)[number] | `bbb.t${number}`;

export const idNames: ReadonlyArray<IdName> = [
  ...fixedNames,
  ...Arr.map(childTables, ({ name }) => `bbb.${name}` as IdName),
];

export const mint = (calls: Calls): Promise<Minted> =>
  Promise.all([
    calls.mutation(refs.mint, {}),
    calls.action(refs.store, {}),
  ]).then(([documents, files]) => ({
    ...Rec.fromEntries(
      Arr.map(
        childTables,
        ({ name }) => [`bbb.${name}` as IdName, documents.bbb[name]!] as const,
      ),
    ),
    "root.documents": documents.root.documents,
    "root.others": documents.root.others,
    "root.scheduled": documents.root.scheduled,
    "root.storage": files.root,
    "aaa.documents": documents.aaa["documents"]!,
    "aaa.others": documents.aaa["others"]!,
    "aaa.scheduled": documents.aaa["scheduled"]!,
    "aaa.storage": files.aaa,
  }));

const plainSources = import.meta.glob<string>(
  [
    "../../../../tools/local-backend/fixtures/plain/convex/*.ts",
    "../../../../tools/local-backend/fixtures/plain/aaa/*.ts",
    "../../../../tools/local-backend/fixtures/plain/bbb/*.ts",
  ],
  { query: "?raw", import: "default" },
);

const sourceOf = (path: string): (() => Promise<string>) => {
  const source =
    plainSources[`../../../../tools/local-backend/fixtures/plain/${path}`];
  if (source === undefined)
    throw new Error(`The plain fixture has no ${path}.`);
  return source;
};

/**
 * The fixture's root functions and the child `aaa` on the test kernel, whose
 * handles under `function://~sink;` reach `sink`.
 */
export const kernelCalls = (sink: Sink): Calls => {
  const t = convexTest({
    schema,
    modules: {
      "_generated/server.ts": () => Promise.resolve({}),
      "callbackArgs.ts": () =>
        import("../../../../tools/local-backend/fixtures/plain/convex/callbackArgs"),
    },
    // The fixture's files as their own sources, so the kernel reads their
    // `"use node"` directive: their actions are plain Convex actions.
    sources: {
      "_generated/server.ts": () => Promise.resolve(""),
      "callbackArgs.ts": sourceOf("convex/callbackArgs.ts"),
    },
    sink,
  });
  t.registerComponent(
    "aaa",
    aaaSchema,
    {
      "_generated/server.ts": () => Promise.resolve({}),
      "ids.ts": () =>
        import("../../../../tools/local-backend/fixtures/plain/aaa/ids"),
    },
    {
      sources: {
        "_generated/server.ts": () => Promise.resolve(""),
        "ids.ts": sourceOf("aaa/ids.ts"),
      },
    },
  );
  t.registerComponent(
    "bbb",
    bbbSchema,
    {
      "_generated/server.ts": () => Promise.resolve({}),
      "ids.ts": () =>
        import("../../../../tools/local-backend/fixtures/plain/bbb/ids"),
    },
    {
      sources: {
        "_generated/server.ts": () => Promise.resolve(""),
        "ids.ts": sourceOf("bbb/ids.ts"),
      },
    },
  );
  return {
    mutation: (reference, args) => t.mutation(reference, args),
    action: (reference, args) => t.action(reference, args),
  };
};

/**
 * The fixture on the binary.
 */
export const binaryCalls = (client: Calls): Calls => ({
  mutation: (reference, args) => client.mutation(reference, args),
  action: (reference, args) => client.action(reference, args),
});

/**
 * A sink whose slot `<slot>` declares `declared[slot]`'s validators and answers
 * as `answer` does.
 */
export const sinkOf = (
  declared: (slot: string) =>
    | {
        readonly args: GenericValidator;
        readonly returns: GenericValidator | undefined;
      }
    | undefined,
  answer: (slot: string, args: unknown) => unknown,
): Sink => ({
  args: (slot) => declared(slot)?.args,
  returns: (slot) => declared(slot)?.returns,
  call: ({ slot, args }) => Promise.resolve(answer(slot, args)),
});

/**
 * `refusal` with each string `names` lists written as its name, since the two
 * backends mint different ids and handles.
 */
export const normalized = (
  refusal: Refusal,
  names: ReadonlyArray<readonly [actual: string, name: string]>,
): Refusal =>
  refusal.returned
    ? refusal
    : {
        ...refusal,
        message: Arr.reduce(
          // The longest first, so no name replaces part of a longer string.
          Arr.sort(
            names,
            Order.mapInput(
              Order.flip(Order.Number),
              ([actual]: readonly [string, string]) => actual.length,
            ),
          ),
          refusal.message,
          (message, [actual, name]) =>
            pipe(message, Str.replaceAll(actual, `<${name}>`)),
        ),
      };
