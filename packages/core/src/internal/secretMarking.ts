import type * as SchemaAST from "effect/SchemaAST";
import type { Validator } from "convex/values";

/**
 * The encoded nodes whose validators a compile in progress records, and where
 * it records them. `compileAst` reads it, and only `ValidatorCheck`'s
 * `withSecretValidators` sets it, for the length of one synchronous compile.
 */
export interface Marking {
  readonly nodes: ReadonlySet<SchemaAST.AST>;
  readonly marked: WeakSet<Validator<any, any, any>>;
}

let marking: Marking | undefined;

export const current = (): Marking | undefined => marking;

/**
 * Run `compile` with `next` as the marking, and restore the one before it.
 */
export const during = <A>(next: Marking, compile: () => A): A => {
  const previous = marking;
  marking = next;
  try {
    return compile();
  } finally {
    marking = previous;
  }
};
