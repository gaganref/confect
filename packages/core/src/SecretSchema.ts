import * as Array from "effect/Array";
import * as SchemaAST from "effect/SchemaAST";

/**
 * Whether `ast` is a secret node: a `Schema.Redacted` declaration, which
 * `Schema.RedactedFromValue` decodes to.
 */
export const isSecretNode = (ast: SchemaAST.AST): boolean =>
  ast._tag === "Declaration" &&
  (SchemaAST.resolve(ast)?.["representation"] as { id?: unknown } | undefined)
    ?.id === "effect/schema/Redacted";

/**
 * Whether a secret node is reachable from `ast`, through structs, records,
 * arrays, tuples, unions, the type parameters of a declaration such as
 * `Option`, and suspended schemas. A suspension is followed once per ancestry,
 * so a recursive schema ends, and a suspension reused at another path is
 * followed again there.
 */
const reachesSecret = (
  ast: SchemaAST.AST,
  ancestry: Set<SchemaAST.AST>,
): boolean => {
  if (isSecretNode(ast)) return true;
  switch (ast._tag) {
    case "Objects":
      return (
        Array.some(ast.propertySignatures, (p) =>
          reachesSecret(p.type, ancestry),
        ) ||
        Array.some(ast.indexSignatures, (i) => reachesSecret(i.type, ancestry))
      );
    case "Arrays":
      return Array.some([...ast.elements, ...ast.rest], (e) =>
        reachesSecret(e, ancestry),
      );
    case "Union":
      return Array.some(ast.types, (t) => reachesSecret(t, ancestry));
    case "Declaration":
      return Array.some(ast.typeParameters, (t) => reachesSecret(t, ancestry));
    case "Suspend": {
      if (ancestry.has(ast)) return false;
      ancestry.add(ast);
      const found = reachesSecret(ast.thunk(), ancestry);
      ancestry.delete(ast);
      return found;
    }
    default:
      return false;
  }
};

const reaches = new WeakMap<SchemaAST.AST, boolean>();

/**
 * Whether a schema's AST holds a secret anywhere beneath it. The test kernel's
 * artifact redaction and codegen's secret policy both read this one walk.
 */
export const hasSecret = (ast: SchemaAST.AST): boolean => {
  let found = reaches.get(ast);
  if (found === undefined) {
    found = reachesSecret(ast, new Set());
    reaches.set(ast, found);
  }
  return found;
};
