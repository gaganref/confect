import type * as IdScope from "@confect/core/IdScope";
import {
  compileArgsSchema,
  compileReturnsSchema,
} from "@confect/core/SchemaToValidator";
import * as SecretSchema from "@confect/core/SecretSchema";
import * as ValidatorCheck from "@confect/core/ValidatorCheck";
import * as Ref from "@confect/core/Ref";
import {
  ConvexError,
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
 * What a refusal of a side that holds a secret carries across Convex's
 * boundary, as its `ConvexError` data: where the value failed and the validator
 * it failed, never the value. A caller recognises the refusal by this data,
 * which a nested call keeps, where an error's class and stack do not survive.
 *
 * @stability unstable
 */
export const SecretSideRefusal = Schema.TaggedStruct("SecretSideRefused", {
  side: Schema.Literals(["arguments", "returns"]),
  path: Schema.String,
  validator: Schema.String,
});

const RefusalData = Schema.Union([
  SecretSideRefusal,
  Schema.fromJsonString(SecretSideRefusal),
]);

/**
 * A value Confect refused in Convex's place, on a side that holds a secret. It
 * reads as Convex's own refusal does, named `ArgumentValidationError` or
 * `ReturnsValidationError`, with the problem, its `Path:` and the `Validator:`
 * it failed, but no `Value:` line and no stack.
 *
 * @stability unstable
 */
export class SecretSideRefused extends ConvexError<
  typeof SecretSideRefusal.Type
> {
  constructor(data: typeof SecretSideRefusal.Type, problem: string) {
    super(data);
    const kind =
      data.side === "arguments"
        ? "ArgumentValidationError"
        : "ReturnsValidationError";
    const path = data.path === "" ? "" : `\nPath: ${data.path}`;
    this.name = kind;
    this.message = `${problem}${path}\nValidator: ${data.validator}`;
  }
}

/**
 * Whether `error` is a nested call's refusal of the arguments it was passed, by
 * the data Confect gives that refusal, whether the caller receives it parsed or
 * as Convex's JSON text.
 *
 * @stability unstable
 */
export const isArgumentRefusal = (error: unknown): error is Error => {
  if (!Ref.isConvexError(error)) return false;
  const data = Schema.decodeUnknownOption(RefusalData)(error.data);
  return data._tag === "Some" && data.value.side === "arguments";
};

const describe = (problem: ValidatorCheck.Problem) => {
  switch (problem.kind) {
    case "missing":
      return {
        problem: `Object is missing the required field \`${problem.field}\`. Consider wrapping the field validator in \`v.optional(...)\` if this is expected.`,
        validator: problem.validator,
      };
    case "extra":
      // The extra field's name is the caller's, so it is not printed.
      return {
        problem: "Object contains a field that is not in the validator.",
        validator: problem.validator,
      };
    case "noMatch":
      return {
        problem: "Value does not match validator.",
        validator: problem.validator,
      };
    case "literal":
      return {
        problem: "Value does not match validator.",
        validator: v.literal(problem.literal),
      };
    case "table":
    case "system":
      return {
        problem: "Value does not match validator.",
        validator: v.id(problem.tableName),
      };
  }
};

/**
 * The refusal of `problem`, built with no stack frames, so a caller and the
 * function log see Convex's own shape of refusal and no internal path.
 */
const refused = (side: Side, problem: ValidatorCheck.Problem) => {
  const { problem: text, validator } = describe(problem);
  // V8 captures no frames while its limit is zero.
  const v8 = Error as ErrorConstructor & {
    stackTraceLimit: number | undefined;
  };
  const limit = v8.stackTraceLimit;
  v8.stackTraceLimit = 0;
  try {
    return new SecretSideRefused(
      {
        _tag: "SecretSideRefused",
        side,
        path: problem.path,
        validator: ValidatorCheck.printValidator(validator),
      },
      text,
    );
  } finally {
    v8.stackTraceLimit = limit;
  }
};

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
