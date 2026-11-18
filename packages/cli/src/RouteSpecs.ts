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
 * Whether every value of an encoded AST is one a URL carries: a string, or for
 * a query arg also an array of strings, which Effect's query decoder reads from
 * repeated keys. A union carries what each member carries, and a suspension
 * what it resolves to, as Effect's decoders walk through both. A suspension met
 * again on its own path adds no value of its own.
 */
const carries = (
  ast: SchemaAST.AST,
  arrays: boolean,
  seen: ReadonlySet<SchemaAST.AST> = new Set(),
): boolean => {
  switch (ast._tag) {
    case "String":
    case "TemplateLiteral":
      return true;
    case "Literal":
      return typeof ast.literal === "string";
    case "Union":
      return Arr.every(
        ast.types,
        (member) =>
          member._tag === "Undefined" || carries(member, arrays, seen),
      );
    case "Suspend":
      return (
        seen.has(ast) || carries(ast.thunk(), arrays, new Set([...seen, ast]))
      );
    case "Arrays":
      return (
        arrays &&
        Arr.every([...ast.elements, ...ast.rest], (element) =>
          carries(element, false, seen),
        )
      );
    default:
      return false;
  }
};

/**
 * Refuse a route whose path parameter does not encode as a string, or, on a
 * method without a body, an arg that does not encode as a string or an array of
 * strings. Effect reads both from the URL through the StringTree codec, so such
 * an arg would build and then fail every request.
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
    const encoded = Result.try(
      () =>
        SchemaAST.toEncoded(
          Schema.toCodecStringTree(Schema.Struct({ field })).ast,
        ) as SchemaAST.Objects,
    );
    const ast = Result.isSuccess(encoded)
      ? encoded.success.propertySignatures[0]?.type
      : undefined;
    if (param && (ast === undefined || !carries(ast, false)))
      return refuse(
        `path param "${name}" does not encode as a string, so no URL can carry it.`,
      );
    if (!param && (ast === undefined || !carries(ast, true)))
      return refuse(
        `${method} arg "${name}" does not encode as a string or an array of strings, so no query string can carry it. Send it in a body with another method, or give it a string encoding.`,
      );
  }
  return Result.void;
};
