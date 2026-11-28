import type { GenericValidator, PropertyValidators } from "convex/values";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * The definition Confect hands Convex's `queryGeneric`, `mutationGeneric`,
 * `actionGeneric` or their internal forms. Confect defines `args` and `returns`
 * as lazy getters: reading either compiles the function's schemas. A side whose
 * schema holds a secret reads `undefined`, as Confect checks it in the handler
 * in Convex's place.
 */
export interface ConvexDefinition {
  readonly args?: PropertyValidators | GenericValidator | undefined;
  readonly returns?: PropertyValidators | GenericValidator | undefined;
  readonly handler: (ctx: any, args: any) => unknown;
}

/**
 * A transform of each Convex definition Confect registers. It receives the
 * function's visibility and its definition, and returns the definition Convex
 * registers.
 */
export type DefinitionHook = (
  visibility: "public" | "internal",
  definition: ConvexDefinition,
) => ConvexDefinition;

/**
 * A definition hook could not be bound: one already is (`AlreadyBound`), or
 * this copy of `@confect/server` has already registered a function the hook
 * would have seen (`FunctionRegistered`).
 */
export class DefinitionHookRefused extends Schema.TaggedError<
  DefinitionHookRefused,
  { readonly brand: unique symbol }
>()("DefinitionHookRefused", {
  reason: Schema.Literals(["AlreadyBound", "FunctionRegistered"]),
}) {
  override get message(): string {
    return this.reason === "AlreadyBound"
      ? "A definition hook is already bound, and one can be bound only once"
      : "A function was registered before the definition hook was bound, so it registered without the hook";
  }
}

let bound: DefinitionHook | undefined;
let registered = false;

/**
 * Bind `hook` for every later registration, unless one is bound or a function
 * has registered.
 */
export const bind = (
  hook: DefinitionHook,
): Result.Result<void, DefinitionHookRefused> => {
  if (bound !== undefined)
    return Result.fail(DefinitionHookRefused.make({ reason: "AlreadyBound" }));
  if (registered)
    return Result.fail(
      DefinitionHookRefused.make({ reason: "FunctionRegistered" }),
    );
  bound = hook;
  return Result.succeed(undefined);
};

/**
 * The definition to register: `definition` itself when no hook is bound, or
 * what the bound hook returns for it.
 */
export const apply = (
  visibility: "public" | "internal",
  definition: ConvexDefinition,
): ConvexDefinition => {
  registered = true;
  return bound === undefined ? definition : bound(visibility, definition);
};
