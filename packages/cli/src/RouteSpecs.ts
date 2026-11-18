import { FunctionSpec, type GroupSpec, type Http } from "@confect/core";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Order from "effect/Order";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as Str from "effect/String";
import * as HttpMethod from "effect/http/HttpMethod";
import { InvalidDeclarationError } from "./CodegenError.js";
import type { LoadedLeafModule } from "./LeafModule.js";

type Leaf = Pick<LoadedLeafModule, "spec" | "pathSegments" | "relativePath">;

/**
 * A route spec, under the module path `Routes.make` names its group by, with
 * the spec file that declares it, relative to `confect/`.
 *
 * @internal
 */
export interface RouteSpec extends Http.SpecRoute {
  readonly functionPath: string;
  readonly source: string;
}

/**
 * Every route spec the leaves declare, in function path order. A leaf's own
 * functions are its routes; a leaf has no nested groups, as `Routes.make` reads
 * `spec.functions` alone.
 *
 * @internal
 */
export const of = (leaves: ReadonlyArray<Leaf>): ReadonlyArray<RouteSpec> =>
  pipe(
    Arr.flatMap(leaves, (leaf) => {
      const group = Arr.join(leaf.pathSegments, "/");
      return Arr.filterMap(Record.values(leaf.spec.functions), (spec) =>
        FunctionSpec.isHttpAction(spec)
          ? Result.succeed({
              group,
              spec,
              functionPath: `${group}:${spec.name}`,
              source: pipe(leaf.relativePath, Str.replaceAll("\\", "/")),
            })
          : Result.failVoid,
      );
    }),
    Arr.sort(
      Order.mapInput(Order.String, (route: RouteSpec) => route.functionPath),
    ),
  );

const kinds = (
  group: GroupSpec.AnyWithProps,
): { readonly routes: boolean; readonly convex: boolean } => {
  const own = Record.values(group.functions);
  const nested = Arr.map(Record.values(group.groups), kinds);
  return {
    routes:
      Arr.some(own, FunctionSpec.isHttpAction) ||
      Arr.some(nested, ({ routes }) => routes),
    convex:
      Arr.some(own, (spec) => !FunctionSpec.isHttpAction(spec)) ||
      Arr.some(nested, ({ convex }) => convex),
  };
};

/**
 * Whether a leaf declares routes and no Convex function, so Convex registers
 * nothing from it.
 *
 * @internal
 */
export const routeOnly = (spec: GroupSpec.AnyWithProps): boolean => {
  const { routes, convex } = kinds(spec);
  return routes && !convex;
};

/**
 * A string leaf: a value a URL carries as one string and reads back unchanged.
 * `verbatim` when decoding hands back the very string sent, and `strings` the
 * strings it sends when they are finitely many.
 */
interface StringLeaf {
  readonly verbatim: boolean;
  readonly strings: ReadonlyArray<string> | undefined;
}

/**
 * The string leaf a StringTree AST is, if it is one. A transformation is the
 * leaf its encoded side is. A suspension met again on its own path adds no
 * value of its own.
 */
const leaf = (
  ast: SchemaAST.AST,
  seen: ReadonlySet<SchemaAST.AST> = new Set(),
): StringLeaf | undefined => {
  if (ast.encoding !== undefined) {
    const encoded = leaf(Arr.lastNonEmpty(ast.encoding).to, seen);
    return encoded === undefined
      ? undefined
      : { verbatim: false, strings: encoded.strings };
  }
  switch (ast._tag) {
    case "String":
    case "TemplateLiteral":
      return { verbatim: true, strings: undefined };
    case "Literal":
      return typeof ast.literal === "string"
        ? { verbatim: true, strings: [ast.literal] }
        : undefined;
    case "Suspend":
      return seen.has(ast)
        ? { verbatim: true, strings: [] }
        : leaf(ast.thunk(), new Set([...seen, ast]));
    case "Union":
      return union(ast.types, seen);
    default:
      return undefined;
  }
};

interface Member {
  readonly type: SchemaAST.AST;
  readonly leaf: StringLeaf;
}

/**
 * A union is a string leaf when its members are and no string one member sends
 * can decode through another, which Effect may try first. Two verbatim members
 * agree on any string both accept.
 */
const union = (
  types: ReadonlyArray<SchemaAST.AST>,
  seen: ReadonlySet<SchemaAST.AST>,
): StringLeaf | undefined => {
  const members: Array<Member> = [];
  for (const type of types) {
    const member = leaf(type, seen);
    if (member === undefined) return undefined;
    members.push({ type, leaf: member });
  }
  const clash = Arr.some(members, (a, index) =>
    Arr.some(
      Arr.drop(members, index + 1),
      (b) => !(a.leaf.verbatim && b.leaf.verbatim) && overlap(a, b),
    ),
  );
  if (clash) return undefined;
  return {
    verbatim: Arr.every(members, (member) => member.leaf.verbatim),
    strings: Arr.every(members, (member) => member.leaf.strings !== undefined)
      ? Arr.flatMap(members, (member) => member.leaf.strings ?? [])
      : undefined,
  };
};

/**
 * Whether a string one member sends could decode through the other. Two members
 * with unbounded strings may share one.
 */
const overlap = (a: Member, b: Member): boolean => {
  const [bounded, other] = a.leaf.strings === undefined ? [b, a] : [a, b];
  if (bounded.leaf.strings === undefined) return true;
  const reads = Schema.is(
    Schema.make<Schema.Top>(SchemaAST.toEncoded(other.type)),
  );
  return Arr.some(bounded.leaf.strings, (string) => reads(string));
};

/**
 * Whether a query value is an array or a tuple of string leaves, which Effect
 * sends as one query key repeated. Every element must be present, since the URL
 * cannot say which one is missing.
 */
const listed = (
  ast: SchemaAST.AST,
  seen: ReadonlySet<SchemaAST.AST> = new Set(),
): boolean => {
  if (ast.encoding !== undefined) return false;
  switch (ast._tag) {
    case "Suspend":
      return !seen.has(ast) && listed(ast.thunk(), new Set([...seen, ast]));
    case "Arrays":
      return (
        Arr.every(
          ast.elements,
          (element) =>
            !SchemaAST.isOptional(element) && leaf(element) !== undefined,
        ) && Arr.every(ast.rest, (element) => leaf(element) !== undefined)
      );
    default:
      return false;
  }
};

/**
 * An optional arg left out, or given as `undefined`, is absent from the URL and
 * from the decoded args alike, so only its other members need to round-trip.
 */
const present = (ast: SchemaAST.AST): SchemaAST.AST => {
  if (!SchemaAST.isUnion(ast) || ast.encoding !== undefined) return ast;
  const types = Arr.filter(ast.types, (type) => type._tag !== "Undefined");
  const [only] = types;
  return types.length === 1 && only !== undefined
    ? only
    : new SchemaAST.Union(types, ast.options);
};

/**
 * Refuse a route with an arg whose value would not come back from the URL
 * unchanged: a path parameter that is not a required string leaf, or, on a
 * method without a body, an arg that is neither a string leaf nor an array or
 * tuple of them. Effect reads both through the StringTree codec, so such an arg
 * would build and then fail some requests, or change their values.
 *
 * @internal
 */
export const check = (
  route: RouteSpec,
): Result.Result<void, InvalidDeclarationError> => {
  const { method, params } = route.spec.route;
  const refuse = (reason: string) =>
    Result.fail(
      InvalidDeclarationError.make({
        declarationPath: `confect/${route.source}`,
        reason: `Route "${route.functionPath}" ${reason}`,
      }),
    );
  const provenance = route.spec.functionProvenance;
  if (provenance._tag !== "Confect") return Result.void;
  const queried = !HttpMethod.hasBody(method);
  const { fields } = provenance.args;
  for (const [name, field] of Record.toEntries(fields)) {
    const param = params.includes(name);
    if (!param && !queried) continue;
    const codec = Result.try(
      () =>
        Schema.toCodecStringTree(Schema.Struct({ field }))
          .ast as SchemaAST.Objects,
    );
    const ast = Result.isSuccess(codec)
      ? codec.success.propertySignatures[0]?.type
      : undefined;
    const optional = ast !== undefined && SchemaAST.isOptional(ast);
    if (param && (ast === undefined || optional || leaf(ast) === undefined))
      return refuse(
        `path param "${name}" does not round-trip through a URL. A path param must encode as one required string, and no member of a union may read as another.`,
      );
    const value = ast !== undefined && optional ? present(ast) : ast;
    if (
      !param &&
      (value === undefined || (leaf(value) === undefined && !listed(value)))
    )
      return refuse(
        `${method} arg "${name}" does not round-trip through a query string. It must encode as one string, or as an array or tuple of strings outside any union with no optional, undefined or nested element, and no member of a union may read as another. Send it in a body with another method, or give it a string encoding.`,
      );
  }
  return Result.void;
};
