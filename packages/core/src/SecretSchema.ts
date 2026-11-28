import * as Array from "effect/Array";
import * as SchemaAST from "effect/SchemaAST";

/**
 * Whether `ast` is a secret node: a `Schema.Redacted` declaration, which
 * `Schema.RedactedFromValue` decodes to. The declaration's own annotations name
 * it. `SchemaAST.resolve` would read the last check's annotations instead, so a
 * secret with a check, or a check and a brand, would not read as one.
 */
export const isSecretNode = (ast: SchemaAST.AST): boolean =>
  ast._tag === "Declaration" &&
  (ast.annotations?.["representation"] as { id?: unknown } | undefined)?.id ===
    "effect/schema/Redacted";

/**
 * The most distinct nodes one walk visits. A schema that reaches more reads as
 * holding a secret, so the walk fails closed. The only schemas known to reach
 * it unfold without ever repeating a node: a recursive schema whose recursion
 * runs through an encoding, then flipped.
 */
const nodeLimit = 10_000;

/**
 * Whether a secret node is reachable from `root`, through structs, records
 * (keys and values), arrays, tuples, unions, the type parameters of a
 * declaration such as `Option`, suspended schemas, and every schema in a node's
 * encoding chain. A secret that an encoding decodes into a plain type, such as
 * `Schema.decodeTo` of a secret into a string, is still a secret on the wire.
 *
 * Reachability does not depend on the path, so each node is visited once, which
 * ends every recursive schema whose nodes repeat. At or below an encoding
 * link's schema, the walk does not descend past a node that is its own
 * `SchemaAST.toType`, beneath which nothing has an encoding. A secret there
 * would be a `Schema.Redacted` with no encoding on the wire side, whose wire
 * form is the `Redacted` value itself, which no function side, route body or
 * stored document can carry. That ends the links Effect derives with
 * `toEncoded`, such as `Schema.encodeKeys`, `Schema.encode` and
 * `Schema.catchEncoding`, which unfold a recursive schema into fresh nodes on
 * every level. The decoded side is walked whole, so a hand-written policy's
 * `Schema.Redacted` field still counts.
 */
const reachesSecret = (root: SchemaAST.AST): boolean => {
  const visited = {
    decoded: new Set<SchemaAST.AST>(),
    linked: new Set<SchemaAST.AST>(),
  };
  // A work list rather than recursion, so a deep schema cannot overflow the
  // stack before the node limit.
  const pending: Array<readonly [SchemaAST.AST, keyof typeof visited]> = [
    [root, "decoded"],
  ];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [ast, side] = next;
    if (isSecretNode(ast)) return true;
    if (visited[side].has(ast)) continue;
    visited[side].add(ast);
    if (visited.decoded.size + visited.linked.size > nodeLimit) return true;
    if (side === "linked" && SchemaAST.toType(ast) === ast) continue;
    for (const link of ast.encoding ?? []) pending.push([link.to, "linked"]);
    for (const child of children(ast)) pending.push([child, side]);
  }
  return false;
};

/**
 * The nodes directly beneath `ast` on its decoded side: a struct's property
 * types and each index signature's key and value, an array's elements, a
 * union's members, a declaration's type parameters and a suspension's schema.
 */
const children = (ast: SchemaAST.AST): ReadonlyArray<SchemaAST.AST> => {
  switch (ast._tag) {
    case "Objects":
      return [
        ...Array.map(ast.propertySignatures, (p) => p.type),
        ...Array.flatMap(ast.indexSignatures, (i) => [i.parameter, i.type]),
      ];
    case "Arrays":
      return [...ast.elements, ...ast.rest];
    case "Union":
      return ast.types;
    case "Declaration":
      return ast.typeParameters;
    case "Suspend":
      return [ast.thunk()];
    default:
      return [];
  }
};

const reaches = new WeakMap<SchemaAST.AST, boolean>();

/**
 * Whether a schema's AST holds a secret anywhere beneath it. Four users read
 * this one walk: a Convex function's side, which then registers no Convex
 * validator and is checked by Confect; a route, which then refuses the spec;
 * codegen's secret policy for the test kernel; and the test kernel's artifact
 * redaction.
 */
export const hasSecret = (ast: SchemaAST.AST): boolean => {
  let found = reaches.get(ast);
  if (found === undefined) {
    found = reachesSecret(ast);
    reaches.set(ast, found);
  }
  return found;
};
