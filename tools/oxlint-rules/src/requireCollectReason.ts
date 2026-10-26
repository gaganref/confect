import type { ESTree, OxlintScope, OxlintSourceCode } from "effect-oxlint";
import { Diagnostic, Rule, RuleContext, Visitor } from "effect-oxlint";
import * as Effect from "effect/Effect";

const memberName = (node: ESTree.Node): string | undefined =>
  node.type === "MemberExpression" &&
  !node.computed &&
  node.property.type === "Identifier"
    ? node.property.name
    : undefined;

const definitionOf = (
  source: OxlintSourceCode,
  identifier: Extract<ESTree.Node, { type: "Identifier" }>,
) => {
  for (
    let scope: OxlintScope | null = source.getScope(identifier);
    scope;
    scope = scope.upper
  ) {
    const variable = scope.set.get(identifier.name);
    if (!variable) continue;
    if (
      variable.defs.length !== 1 ||
      variable.references.some(
        (reference) => reference.isWrite() && !reference.init,
      )
    )
      return undefined;
    return variable.defs[0]?.node;
  }
  return undefined;
};

const isCollect = (source: OxlintSourceCode, node: ESTree.Node): boolean => {
  if (node.type === "CallExpression") return isCollect(source, node.callee);
  const identifier =
    node.type === "MemberExpression" && memberName(node) === "collect"
      ? node.object
      : node;
  if (identifier.type !== "Identifier") return false;
  const declaration = definitionOf(source, identifier);
  if (
    !declaration ||
    (declaration.type !== "ImportSpecifier" &&
      declaration.type !== "ImportNamespaceSpecifier")
  )
    return false;
  const parent = declaration.parent;
  if (parent.type !== "ImportDeclaration" || parent.importKind === "type")
    return false;
  const module = parent.source.value;
  if (declaration.type === "ImportNamespaceSpecifier")
    return (
      module === "@confect/server/QueryStream" && memberName(node) === "collect"
    );
  const imported =
    declaration.imported.type === "Identifier"
      ? declaration.imported.name
      : declaration.imported.value;
  return (
    declaration.importKind !== "type" &&
    ((module === "@confect/server" &&
      imported === "QueryStream" &&
      memberName(node) === "collect") ||
      (module === "@confect/server/QueryStream" &&
        imported === "collect" &&
        node.type === "Identifier"))
  );
};

const isUnrangedAll = (
  source: OxlintSourceCode,
  node: ESTree.Node,
  seen = new Set<ESTree.Node>(),
): boolean => {
  if (seen.has(node)) return false;
  seen.add(node);
  if (node.type === "Identifier") {
    const declaration = definitionOf(source, node);
    return (
      declaration?.type === "VariableDeclarator" &&
      declaration.init !== null &&
      isUnrangedAll(source, declaration.init, seen)
    );
  }
  if (node.type !== "CallExpression") return false;
  if (memberName(node.callee) === "all")
    return (
      node.arguments.length === 0 ||
      (node.arguments[0]?.type === "Identifier" &&
        node.arguments[0].name === "undefined")
    );
  return (
    node.callee.type === "MemberExpression" &&
    isUnrangedAll(source, node.callee.object, seen)
  );
};

export const requireCollectReason = Rule.define({
  name: "require-collect-reason",
  meta: Rule.meta({
    type: "problem",
    description:
      "Require a COLLECT: reason before collecting an unranged all().",
  }),
  create: function* () {
    const ctx = yield* RuleContext;
    return Visitor.on("CallExpression", (node) => {
      const direct =
        isCollect(ctx.sourceCode, node.callee) &&
        node.arguments[0] &&
        isUnrangedAll(ctx.sourceCode, node.arguments[0]);
      const piped =
        node.callee.type === "MemberExpression" &&
        memberName(node.callee) === "pipe" &&
        isUnrangedAll(ctx.sourceCode, node.callee.object) &&
        node.arguments.some((argument) => isCollect(ctx.sourceCode, argument));
      if (!direct && !piped) return Effect.void;
      let statement: ESTree.Node = node;
      while (
        statement.parent &&
        statement.parent.type !== "Program" &&
        statement.parent.type !== "BlockStatement"
      )
        statement = statement.parent;
      const comment = ctx.sourceCode.getCommentsBefore(statement).at(-1);
      if (
        comment &&
        /COLLECT:[ \t]*[^\s*]/.test(comment.value) &&
        ctx.sourceCode.text
          .slice(comment.range[1], statement.range[0])
          .trim() === ""
      )
        return Effect.void;
      return ctx.report(
        Diagnostic.make({
          node,
          message:
            "Add a COLLECT: reason before collecting an unranged all(), or paginate it.",
        }),
      );
    });
  },
});
