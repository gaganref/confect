import { Callback, type Ref } from "@confect/core";
import type { DatabaseSchema, RegisteredConvexFunction } from "@confect/server";
import { ConvexError, convexToJson, type Value } from "convex/values";
import * as Arbitrary from "effect/Arbitrary";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Execution from "./internal/Execution.js";
import { openSession, type TestConfigMissing } from "./internal/Backend.js";
import {
  Session,
  type AnyPort,
  type Config,
  type GeneratedApp,
  type Law,
  type Mount,
  type Setting,
} from "./TestBackend.js";
import type { TestConfect } from "./TestConfect.js";

/**
 * A proof a component owes, and nothing else: each exported function's
 * contract, its laws, and each callback slot's contract. A component owes no
 * access or realm proof, so neither kind is here.
 */
export type ComponentObligation =
  | { readonly kind: "export"; readonly ref: string }
  | { readonly kind: "laws" }
  | { readonly kind: "callback"; readonly slot: string };

type Tag<E> = E extends { readonly _tag: infer T extends string } ? T : never;

/**
 * How the engine may answer a call to a slot of contract `C`: it returned, or
 * it failed with one of the contract's declared error tags.
 */
export type Outcome<C extends Callback.Any> =
  | "returned"
  | Tag<Callback.Error<C>>;

/**
 * A callback slot: a contract declared in the component's `callbacks.ts` that
 * one of its function arguments or tables holds a handle for. `handle` names
 * the session's sink, and `outcomes` lists every answer the contract allows.
 */
export interface Slot<C extends Callback.Any> {
  readonly contract: C;
  readonly handle: Callback.Handle<C>;
  readonly outcomes: ReadonlyArray<Outcome<C>>;
}

export type AnySlot = Slot<any>;

type ContractOf<S> = S extends Slot<infer C> ? C : never;

/**
 * A call the component made to one of its slots, as the sink held it, and the
 * outcome the engine answered it with.
 */
export interface HeldCallback {
  readonly kind: "callback";
  readonly slot: string;
  readonly args: unknown;
  readonly outcome: string;
}

/**
 * The component's tables after a call: each table's documents, as stored and
 * without system fields, in creation order. A table left out is empty.
 */
export type Postimage = Readonly<
  Record<string, ReadonlyArray<Readonly<Record<string, unknown>>>>
>;

/**
 * A component session's test service. It has no `withIdentity`: a component
 * runs with no caller identity, so a test cannot give it one.
 */
export type ComponentRuntime<S extends DatabaseSchema.AnyWithProps> = Omit<
  TestConfect<S>,
  "withIdentity"
>;

export const ComponentRuntime = <S extends DatabaseSchema.AnyWithProps>() =>
  Context.Service<ComponentRuntime<S>>(
    "@confect/test/TestComponent/ComponentRuntime",
  );

/**
 * What a component session holds beyond the backend: the outcome each slot's
 * next calls are answered with, every held call, and the tables' image.
 */
export interface Engine {
  readonly answer: (slot: string, outcome: string) => Effect.Effect<void>;
  readonly held: Effect.Effect<ReadonlyArray<HeldCallback>>;
  readonly image: Effect.Effect<Postimage>;
}

export class Callbacks extends Context.Service<Callbacks, Engine>()(
  "@confect/test/TestComponent/Callbacks",
) {}

export interface LayerOptions<
  S extends DatabaseSchema.AnyWithProps,
  C extends ReadonlyArray<Setting>,
> {
  readonly config: Config<C>;
  /**
   * Writes in one private mutation, after every mount's `init`. A slot's
   * `handle` is the value to store where the component keeps one.
   */
  readonly seed?: Effect.Effect<
    void,
    never,
    RegisteredConvexFunction.MutationServices<S>
  >;
  /**
   * The seed of the draws that answer a slot with `returned`. Defaults to `0`.
   */
  readonly draws?: number;
}

/**
 * The subject codegen writes in a component's `_generated/testing.ts`: its refs
 * `F`, its exported functions `T` by `group:name`, its provider ports `P`, its
 * callback slots `C` by contract id, its laws and obligations, and a `layer`
 * that opens it on the kernel. It has no groups, and no manifest digest, since
 * only an app writes a manifest.
 */
export interface GeneratedComponent<
  F,
  T extends Readonly<Record<string, Ref.AnyPublic>>,
  P extends Readonly<Record<string, AnyPort>>,
  C extends Readonly<Record<string, AnySlot>>,
  S extends DatabaseSchema.AnyWithProps = DatabaseSchema.AnyWithProps,
  G extends ReadonlyArray<Setting> = ReadonlyArray<Setting>,
  L extends ReadonlyArray<Law> = ReadonlyArray<Law>,
  B extends ReadonlyArray<ComponentObligation> =
    ReadonlyArray<ComponentObligation>,
> {
  readonly kind: "component";
  readonly refs: F;
  readonly functions: T;
  readonly ports: P;
  readonly slots: C;
  readonly laws: L;
  readonly obligations: B;
  readonly mounts: ReadonlyArray<Mount>;
  readonly settings: G;
  readonly app: GeneratedApp<S>;
  /**
   * Open a fresh session on the kernel, as an app's opens: every module loads,
   * each mount's `init` runs, then `seed`. Every call to a slot's handle holds
   * as a `callback` command the engine answers.
   */
  readonly layer: (
    options: LayerOptions<S, G>,
  ) => Layer.Layer<
    ComponentRuntime<S> | Callbacks | Session,
    TestConfigMissing
  >;
}

export type AnyGeneratedComponent = GeneratedComponent<
  unknown,
  Readonly<Record<string, Ref.AnyPublic>>,
  Readonly<Record<string, AnyPort>>,
  Readonly<Record<string, AnySlot>>,
  any,
  ReadonlyArray<Setting>
>;

const tagOf = (schema: Schema.Top): string | undefined => {
  const ast = Schema.toEncoded(schema).ast;
  if (ast._tag !== "Objects") return undefined;
  const tag = ast.propertySignatures.find((p) => p.name === "_tag")?.type;
  return tag?._tag === "Literal" && typeof tag.literal === "string"
    ? tag.literal
    : undefined;
};

/**
 * The declared error members of a contract, by tag.
 */
const errorsOf = (contract: Callback.Any): ReadonlyMap<string, Schema.Top> => {
  const error = (contract.functionProvenance as { readonly error?: Schema.Top })
    .error;
  if (error === undefined) return new Map();
  const members: ReadonlyArray<Schema.Top> =
    "members" in error && Array.isArray(error.members)
      ? (error.members as ReadonlyArray<Schema.Top>)
      : [error];
  const byTag = new Map<string, Schema.Top>();
  for (const member of members) {
    const tag = tagOf(member);
    if (tag !== undefined) byTag.set(tag, member);
  }
  return byTag;
};

/**
 * Declares one generated slot: its sink handle and its outcomes.
 */
export const slot = <C extends Callback.Any>(contract: C): Slot<C> => ({
  contract,
  handle: Schema.decodeSync(Callback.handle(contract))(
    `function://${Execution.SINK};${contract.id}`,
  ) as Callback.Handle<C>,
  outcomes: ["returned", ...errorsOf(contract).keys()] as ReadonlyArray<
    Outcome<C>
  >,
});

/**
 * One value of `drawn`'s type under `seed`, encoded with `codec`.
 */
const draw = (
  drawn: Schema.Top,
  codec: Schema.Codec<unknown, unknown>,
  seed: string,
): Effect.Effect<unknown> =>
  Arbitrary.sampleEffect(Arbitrary.schema(drawn as never), {
    count: 1,
    seed,
  }).pipe(
    Effect.flatMap(([value]) => Schema.encodeUnknownEffect(codec)(value)),
    Effect.orDie,
  );

/**
 * The sink a component session gives the kernel: each call is held, then
 * answered with the slot's planned outcome, `returned` until a test plans
 * another, with a value drawn from the contract's codec under the draw seed.
 */
const makeEngine = (
  slots: Readonly<Record<string, AnySlot>>,
  draws: number,
) => {
  const planned = new Map<string, string>();
  const held: Array<HeldCallback> = [];
  const sink: Execution.Sink = ({ slot: id, args }) => {
    const found = slots[id];
    if (found === undefined)
      return Promise.reject(
        new Error(
          `The component called the callback slot ${id}, which it does not declare.`,
        ),
      );
    const outcome = planned.get(id) ?? "returned";
    const index = held.length;
    held.push({ kind: "callback", slot: id, args, outcome });
    const seed = `${draws}:${id}:${index}`;
    const provenance = found.contract.functionProvenance as {
      readonly returns: Schema.Codec<unknown, unknown>;
      readonly error: Schema.Codec<unknown, unknown>;
    };
    if (outcome === "returned")
      return Effect.runPromise(
        draw(provenance.returns, provenance.returns, seed),
      );
    return Effect.runPromise(
      draw(errorsOf(found.contract).get(outcome)!, provenance.error, seed),
    ).then((encoded) => Promise.reject(new ConvexError(encoded as Value)));
  };
  const answer = (id: string, outcome: string) =>
    Effect.suspend(() => {
      const found = slots[id];
      if (found === undefined)
        return Effect.die(new Error(`No callback slot ${id}.`));
      if (!(found.outcomes as ReadonlyArray<string>).includes(outcome))
        return Effect.die(
          new Error(
            `The callback slot ${id} has no outcome ${outcome}; its contract allows ${found.outcomes.join(", ")}.`,
          ),
        );
      planned.set(id, outcome);
      return Effect.void;
    });
  return { sink, answer, held: Effect.sync(() => [...held]) };
};

const withoutSystemFields = (doc: Record<string, unknown>) => {
  const { _id: _, _creationTime: __, ...fields } = doc;
  return fields;
};

/**
 * Assemble the generated component subject. Only `_generated/testing.ts` calls
 * this.
 */
export const make = <
  F,
  const T extends Readonly<Record<string, Ref.AnyPublic>>,
  const P extends Readonly<Record<string, AnyPort>>,
  const C extends Readonly<Record<string, AnySlot>>,
  S extends DatabaseSchema.AnyWithProps,
  const G extends ReadonlyArray<Setting>,
  const L extends ReadonlyArray<Law>,
  const B extends ReadonlyArray<ComponentObligation>,
>(
  app: GeneratedApp<S>,
  declaration: {
    readonly refs: F;
    readonly functions: T;
    readonly ports: P;
    readonly slots: C;
    readonly laws: L;
    readonly obligations: B;
    readonly mounts: ReadonlyArray<Mount>;
    readonly settings: G;
  },
): GeneratedComponent<F, T, P, C, S, G, L, B> => ({
  ...declaration,
  kind: "component",
  app,
  layer: ({ config, seed, draws }) => {
    const runtime = ComponentRuntime<S>();
    return Layer.effectContext(
      Effect.gen(function* () {
        const engine = makeEngine(declaration.slots, draws ?? 0);
        const opened = yield* openSession(
          app,
          declaration.settings,
          config,
          seed,
          engine.sink,
        );
        const { withIdentity: _, ...service } = opened.service;
        const tables = Object.keys(
          (app.convexSchema as unknown as { tables: object }).tables,
        ).sort();
        const image = Effect.promise((): Promise<Postimage> =>
          opened.raw.run((ctx: any) =>
            Promise.all(
              tables.map((table) => ctx.db.query(table).collect()),
            ).then(
              (all: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>) =>
                Object.fromEntries(
                  tables.flatMap((table, index) =>
                    all[index]!.length === 0
                      ? []
                      : [[table, all[index]!.map(withoutSystemFields)]],
                  ),
                ),
            ),
          ),
        );
        return Context.make(runtime, service).pipe(
          Context.add(Callbacks, {
            answer: engine.answer,
            held: engine.held,
            image,
          }),
          Context.add(Session, opened.session),
        );
      }),
    );
  },
});

/**
 * Plan the outcome a slot's next calls are answered with.
 */
export const answer = <
  C extends Readonly<Record<string, AnySlot>>,
  K extends keyof C & string,
>(
  _subject: { readonly slots: C },
  name: K,
  outcome: Outcome<ContractOf<C[K]>>,
): Effect.Effect<void, never, Callbacks> =>
  Effect.gen(function* () {
    yield* (yield* Callbacks).answer(name, outcome);
  });

/**
 * Every call the component made to its slots so far, as held.
 */
export const held: Effect.Effect<
  ReadonlyArray<HeldCallback>,
  never,
  Callbacks
> = Effect.gen(function* () {
  return yield* (yield* Callbacks).held;
});

type ArgsOf<R> = keyof Ref.Args<R> extends never
  ? { readonly args?: Ref.Args<R> }
  : { readonly args: Ref.Args<R> };

/**
 * One case of an exported function's contract: its args, then a literal return
 * and the postimage, or one of its declared errors.
 */
export type ExportCase<R> = ArgsOf<R> & { readonly name: string } & (
    | { readonly returns: Ref.Returns<R>; readonly postimage: Postimage }
    | { readonly fails: Tag<Ref.Error<R>> }
  );

/**
 * At least one case per exported function, so a missing function does not
 * compile.
 */
export type ExportRows<T> = {
  readonly [K in keyof T]: readonly [
    ExportCase<T[K]>,
    ...Array<ExportCase<T[K]>>,
  ];
};

/**
 * One exported call that triggers a slot, and the component's postimage once
 * the engine answered the slot.
 */
export type CallbackCase<T> = {
  readonly [K in keyof T & string]: ArgsOf<T[K]> & { readonly call: K };
}[keyof T & string] & { readonly name: string; readonly postimage: Postimage };

/**
 * A case per slot per outcome, so a missing slot or outcome does not compile.
 */
export type CallbackRows<T, C> = {
  readonly [K in keyof C]: {
    readonly [O in Outcome<ContractOf<C[K]>>]: CallbackCase<T>;
  };
};

export class CaseFailed extends Schema.TaggedError<CaseFailed>()("CaseFailed", {
  case: Schema.String,
  reason: Schema.String,
}) {}

/**
 * One runnable case and the obligation it pays. Each run opens a fresh session
 * with the options the caller passes.
 */
export interface Case<Options> {
  readonly name: string;
  readonly owes: ComponentObligation;
  readonly run: (options: Options) => Effect.Effect<void, CaseFailed>;
}

type OptionsOf<Subject> =
  Subject extends GeneratedComponent<
    any,
    any,
    any,
    any,
    infer S,
    infer G,
    any,
    any
  >
    ? LayerOptions<S, G>
    : never;

const canonical = (value: unknown): string =>
  JSON.stringify(convexToJson(value as Value), (_, v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : Number(a > b))),
        )
      : v,
  );

const call = (
  service: ComponentRuntime<any>,
  ref: Ref.AnyPublic,
  args: unknown,
) =>
  (ref.functionType === "query"
    ? service.query(ref as never, args as never)
    : ref.functionType === "action"
      ? service.action(ref as never, args as never)
      : service.mutation(ref as never, args as never)) as Effect.Effect<
    unknown,
    { readonly _tag: string }
  >;

const encodedReturn = (ref: Ref.AnyPublic, value: unknown) =>
  ref._tag === "Confect" ? Schema.encodeUnknownSync(ref.returns)(value) : value;

const runCase = <Subject extends AnyGeneratedComponent>(
  subject: Subject,
  name: string,
  options: OptionsOf<Subject>,
  body: (
    service: ComponentRuntime<any>,
    engine: Engine,
  ) => Effect.Effect<void, CaseFailed>,
) =>
  Effect.gen(function* () {
    const service = yield* ComponentRuntime<any>();
    const engine = yield* Callbacks;
    yield* body(service, engine);
  }).pipe(
    Effect.provide(subject.layer(options as never)),
    Effect.catchTag("TestConfigMissing", (error: TestConfigMissing) =>
      Effect.fail(new CaseFailed({ case: name, reason: error.message })),
    ),
  ) as Effect.Effect<void, CaseFailed>;

const checkImage = (name: string, engine: Engine, expected: Postimage) =>
  Effect.flatMap(engine.image, (actual) => {
    const wanted = Object.fromEntries(
      Object.entries(expected).filter(([, docs]) => docs.length > 0),
    );
    return canonical(actual) === canonical(wanted)
      ? Effect.void
      : Effect.fail(
          new CaseFailed({
            case: name,
            reason: `the postimage is ${canonical(actual)}, not ${canonical(wanted)}`,
          }),
        );
  });

/**
 * The exported contract as runnable cases, total over the subject's functions
 * by type. A returning case checks the encoded return and the postimage; a
 * failing one checks the declared error's tag.
 */
export const exports = <Subject extends AnyGeneratedComponent>(
  subject: Subject,
  rows: ExportRows<Subject["functions"]>,
): ReadonlyArray<Case<OptionsOf<Subject>>> =>
  Object.entries(rows as Record<string, ReadonlyArray<any>>).flatMap(
    ([ref, cases]) =>
      cases.map((row): Case<OptionsOf<Subject>> => {
        const name = `${ref} ${row.name}`;
        const fn = subject.functions[ref]!;
        return {
          name,
          owes: { kind: "export", ref },
          run: (options) =>
            runCase(subject, name, options, (service, engine) =>
              Effect.gen(function* () {
                const result = yield* Effect.result(
                  call(service, fn, row.args ?? {}),
                );
                if ("fails" in row) {
                  const tag =
                    result._tag === "Failure"
                      ? result.failure._tag
                      : "a return";
                  if (tag !== row.fails)
                    return yield* new CaseFailed({
                      case: name,
                      reason: `expected ${row.fails}, got ${tag}`,
                    });
                  return;
                }
                if (result._tag === "Failure")
                  return yield* new CaseFailed({
                    case: name,
                    reason: `expected a return, got ${result.failure._tag}`,
                  });
                const actual = canonical(encodedReturn(fn, result.success));
                const expected = canonical(encodedReturn(fn, row.returns));
                if (actual !== expected)
                  return yield* new CaseFailed({
                    case: name,
                    reason: `returned ${actual}, not ${expected}`,
                  });
                yield* checkImage(name, engine, row.postimage);
              }),
            ),
        };
      }),
  );

/**
 * The callback contract as runnable cases, total over every slot and outcome by
 * type. Each plans the slot's outcome, makes its exported call, checks the slot
 * was held with that outcome, and checks the postimage.
 */
export const callbacks = <Subject extends AnyGeneratedComponent>(
  subject: Subject,
  rows: CallbackRows<Subject["functions"], Subject["slots"]>,
): ReadonlyArray<Case<OptionsOf<Subject>>> =>
  Object.entries(
    rows as Record<string, Record<string, CallbackCase<Record<string, any>>>>,
  ).flatMap(([slotId, outcomes]) =>
    Object.entries(outcomes).map(([outcome, row]): Case<OptionsOf<Subject>> => {
      const name = `${slotId} ${outcome} ${row.name}`;
      return {
        name,
        owes: { kind: "callback", slot: slotId },
        run: (options) =>
          runCase(subject, name, options, (service, engine) =>
            Effect.gen(function* () {
              yield* engine.answer(slotId, outcome);
              yield* Effect.ignore(
                call(service, subject.functions[row.call]!, row.args ?? {}),
              );
              const calls = yield* engine.held;
              if (
                !calls.some((c) => c.slot === slotId && c.outcome === outcome)
              )
                return yield* new CaseFailed({
                  case: name,
                  reason: `${row.call} never called the slot ${slotId}`,
                });
              yield* checkImage(name, engine, row.postimage);
            }),
          ),
      };
    }),
  );

/**
 * The laws a component owes over the image `seed` writes. A typed slot: Frame's
 * testing door checks each law, as it does for an app.
 */
export const laws = <Subject extends AnyGeneratedComponent>(
  subject: Subject,
  seed: OptionsOf<Subject>["seed"],
): {
  readonly owes: { readonly kind: "laws" };
  readonly laws: Subject["laws"];
  readonly seed: OptionsOf<Subject>["seed"];
} => ({ owes: { kind: "laws" }, laws: subject.laws, seed });
