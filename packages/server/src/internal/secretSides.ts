import type * as IdScope from "@confect/core/IdScope";
import * as Ref from "@confect/core/Ref";
import {
  compileArgsSchema,
  compileReturnsSchema,
} from "@confect/core/SchemaToValidator";
import * as SecretSchema from "@confect/core/SecretSchema";
import * as ValidatorCheck from "@confect/core/ValidatorCheck";
import {
  ConvexError,
  convexToJson,
  v,
  type GenericValidator,
  type PropertyValidators,
  type Value,
} from "convex/values";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as Str from "effect/String";

/**
 * Which side of a function a validator checks.
 */
type Side = "arguments" | "returns";

/**
 * The `_tag` of a refusal's data. It is namespaced, so a product's own
 * `ConvexError` data cannot be mistaken for it.
 *
 * @stability unstable
 */
export const refusalTag = "@confect/server/SecretSideRefused";

/**
 * What a refusal of a side that holds a secret carries across Convex's
 * boundary, as its `ConvexError` data: where the value failed and the validator
 * it failed, never the value. A caller recognises the refusal by this data,
 * which a nested call keeps, where an error's class and stack do not survive.
 *
 * @stability unstable
 */
export const SecretSideRefusal = Schema.TaggedStruct(refusalTag, {
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
    const path = data.path === "" ? "" : `\nPath: ${data.path}`;
    this.name =
      data.side === "arguments"
        ? "ArgumentValidationError"
        : "ReturnsValidationError";
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

/**
 * A side compiled for Confect's check: its validator, and the validators within
 * it that check a secret, whose literals a refusal does not print.
 */
interface Compiled {
  readonly validator: GenericValidator;
  readonly secrets: ValidatorCheck.Secrets;
}

/**
 * The refusal of a value at `path`, built with no stack frames, so a caller and
 * the function log see Convex's own shape of refusal and no internal path.
 */
const refused = (
  side: Side,
  path: string,
  problem: string,
  validator: GenericValidator,
  { secrets }: Compiled,
) => {
  // V8 captures no frames while its limit is zero.
  const v8 = Error as ErrorConstructor & {
    stackTraceLimit: number | undefined;
  };
  const limit = v8.stackTraceLimit;
  v8.stackTraceLimit = 0;
  try {
    return new SecretSideRefused(
      {
        _tag: refusalTag,
        side,
        path,
        validator: ValidatorCheck.printValidator(validator, secrets),
      },
      problem,
    );
  } finally {
    v8.stackTraceLimit = limit;
  }
};

const refusalOf = (
  side: Side,
  problem: ValidatorCheck.Problem,
  compiled: Compiled,
) => {
  switch (problem.kind) {
    case "missing":
      return refused(
        side,
        problem.path,
        `Object is missing the required field \`${problem.field}\`. Consider wrapping the field validator in \`v.optional(...)\` if this is expected.`,
        problem.validator,
        compiled,
      );
    case "extra":
      // The extra field's name is the caller's, so it is not printed.
      return refused(
        side,
        problem.path,
        "Object contains a field that is not in the validator.",
        problem.validator,
        compiled,
      );
    case "noMatch":
    case "literal":
      return refused(
        side,
        problem.path,
        "Value does not match validator.",
        problem.validator,
        compiled,
      );
    case "table":
    case "system":
      return refused(
        side,
        problem.path,
        "Value does not match validator.",
        v.id(problem.tableName),
        compiled,
      );
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
 * A side that holds a secret whose validator Convex would refuse at push, which
 * Confect refuses in its place since it registers no validator for that side.
 * The message is the one Convex's push reports.
 *
 * @stability unstable
 */
export class SecretSideUndeclarable extends Schema.TaggedError<
  SecretSideUndeclarable,
  { readonly brand: unique symbol }
>()("SecretSideUndeclarable", {
  side: Schema.Literals(["arguments", "returns"]),
  problem: Schema.String,
}) {
  override get message() {
    return `Error in ${this.side === "arguments" ? "args" : "returns"} validator: ${this.problem}`;
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
 * its validator names. `normalizeId` also turns a legacy ID string into a
 * modern one, which Convex's validator refuses, so only an ID it returns
 * unchanged names the table.
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
      : db.normalizeId(expected, id)) === id
      ? expected
      : undefined,
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

/**
 * Whether Convex can write `value` as a function's return, which it does with
 * `convexToJson`. Its message prints the value, so only the verdict is kept.
 */
const serializable = (value: unknown): boolean =>
  Result.isSuccess(
    Result.try(() =>
      convexToJson((value === undefined ? null : value) as Value),
    ),
  );

const once = <A>(compute: () => A): (() => A) => {
  let computed: { readonly value: A } | undefined;
  return () => (computed ??= { value: compute() }).value;
};

/**
 * A function's Convex definition, with its two sides as Convex and Confect
 * check them. A side whose schema holds a secret registers no validator with
 * Convex, because Convex's validator prints the whole value it refuses. Confect
 * checks that side as Convex would, before `handler` runs for the arguments and
 * after it returns for the return, and its refusal leaves the value out: the
 * argument count, the validator, the declaration rules Convex applies at push,
 * and that Convex can serialize the return. Both sides compile lazily, when
 * Convex reads them or the function first runs.
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
  const own = <A>(
    side: Side,
    schema: Schema.Top,
    compile: () => A,
    validatorOf: (compiled: A) => GenericValidator,
  ): Compiled => {
    const nodes = new Set(
      Arr.map(SecretSchema.secretNodes(schema.ast), SchemaAST.toEncoded),
    );
    const { value, secrets } = ValidatorCheck.withSecretValidators(
      nodes,
      compile,
    );
    const validator = validatorOf(value);
    const declared = ValidatorCheck.declarationProblem(validator);
    if (declared !== undefined)
      throw SecretSideUndeclarable.make({ side, problem: declared });
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
    return { validator, secrets };
  };
  // Whether a side holds a secret is all a call reads before it checks one, so a
  // function without a secret compiles no validator when it runs.
  const secretArgs = once(() => SecretSchema.hasSecret(args.ast));
  const secretReturns = once(() => SecretSchema.hasSecret(returns.ast));
  const compileArgs = () =>
    compileArgsSchema(args, scope, reservedArgument, name);
  const compileReturns = () => compileReturnsSchema(returns, scope);
  const argsValidator = once(compileArgs);
  const returnsValidator = once(compileReturns);
  const ownArgs = once(() =>
    own("arguments", args, compileArgs, (validators) => v.object(validators)),
  );
  const ownReturns = once(() =>
    own("returns", returns, compileReturns, (validator) => validator),
  );
  const problemOf = (compiled: Compiled, value: unknown, ctx: Ctx) =>
    ValidatorCheck.check(
      compiled.validator,
      value,
      lookups === undefined ? actionLookups : lookups(ctx),
    );
  const argumentsRefusal = (
    ctx: Ctx,
    actualArgs: ReadonlyArray<unknown>,
  ): SecretSideRefused | undefined => {
    if (!secretArgs()) return undefined;
    const compiled = ownArgs();
    if (actualArgs.length !== 1)
      return refused(
        "arguments",
        "",
        `Expected to receive a single object as the function's argument. Instead received ${actualArgs.length} arguments.`,
        compiled.validator,
        compiled,
      );
    const problem = problemOf(compiled, actualArgs[0], ctx);
    return problem === undefined
      ? undefined
      : refusalOf("arguments", problem, compiled);
  };
  const returnsRefusal = (
    ctx: Ctx,
    result: unknown,
  ): SecretSideRefused | undefined => {
    if (!secretReturns()) return undefined;
    const compiled = ownReturns();
    const problem = problemOf(compiled, result, ctx);
    if (problem !== undefined) return refusalOf("returns", problem, compiled);
    return serializable(result)
      ? undefined
      : refused(
          "returns",
          "",
          "Value is not a supported Convex value.",
          compiled.validator,
          compiled,
        );
  };
  return {
    // Convex reads these at push, so compiling Confect's own check there refuses
    // an uncheckable or undeclarable side before it deploys.
    args: (): PropertyValidators | undefined =>
      secretArgs() ? (ownArgs(), undefined) : argsValidator(),
    returns: (): GenericValidator | undefined =>
      secretReturns() ? (ownReturns(), undefined) : returnsValidator(),
    // Convex passes every argument a caller sent when it checks none, so the
    // count is read here, from the outermost handler.
    handler: (
      ctx: Ctx,
      ...actualArgs: ReadonlyArray<Args>
    ): Promise<Returns> => {
      const argsProblem = argumentsRefusal(ctx, actualArgs);
      if (argsProblem !== undefined) return Promise.reject(argsProblem);
      return handler(ctx, actualArgs[0]!).then((result) => {
        const returnsProblem = returnsRefusal(ctx, result);
        if (returnsProblem !== undefined) throw returnsProblem;
        return result;
      });
    },
  };
};
