import type { DefaultFunctionArgs } from "convex/server";
import type { CommitTsPlaceholder } from "convex/values";

type IsUnknownOrAny<A> = 0 extends 1 & A
  ? true
  : (<T>() => T extends A ? 1 : 2) extends <T>() => T extends unknown ? 1 : 2
    ? true
    : false;

type Leading<A> = A extends readonly [infer Head, ...infer Tail]
  ? Head | Leading<Tail>
  : never;

/**
 * The element type of the array an array schema lowers to. The lowering keeps a
 * tuple's leading elements and drops its rest, or keeps the rest's first type
 * when there are no leading elements.
 */
type Element<A extends ReadonlyArray<unknown>> = [Leading<A>] extends [never]
  ? A extends readonly [...infer Init, unknown]
    ? Element<Init>
    : A[number]
  : Leading<A>;

/**
 * The type Convex's generated ComponentApi gives a value whose schema has this
 * encoded type: database ID brands become `string`, in record keys too, objects
 * and arrays are mutable, an optional field does not admit `undefined`, and
 * `unknown`, which lowers to `v.any()`, is `any`. The test suites' lowering
 * matrix checks each form the lowering emits.
 */
export type Wire<A> =
  IsUnknownOrAny<A> extends true
    ? any
    : A extends { readonly __tableName: string }
      ? string
      : A extends
            | string
            | number
            | bigint
            | boolean
            | null
            | undefined
            | ArrayBuffer
            | CommitTsPlaceholder
        ? A
        : A extends ReadonlyArray<unknown>
          ? Array<Wire<Element<A>>>
          : {
              -readonly [
                K in keyof A as K extends {
                  readonly __tableName: string;
                }
                  ? string
                  : K
              ]: Wire<Exclude<A[K], undefined>>;
            };

/**
 * {@link Wire} for a function's args, which Convex requires to be an object.
 */
export type WireArgs<A> = Extract<Wire<A>, DefaultFunctionArgs>;
