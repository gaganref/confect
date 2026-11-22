import type { DefaultFunctionArgs } from "convex/server";

/**
 * The type Convex's generated ComponentApi gives a value: database ID brands
 * become `string`, objects and arrays are mutable, and `unknown`, which lowers
 * to `v.any()`, is `any`.
 */
export type Wire<A> = unknown extends A
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
      ? A
      : A extends ReadonlyArray<infer Element>
        ? Array<Wire<Element>>
        : { -readonly [K in keyof A]: Wire<A[K]> };

/**
 * {@link Wire} for a function's args, which Convex requires to be an object.
 */
export type WireArgs<A> = Extract<Wire<A>, DefaultFunctionArgs>;
