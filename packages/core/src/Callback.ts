import type {
  FunctionReference,
  FunctionReference_future,
  FunctionType,
} from "convex/server";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as FunctionProvenance from "./FunctionProvenance";
import * as Ref from "./Ref";
import type * as RuntimeAndFunctionType from "./RuntimeAndFunctionType";

export const TypeId = "~@confect/core/Callback";
export type TypeId = typeof TypeId;

const HandleTypeId = "~@confect/core/Callback/Handle";

/**
 * A contract's id, `"<component>/<event>"`.
 */
export type Id = `${string}/${string}`;

/**
 * A function a component calls back into its host, declared by the component:
 * the args it sends and the returns and errors it accepts. A host proves that
 * one of its functions satisfies the contract when it creates a handle.
 */
export interface Contract<
  Id_ extends Id,
  FunctionType_ extends FunctionType,
  ArgsFields_ extends FunctionProvenance.ArgsFields,
  Returns_ extends Schema.Codec<any, any>,
  Error_ extends Schema.Codec<any, any> = never,
> {
  readonly [TypeId]: TypeId;
  readonly id: Id_;
  readonly functionType: FunctionType_;
  readonly functionProvenance: FunctionProvenance.Confect<
    ArgsFields_,
    Returns_,
    Error_,
    FunctionProvenance.Standard
  >;
}

export interface Any {
  readonly [TypeId]: TypeId;
  readonly id: Id;
  readonly functionType: FunctionType;
  readonly functionProvenance: FunctionProvenance.AnyConfect;
}

export const isContract = (u: unknown): u is Any =>
  Predicate.hasProperty(u, TypeId) && u[TypeId] === TypeId;

type ArgsFields<Contract_ extends Any> =
  Contract_["functionProvenance"] extends {
    readonly "~ArgsFields": infer ArgsFields_ extends
      FunctionProvenance.ArgsFields;
  }
    ? ArgsFields_
    : never;

type ReturnsSchema<Contract_ extends Any> =
  Contract_["functionProvenance"]["returns"];

type ErrorSchema<Contract_ extends Any> =
  Contract_["functionProvenance"] extends {
    readonly error?: infer ErrorSchema_;
  }
    ? Extract<ErrorSchema_, Schema.Codec<any, any>>
    : never;

export type Args<Contract_ extends Any> = Schema.Struct.Type<
  ArgsFields<Contract_>
>;

export type Returns<Contract_ extends Any> = ReturnsSchema<Contract_>["Type"];

export type Error<Contract_ extends Any> = ErrorSchema<Contract_>["Type"];

/**
 * A host function a component received for a contract. It is a ref, so the
 * runners and the scheduler run it with the contract's codecs, and declared
 * errors arrive by tag.
 */
export type Handle<Contract_ extends Any> = Ref.ConfectRef<
  Extract<
    RuntimeAndFunctionType.RuntimeAndFunctionType,
    {
      readonly runtime: "Convex";
      readonly functionType: Contract_["functionType"];
    }
  >,
  "internal",
  ArgsFields<Contract_>,
  ReturnsSchema<Contract_>,
  ErrorSchema<Contract_>
> & { readonly [HandleTypeId]: Contract_["id"] };

const make =
  <FunctionType_ extends FunctionType>(functionType: FunctionType_) =>
  <
    const Id_ extends Id,
    const ArgsFields_ extends FunctionProvenance.ArgsFields = {},
    Returns_ extends Schema.Codec<any, any> = never,
    Error_ extends Schema.Codec<any, any> = never,
  >(
    id: Id_,
    options: {
      readonly args?: () => ArgsFields_;
      readonly returns: () => Returns_;
      readonly error?: () => Error_;
    },
  ): Contract<Id_, FunctionType_, ArgsFields_, Returns_, Error_> => ({
    [TypeId]: TypeId,
    id,
    functionType,
    functionProvenance: FunctionProvenance.Confect(
      options.args ?? (() => ({}) as ArgsFields_),
      options.returns,
      options.error,
    ),
  });

export const query = make("query");
export const mutation = make("mutation");
export const action = make("action");

const isHandleOf =
  <Contract_ extends Any>(contract: Contract_) =>
  (value: unknown): value is Handle<Contract_> =>
    Ref.isRef(value) &&
    Predicate.hasProperty(value, HandleTypeId) &&
    value[HandleTypeId] === contract.id;

const fromText = <Contract_ extends Any>(
  contract: Contract_,
  text: string,
): Handle<Contract_> =>
  Object.assign(
    Ref.fromProvenance(
      text,
      contract.functionProvenance,
      [],
      // Convex types a handle as a string that is also a function reference.
      text as unknown as FunctionReference<any, any>,
    ),
    { [HandleTypeId]: contract.id },
  ) as unknown as Handle<Contract_>;

/**
 * The schema of a handle for `contract`: a string on the wire, a runnable ref
 * once decoded. Use it in a component's function args or tables.
 */
export const handle = <Contract_ extends Any>(
  contract: Contract_,
): Schema.Codec<Handle<Contract_>, string> =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.declare(isHandleOf(contract), {
        identifier: `Callback.Handle<${contract.id}>`,
      }),
      {
        decode: SchemaGetter.transform((text: string) =>
          fromText(contract, text),
        ),
        encode: SchemaGetter.transform(
          (ref: Handle<Contract_>) => ref.convexFunctionName,
        ),
      },
    ),
  );

type EncodedArgs<Ref_> = Ref_ extends {
  readonly _tag: "Confect";
  readonly args: {
    readonly fields: infer ArgsFields_ extends FunctionProvenance.ArgsFields;
  };
}
  ? Schema.Struct.Encoded<ArgsFields_>
  : Ref.Args<Ref_>;

type EncodedReturns<Ref_> = Ref_ extends { readonly _tag: "Confect" }
  ? Ref.ReturnsSchema<Ref_>["Encoded"]
  : Ref.Returns<Ref_>;

type IsAny<A> = 0 extends 1 & A ? true : false;

/**
 * A Confect ref typed from values alone, such as a bound component's ref, has
 * no codec types left to compare, and middleware attachments typed without
 * their specs erase their errors. True when any variant of `Ref_` is erased.
 */
type IsErased<Ref_> = true extends (
  Ref_ extends { readonly _tag: "Confect" }
    ? IsAny<Ref.ReturnsSchema<Ref_>["Encoded"]> | IsAny<Ref.EncodedError<Ref_>>
    : false
)
  ? true
  : false;

/**
 * The shape a value has on the wire: a component's ID brands become `string`,
 * since the contract cannot name the host's scope, while the host's own IDs
 * keep their table. Arrays and tuples lose `readonly`, and an optional field is
 * the same whether or not it admits `undefined`, which Convex never transmits.
 * `unknown` stays `unknown`.
 */
type WireShape<A> = unknown extends A
  ? A
  : A extends { readonly "~@confect/core/ScopedId": unknown }
    ? string
    : A extends
          | string
          | number
          | bigint
          | boolean
          | null
          | undefined
          | ArrayBuffer
      ? A
      : { -readonly [Key in keyof A]: WireShape<Exclude<A[Key], undefined>> };

type Identical<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

type FirstOf<Checks extends ReadonlyArray<unknown>> = Checks extends readonly [
  infer Head,
  ...infer Rest,
]
  ? [Head] extends [never]
    ? FirstOf<Rest>
    : Head
  : never;

/**
 * Every obligation a host ref owes a contract, in the order they are reported.
 * Each is `never` when it holds.
 */
type Obligations<Contract_ extends Any, Ref_ extends Ref.Any> = [
  IsErased<Ref_> extends true
    ? `the ref's codecs are erased, so its encoding cannot be checked against "${Contract_["id"]}"; pass the host's generated ref`
    : never,
  [Ref.GetFunctionType<Ref_>] extends [Contract_["functionType"]]
    ? never
    : `"${Contract_["id"]}" needs a ${Contract_["functionType"]}, not a ${Ref.GetFunctionType<Ref_>}`,
  Identical<
    WireShape<EncodedArgs<Handle<Contract_>>>,
    WireShape<EncodedArgs<Ref_>>
  > extends true
    ? never
    : `the ref's encoded args differ from the args "${Contract_["id"]}" sends`,
  Identical<
    WireShape<EncodedReturns<Handle<Contract_>>>,
    WireShape<EncodedReturns<Ref_>>
  > extends true
    ? never
    : `the ref's returns are encoded differently from the returns of "${Contract_["id"]}"`,
  [Ref.Error<Ref_>] extends [Error<Contract_>]
    ? never
    : `the ref fails with errors "${Contract_["id"]}" does not declare`,
  [WireShape<Ref.EncodedError<Ref_>>] extends [
    WireShape<Ref.EncodedError<Handle<Contract_>>>,
  ]
    ? never
    : `the ref's errors are encoded differently from the errors of "${Contract_["id"]}"`,
];

type Mismatch<Contract_ extends Any, Ref_ extends Ref.Any> = FirstOf<
  Obligations<Contract_, Ref_>
>;

/**
 * `unknown` when host ref `Ref_` satisfies `Contract_` as far as its types
 * show, otherwise an object type naming the first mismatch. The check compares
 * the types that cross the wire, with a component's IDs compared as strings.
 * The host's encoded args and returns must equal the contract's, and its
 * encoded errors (middleware errors included) must be ones the contract's
 * codecs decode. A ref whose codecs are erased cannot be checked and is
 * refused. Types miss what only the validators show, such as field names behind
 * a `Record` type, so `Callback.create` in `@confect/server` also compares the
 * compiled validators before it creates a handle.
 */
export type Check<Contract_ extends Any, Ref_ extends Ref.Any> = [
  Mismatch<Contract_, Ref_>,
] extends [never]
  ? unknown
  : { readonly "~CallbackMismatch": Mismatch<Contract_, Ref_> };

/**
 * View a ref as Convex's `FunctionReference_future`, typed with its wire args
 * and returns, for `createFunctionHandle` and clients that accept it.
 */
export const toFuture = <Ref_ extends Ref.Any>(
  ref: Ref_,
): FunctionReference_future<
  Ref.GetFunctionType<Ref_>,
  Ref.GetFunctionVisibility<Ref_>,
  EncodedArgs<Ref_>,
  EncodedReturns<Ref_>
> => Ref.getFunctionReference(ref) as never;
