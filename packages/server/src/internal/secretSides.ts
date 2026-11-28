import type * as IdScope from "@confect/core/IdScope";
import {
  compileArgsSchema,
  compileReturnsSchema,
} from "@confect/core/SchemaToValidator";
import * as SecretSchema from "@confect/core/SecretSchema";
import * as ValidatorCheck from "@confect/core/ValidatorCheck";
import {
  v,
  type GenericValidator,
  type PropertyValidators,
} from "convex/values";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import { pipe } from "effect/Function";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

/**
 * Which side of a function a validator checks.
 */
type Side = "arguments" | "returns";

/**
 * A value Confect refused in Convex's place, on a side that holds a secret. Its
 * message starts as Convex's own refusal does, with `ArgumentValidationError`
 * or `ReturnsValidationError`, and gives the refused value's place and kind,
 * never the value.
 *
 * @stability unstable
 */
export class SecretSideRefused extends Schema.TaggedError<
  SecretSideRefused,
  { readonly brand: unique symbol }
>()("SecretSideRefused", {
  side: Schema.Literals(["arguments", "returns"]),
  path: Schema.String,
  problem: Schema.Literals(["missing", "extra", "mismatch"]),
  field: Schema.UndefinedOr(Schema.String),
}) {
  override get message() {
    const kind =
      this.side === "arguments"
        ? "ArgumentValidationError"
        : "ReturnsValidationError";
    const what =
      this.problem === "missing"
        ? `Object is missing the required field \`${this.field}\`.`
        : this.problem === "extra"
          ? "Object contains a field that is not in the validator."
          : "Value does not match validator.";
    const path = this.path === "" ? "" : `\nPath: ${this.path}`;
    return `${kind}: ${what}${path}\nThe function's ${this.side} hold a secret, so Confect checked them in place of Convex's validator and does not print the value.`;
  }
}

const refused = (side: Side, problem: ValidatorCheck.Problem) =>
  SecretSideRefused.make({
    side,
    path: problem.path,
    problem:
      problem.kind === "missing" || problem.kind === "extra"
        ? problem.kind
        : "mismatch",
    // A missing field is the schema's own name; an extra one is the caller's.
    field: problem.kind === "missing" ? problem.field : undefined,
  });

/**
 * A side that holds a secret and a validator Confect cannot check in Convex's
 * place: an ID in an action, which has no database to name its table, or a
 * function handle, whose format only the backend parses.
 *
 * @stability unstable
 */
export class SecretSideUncheckable extends Schema.TaggedError<
  SecretSideUncheckable,
  { readonly brand: unique symbol }
>()("SecretSideUncheckable", {
  functionName: Schema.String,
  side: Schema.Literals(["arguments", "returns"]),
  validator: Schema.Literals(["id", "function"]),
}) {
  override get message() {
    const held =
      this.validator === "id"
        ? "an ID, and an action has no database to check an ID's table"
        : "a function handle, whose format only the backend can check";
    return `${this.functionName}'s ${this.side} hold a secret, so Convex's validator would print it and Confect checks them instead. They also hold ${held}. Move it out of the ${this.side} that hold the secret.`;
  }
}

/**
 * The validator kinds anywhere beneath `validator`.
 */
const kinds = (validator: GenericValidator): ReadonlyArray<string> => {
  switch (validator.kind) {
    case "object":
      return [
        validator.kind,
        ...Arr.flatMap(
          Rec.values(
            validator.fields as Readonly<Record<string, GenericValidator>>,
          ),
          kinds,
        ),
      ];
    case "array":
      return [validator.kind, ...kinds(validator.element)];
    case "record":
      return [
        validator.kind,
        ...kinds(validator.key),
        ...kinds(validator.value),
      ];
    case "union":
      return [validator.kind, ...Arr.flatMap(validator.members, kinds)];
    default:
      return [validator.kind];
  }
};

/**
 * The lookups of a query or mutation, which test an ID against the one table
 * its validator names.
 *
 * @stability unstable
 */
export const databaseLookups = (db: {
  readonly normalizeId: (table: any, id: string) => string | null;
  readonly system: {
    readonly normalizeId: (table: any, id: string) => string | null;
  };
}): ValidatorCheck.Lookups => ({
  tableOf: (id, expected) =>
    (pipe(expected, Str.startsWith("_"))
      ? db.system.normalizeId(expected, id)
      : db.normalizeId(expected, id)) === null
      ? undefined
      : expected,
  // A side that holds a secret holds no handle, as `define` refuses one.
  isFunctionHandle: () => false,
});

/**
 * An action's lookups: a side that holds a secret holds no ID or handle, as
 * `define` refuses both.
 */
const actionLookups: ValidatorCheck.Lookups = {
  tableOf: () => undefined,
  isFunctionHandle: () => false,
};

const once = <A>(compute: () => A): (() => A) => {
  let computed: { readonly value: A } | undefined;
  return () => (computed ??= { value: compute() }).value;
};

/**
 * A function's Convex definition, with its two sides as Convex and Confect
 * check them. A side whose schema holds a secret registers no validator with
 * Convex, because Convex's validator prints the whole value it refuses. Confect
 * checks that side against the same validator, before `handler` runs for the
 * arguments and after it returns for the return, and its refusal leaves the
 * value out. Both sides compile lazily, when Convex reads them or the function
 * first runs.
 *
 * @stability unstable
 */
export const define = <Ctx, Args, Returns>(
  {
    name,
    args,
    returns,
    scope,
    reservedArgument,
    lookups,
  }: {
    readonly name: string;
    readonly args: Schema.Codec<any, any>;
    readonly returns: Schema.Codec<any, any>;
    readonly scope: IdScope.IdScope;
    readonly reservedArgument: string | undefined;
    /**
     * How the function's context checks an ID, or `undefined` for an action.
     */
    readonly lookups:
      | ((ctx: NoInfer<Ctx>) => ValidatorCheck.Lookups)
      | undefined;
  },
  handler: (ctx: Ctx, args: Args) => Promise<Returns>,
) => {
  const own = (side: Side, validator: GenericValidator) => {
    const found = kinds(validator);
    const uncheckable = Arr.findFirst(
      lookups === undefined ? ["function", "id"] : ["function"],
      (kind) => Arr.contains(found, kind),
    );
    if (uncheckable._tag === "Some")
      throw SecretSideUncheckable.make({
        functionName: name,
        side,
        validator: uncheckable.value as "id" | "function",
      });
    return validator;
  };
  // Whether a side holds a secret is all a call reads before it checks one, so a
  // function without a secret compiles no validator when it runs.
  const secretArgs = once(() => SecretSchema.hasSecret(args.ast));
  const secretReturns = once(() => SecretSchema.hasSecret(returns.ast));
  const argsValidator = once(() =>
    compileArgsSchema(args, scope, reservedArgument, name),
  );
  const returnsValidator = once(() => compileReturnsSchema(returns, scope));
  const ownArgs = once(() => own("arguments", v.object(argsValidator())));
  const ownReturns = once(() => own("returns", returnsValidator()));
  const problemOf = (validator: GenericValidator, value: unknown, ctx: Ctx) =>
    ValidatorCheck.check(
      validator,
      value,
      lookups === undefined ? actionLookups : lookups(ctx),
    );
  return {
    // Convex reads these at push, so compiling Confect's own check there refuses
    // an uncheckable side before it deploys.
    args: (): PropertyValidators | undefined =>
      secretArgs() ? (ownArgs(), undefined) : argsValidator(),
    returns: (): GenericValidator | undefined =>
      secretReturns() ? (ownReturns(), undefined) : returnsValidator(),
    handler: (ctx: Ctx, actualArgs: Args): Promise<Returns> => {
      const argsProblem = secretArgs()
        ? problemOf(ownArgs(), actualArgs, ctx)
        : undefined;
      if (argsProblem !== undefined)
        return Promise.reject(refused("arguments", argsProblem));
      return handler(ctx, actualArgs).then((result) => {
        const returnsProblem = secretReturns()
          ? problemOf(ownReturns(), result, ctx)
          : undefined;
        if (returnsProblem !== undefined)
          throw refused("returns", returnsProblem);
        return result;
      });
    },
  };
};
