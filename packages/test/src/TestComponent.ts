import { Callback, SchemaToValidator, type Ref } from "@confect/core";
import type { DatabaseSchema, RegisteredConvexFunction } from "@confect/server";
import { ConvexError, convexToJson, v, type Value } from "convex/values";
import * as Arbitrary from "effect/Arbitrary";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";
import * as Execution from "./internal/Execution.js";
import { stringify } from "./internal/Json.js";
import type { ValidatorJSON } from "./internal/KernelValues.js";
import {
  openSession,
  type MountInitFailed,
  type TestConfigMissing,
} from "./internal/Backend.js";
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
 * How a test may answer a call to a slot of contract `C`: it returned, or it
 * failed with one of the contract's declared error tags.
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
 * A call the component made to one of its slots, pending until the test answers
 * it. `input` is the call's args as they crossed the wire. The caller is the
 * function that made the call, or `undefined` for a scheduled job.
 */
export interface CallbackCommand<
  K extends string = string,
  O extends string = string,
> {
  readonly id: string;
  readonly kind: "callback";
  readonly slot: K;
  readonly input: unknown;
  readonly outcomes: ReadonlyArray<O>;
  readonly componentPath: string | undefined;
  readonly functionName: string | undefined;
}

/**
 * The commands a subject's slots can hold, one member per slot.
 */
export type CommandOf<C> = {
  readonly [K in keyof C & string]: CallbackCommand<
    K,
    Outcome<ContractOf<C[K]>>
  >;
}[keyof C & string];

/**
 * `answer` named a command the session does not hold: it was already answered,
 * or never held.
 */
export class StaleCommand extends Schema.TaggedError<
  StaleCommand,
  { readonly brand: unique symbol }
>()("StaleCommand", { id: Schema.String }) {
  override get message() {
    return `The session holds no callback command "${this.id}". It was already answered, or never held.`;
  }
}

/**
 * `answer` gave a command an outcome its slot's contract does not declare.
 */
export class UndeclaredOutcome extends Schema.TaggedError<
  UndeclaredOutcome,
  { readonly brand: unique symbol }
>()("UndeclaredOutcome", {
  id: Schema.String,
  slot: Schema.String,
  outcome: Schema.String,
  allowed: Schema.Array(Schema.String),
}) {
  override get message() {
    return `The callback slot ${this.slot} has no outcome ${this.outcome}; its contract allows ${Arr.join(this.allowed, ", ")}.`;
  }
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
 * What a component session holds beyond the backend: the pending callback
 * commands, how to answer one, the commands that arrived since a mark, and the
 * tables' image.
 */
export interface Engine {
  readonly commands: Effect.Effect<ReadonlyArray<CallbackCommand>>;
  readonly answer: (
    id: string,
    outcome: string,
  ) => Effect.Effect<void, StaleCommand | UndeclaredOutcome>;
  /**
   * How many commands have arrived since the session opened.
   */
  readonly mark: Effect.Effect<number>;
  /**
   * The command that arrived at position `at`, once it has.
   */
  readonly arrival: (at: number) => Effect.Effect<CallbackCommand>;
  readonly image: Effect.Effect<Postimage>;
}

export class Callbacks extends Context.Service<Callbacks, Engine>()(
  "@confect/test/TestComponent/Callbacks",
) {}

type InstallOption<I> = [I] extends [Ref.AnyConfect]
  ? {} extends Ref.Args<I>
    ? { readonly install?: Ref.Args<I> }
    : { readonly install: Ref.Args<I> }
  : { readonly install?: never };

export type LayerOptions<
  S extends DatabaseSchema.AnyWithProps,
  C extends ReadonlyArray<Setting>,
  I = undefined,
> = InstallOption<I> & {
  readonly config: Config<C>;
  /**
   * Writes in one private mutation, after every `init`. A slot's `handle` is
   * the value to store where the component keeps one.
   */
  readonly seed?: Effect.Effect<
    void,
    never,
    RegisteredConvexFunction.MutationServices<S>
  >;
  /**
   * The seed of the values a `returned` or declared-error answer draws.
   * Defaults to `0`.
   */
  readonly draws?: number;
};

/**
 * The subject codegen writes in a component's `_generated/testing.ts`: its refs
 * `F`, its exported functions `T` by `group:name`, its provider ports `P`, its
 * callback slots `C` by contract id, its own `init` `I` from its descriptor,
 * its laws and obligations, and a `layer` that opens it on the kernel. It has
 * no groups, and no manifest digest, since only an app writes a manifest.
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
  I extends Ref.AnyConfect | undefined = Ref.AnyConfect | undefined,
> {
  readonly kind: "component";
  readonly refs: F;
  readonly functions: T;
  readonly ports: P;
  readonly slots: C;
  readonly init: I;
  readonly laws: L;
  readonly obligations: B;
  readonly mounts: ReadonlyArray<Mount>;
  readonly settings: G;
  readonly app: GeneratedApp<S>;
  /**
   * Open a fresh session on the kernel, as a push initialises the component:
   * every module loads, its own `init` runs with `install`, then each mount's,
   * through the same traversal as an app's subject, then `seed`. A slot call
   * during `init` or `seed` returns at once. Every later one is held as a
   * `callback` command until the test answers it.
   */
  readonly layer: (
    options: LayerOptions<S, G, I>,
  ) => Layer.Layer<
    ComponentRuntime<S> | Callbacks | Session,
    TestConfigMissing | MountInitFailed
  >;
}

export type AnyGeneratedComponent = GeneratedComponent<
  unknown,
  Readonly<Record<string, Ref.AnyPublic>>,
  Readonly<Record<string, AnyPort>>,
  Readonly<Record<string, AnySlot>>,
  any,
  ReadonlyArray<Setting>,
  ReadonlyArray<Law>,
  ReadonlyArray<ComponentObligation>,
  any
>;

const tagOf = (schema: Schema.Top): string | undefined => {
  const ast = Schema.toEncoded(schema).ast;
  if (ast._tag !== "Objects") return undefined;
  return Arr.findFirst(ast.propertySignatures, (p) => p.name === "_tag").pipe(
    Option.map(({ type }) => type),
    Option.flatMap((type) =>
      type._tag === "Literal" && Predicate.isString(type.literal)
        ? Option.some(type.literal)
        : Option.none(),
    ),
    Option.getOrUndefined,
  );
};

/**
 * Each alternative of a union, through nested and suspended unions.
 */
const alternatives = (
  ast: SchemaAST.AST,
  seen: Set<SchemaAST.AST> = new Set(),
): Array<SchemaAST.AST> => {
  if (seen.has(ast)) return [];
  seen.add(ast);
  if (ast._tag === "Union")
    return Arr.flatMap(ast.types, (member) => alternatives(member, seen));
  if (ast._tag === "Suspend") return alternatives(ast.thunk(), seen);
  return [ast];
};

/**
 * The declared error alternatives of a contract, each with its own codec, by
 * tag.
 */
const errorsOf = (contract: Callback.Any): ReadonlyMap<string, Schema.Top> => {
  const error = (contract.functionProvenance as { readonly error?: Schema.Top })
    .error;
  const byTag = new Map<string, Schema.Top>();
  if (error === undefined) return byTag;
  for (const ast of alternatives(error.ast)) {
    const member = Schema.make<Schema.Top>(ast);
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
  // A generated module builds its slots as it loads, outside an Effect. A
  // handle decodes from any string, so the decode cannot fail.
  handle: Option.getOrThrowWith(
    Schema.decodeOption(Callback.handle(contract))(
      `function://${Execution.SINK};${contract.id}`,
    ),
    () => new Error(`The sink handle for ${contract.id} did not decode.`),
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

interface Pending {
  readonly command: CallbackCommand;
  readonly settle: (answer: Promise<unknown>) => void;
}

/**
 * The sink a component session gives the kernel. Until the session opens, a
 * slot call returns at once, so `init` and `seed` never wait. After that each
 * call is a pending command until `answer` settles it: `returned` with a value
 * drawn from the contract's return codec, or a declared error drawn from its
 * alternative's codec, both under the draw seed.
 */
const makeEngine = (
  slots: Readonly<Record<string, AnySlot>>,
  draws: number,
) => {
  let open = false;
  let next = 1;
  const pending = new Map<string, Pending>();
  const arrived: Array<CallbackCommand> = [];
  const waiting = new Set<() => void>();
  const outcome = (found: AnySlot, chosen: string, seed: string) => {
    const provenance = found.contract.functionProvenance as {
      readonly returns: Schema.Codec<unknown, unknown>;
      readonly error: Schema.Codec<unknown, unknown>;
    };
    if (chosen === "returned")
      return Effect.runPromise(
        draw(provenance.returns, provenance.returns, seed),
      );
    return Effect.runPromise(
      draw(errorsOf(found.contract).get(chosen)!, provenance.error, seed),
    ).then((encoded) =>
      // A function's thrown `ConvexError` leaves it with its data serialized
      // (`serializeConvexErrorData`, convex 1.49
      // `src/server/impl/registration_impl.ts:112-127`), and the kernel
      // decodes it for the caller as it decodes any nested call's error.
      Promise.reject(
        new ConvexError(stringify(convexToJson(encoded as Value))),
      ),
    );
  };
  const validators = new Map<string, ValidatorJSON>();
  /**
   * A slot's declared argument validator, compiled from its contract once.
   */
  const argsOf = (id: string): ValidatorJSON | undefined => {
    const found = slots[id];
    if (found === undefined) return undefined;
    let validator = validators.get(id);
    if (validator === undefined) {
      // A Convex validator carries the JSON a registered function's
      // `exportArgs` serializes, the form the kernel checks every call with.
      validator = (
        v.object(
          SchemaToValidator.compileArgsSchema(
            found.contract.functionProvenance.args,
          ),
        ) as unknown as { readonly json: ValidatorJSON }
      ).json;
      validators.set(id, validator);
    }
    return validator;
  };
  const call: Execution.Sink["call"] = ({ slot: id, args, caller }) => {
    const found = slots[id];
    if (found === undefined)
      return Promise.reject(
        new Error(
          `The component called the callback slot ${id}, which it does not declare.`,
        ),
      );
    const commandId = `callback-${next++}`;
    if (!open) return outcome(found, "returned", `${draws}:${commandId}`);
    const held = Promise.withResolvers<unknown>();
    const command: CallbackCommand = {
      id: commandId,
      kind: "callback",
      slot: id,
      input: args,
      outcomes: found.outcomes,
      componentPath: caller?.componentPath,
      functionName: caller?.functionName,
    };
    pending.set(commandId, {
      command,
      settle: (answer) => answer.then(held.resolve, held.reject),
    });
    arrived.push(command);
    for (const wake of waiting) wake();
    return held.promise;
  };
  const answer = (id: string, chosen: string) =>
    Effect.suspend(
      (): Effect.Effect<void, StaleCommand | UndeclaredOutcome> => {
        const held = pending.get(id);
        if (held === undefined) return Effect.fail(StaleCommand.make({ id }));
        const found = slots[held.command.slot]!;
        if (!Arr.contains(found.outcomes as ReadonlyArray<string>, chosen))
          return Effect.fail(
            UndeclaredOutcome.make({
              id,
              slot: held.command.slot,
              outcome: chosen,
              allowed: found.outcomes,
            }),
          );
        pending.delete(id);
        held.settle(outcome(found, chosen, `${draws}:${id}`));
        return Effect.void;
      },
    );
  const arrival = (at: number) =>
    Effect.callback<CallbackCommand>((resume) => {
      const check = () => {
        const command = arrived[at];
        if (command === undefined) return;
        waiting.delete(check);
        resume(Effect.succeed(command));
      };
      waiting.add(check);
      check();
      return Effect.sync(() => waiting.delete(check));
    });
  return {
    sink: { args: argsOf, call } satisfies Execution.Sink,
    open: () => {
      open = true;
    },
    commands: Effect.sync(() =>
      Array.from(pending.values(), ({ command }) => command),
    ),
    answer,
    mark: Effect.sync(() => arrived.length),
    arrival,
  };
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
  I extends Ref.AnyConfect | undefined,
>(
  app: GeneratedApp<S>,
  declaration: {
    readonly refs: F;
    readonly functions: T;
    readonly ports: P;
    readonly slots: C;
    readonly init: I;
    readonly laws: L;
    readonly obligations: B;
    readonly mounts: ReadonlyArray<Mount>;
    readonly settings: G;
  },
): GeneratedComponent<F, T, P, C, S, G, L, B, I> => ({
  ...declaration,
  kind: "component",
  app,
  layer: (options) => {
    const runtime = ComponentRuntime<S>();
    return Layer.effectContext(
      Effect.gen(function* () {
        const engine = makeEngine(declaration.slots, options.draws ?? 0);
        const init = declaration.init;
        const root =
          init === undefined
            ? undefined
            : {
                functionName: init.convexFunctionName,
                args: yield* Schema.encodeUnknownEffect(init.args)(
                  options.install ?? {},
                ).pipe(Effect.orDie),
              };
        const opened = yield* openSession(
          app,
          declaration,
          options.config,
          options.seed,
          root === undefined
            ? { sink: engine.sink }
            : { sink: engine.sink, root },
        );
        engine.open();
        const { withIdentity: _, ...service } = opened.service;
        const tables = Arr.sort(
          Rec.keys(
            (
              app.convexSchema as unknown as {
                tables: Readonly<Record<string, unknown>>;
              }
            ).tables,
          ),
          Order.String,
        );
        const image = Effect.promise((): Promise<Postimage> =>
          opened.raw.run((ctx: any) =>
            Promise.all(
              Arr.map(tables, (table) => ctx.db.query(table).collect()),
            ).then(
              (all: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>) =>
                Rec.fromEntries(
                  Arr.flatMap(tables, (table, index) =>
                    all[index]!.length === 0
                      ? []
                      : [
                          [
                            table,
                            Arr.map(all[index]!, withoutSystemFields),
                          ] as const,
                        ],
                  ),
                ),
            ),
          ),
        );
        return Context.make(runtime, service).pipe(
          Context.add(Callbacks, {
            commands: engine.commands,
            answer: engine.answer,
            mark: engine.mark,
            arrival: engine.arrival,
            image,
          }),
          Context.add(Session, opened.session),
        );
      }),
    );
  },
});

/**
 * The callback commands the session holds, oldest first.
 */
export const commands = <
  C extends Readonly<Record<string, AnySlot>>,
>(_subject: {
  readonly slots: C;
}): Effect.Effect<ReadonlyArray<CommandOf<C>>, never, Callbacks> =>
  Effect.gen(function* () {
    return (yield* (yield* Callbacks).commands) as ReadonlyArray<CommandOf<C>>;
  });

/**
 * Settle a held command with one of its slot's outcomes, so the component's
 * call returns or fails with it.
 */
export const answer = <K extends string, O extends string>(
  command: CallbackCommand<K, O>,
  outcome: NoInfer<O>,
): Effect.Effect<void, StaleCommand | UndeclaredOutcome, Callbacks> =>
  Effect.gen(function* () {
    yield* (yield* Callbacks).answer(command.id, outcome);
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
 * the case answered the slot.
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

export class CaseFailed extends Schema.TaggedError<
  CaseFailed,
  { readonly brand: unique symbol }
>()("CaseFailed", { case: Schema.String, reason: Schema.String }) {}

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
    any,
    infer I
  >
    ? LayerOptions<S, G, I>
    : never;

const byKey = Order.mapInput(
  Order.String,
  ([key]: readonly [string, unknown]) => key,
);

/**
 * `value` with every object's keys in order, so equal values print alike.
 */
const sortedKeys = (value: unknown): unknown =>
  Arr.isArray(value)
    ? Arr.map(value, sortedKeys)
    : Predicate.isObject(value)
      ? Rec.fromEntries(
          Arr.map(
            Arr.sort(Rec.toEntries(value as Record<string, unknown>), byKey),
            ([key, field]) => [key, sortedKeys(field)] as const,
          ),
        )
      : value;

const canonical = (value: unknown): string =>
  stringify(sortedKeys(convexToJson(value as Value)));

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

/**
 * Run one exported call to its end, answering each callback command it makes
 * with `outcomeOf`. Only the commands that arrive during the call count, so a
 * call `init` or `seed` made never does.
 */
const invoke = (
  engine: Engine,
  exported: Effect.Effect<unknown, { readonly _tag: string }>,
  outcomeOf: (command: CallbackCommand) => string,
) =>
  Effect.gen(function* () {
    const from = yield* engine.mark;
    const fiber = yield* exported.pipe(Effect.result, Effect.forkChild);
    const answered: Array<CallbackCommand> = [];
    for (;;) {
      const step = yield* Effect.raceFirst(
        Effect.map(engine.arrival(from + answered.length), (command) => ({
          command,
        })),
        Effect.map(Fiber.join(fiber), (result) => ({ result })),
      );
      if ("result" in step) return { result: step.result, answered };
      answered.push(step.command);
      yield* engine
        .answer(step.command.id, outcomeOf(step.command))
        .pipe(Effect.orDie);
    }
  });

const encodedReturn = (ref: Ref.AnyPublic, value: unknown) =>
  ref._tag === "Confect"
    ? Schema.encodeUnknownEffect(ref.returns)(value).pipe(Effect.orDie)
    : Effect.succeed(value);

const runCase = <Subject extends AnyGeneratedComponent>(
  subject: Subject,
  name: string,
  options: OptionsOf<Subject>,
  body: (
    service: ComponentRuntime<any>,
    engine: Engine,
  ) => Effect.Effect<void, CaseFailed>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(subject.layer(options as never));
      yield* body(
        Context.get(context, ComponentRuntime<any>()),
        Context.get(context, Callbacks),
      );
    }),
  ).pipe(
    Effect.catchTags({
      TestConfigMissing: (error: TestConfigMissing) =>
        Effect.fail(CaseFailed.make({ case: name, reason: error.message })),
      MountInitFailed: (error: MountInitFailed) =>
        Effect.fail(CaseFailed.make({ case: name, reason: error.message })),
    }),
  ) as Effect.Effect<void, CaseFailed>;

const checkImage = (name: string, engine: Engine, expected: Postimage) =>
  Effect.flatMap(engine.image, (actual) => {
    const wanted = Rec.filter(expected, (docs) => docs.length > 0);
    return canonical(actual) === canonical(wanted)
      ? Effect.void
      : Effect.fail(
          CaseFailed.make({
            case: name,
            reason: `the postimage is ${canonical(actual)}, not ${canonical(wanted)}`,
          }),
        );
  });

/**
 * The exported contract as runnable cases, total over the subject's functions
 * by type. A returning case checks the encoded return and the postimage; a
 * failing one checks the declared error's tag. A callback the call makes is
 * answered `returned`.
 */
export const exports = <Subject extends AnyGeneratedComponent>(
  subject: Subject,
  rows: ExportRows<Subject["functions"]>,
): ReadonlyArray<Case<OptionsOf<Subject>>> =>
  Arr.flatMap(
    Rec.toEntries(rows as Record<string, ReadonlyArray<any>>),
    ([ref, cases]) =>
      Arr.map(cases, (row): Case<OptionsOf<Subject>> => {
        const name = `${ref} ${row.name}`;
        const fn = subject.functions[ref]!;
        return {
          name,
          owes: { kind: "export", ref },
          run: (options) =>
            runCase(subject, name, options, (service, engine) =>
              Effect.gen(function* () {
                const { result } = yield* invoke(
                  engine,
                  call(service, fn, row.args ?? {}),
                  () => "returned",
                );
                if ("fails" in row) {
                  const tag =
                    result._tag === "Failure"
                      ? result.failure._tag
                      : "a return";
                  if (tag !== row.fails)
                    return yield* CaseFailed.make({
                      case: name,
                      reason: `expected ${row.fails}, got ${tag}`,
                    });
                  return;
                }
                if (result._tag === "Failure")
                  return yield* CaseFailed.make({
                    case: name,
                    reason: `expected a return, got ${result.failure._tag}`,
                  });
                const returned = yield* encodedReturn(fn, result.success);
                const stated = yield* encodedReturn(fn, row.returns);
                const actual = canonical(returned);
                const expected = canonical(stated);
                if (actual !== expected)
                  return yield* CaseFailed.make({
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
 * type. Each makes its exported call and answers each command the call makes to
 * the case's slot with the case's outcome, and any other slot's with
 * `returned`. It fails when the call never reached the slot, and checks the
 * postimage once the call ends.
 */
export const callbacks = <Subject extends AnyGeneratedComponent>(
  subject: Subject,
  rows: CallbackRows<Subject["functions"], Subject["slots"]>,
): ReadonlyArray<Case<OptionsOf<Subject>>> =>
  Arr.flatMap(
    Rec.toEntries(
      rows as Record<string, Record<string, CallbackCase<Record<string, any>>>>,
    ),
    ([slotId, outcomes]) =>
      Arr.map(
        Rec.toEntries(outcomes),
        ([outcome, row]): Case<OptionsOf<Subject>> => {
          const name = `${slotId} ${outcome} ${row.name}`;
          return {
            name,
            owes: { kind: "callback", slot: slotId },
            run: (options) =>
              runCase(subject, name, options, (service, engine) =>
                Effect.gen(function* () {
                  const { answered } = yield* invoke(
                    engine,
                    call(service, subject.functions[row.call]!, row.args ?? {}),
                    (command) =>
                      command.slot === slotId ? outcome : "returned",
                  );
                  if (!Arr.some(answered, (command) => command.slot === slotId))
                    return yield* CaseFailed.make({
                      case: name,
                      reason: `${row.call} never called the slot ${slotId}`,
                    });
                  yield* checkImage(name, engine, row.postimage);
                }),
              ),
          };
        },
      ),
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
