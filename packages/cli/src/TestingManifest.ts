import { Callback, type GroupSpec, type ManifestSection } from "@confect/core";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import { InvalidManifestSectionError } from "./CodegenError.js";
import type { Registry } from "./ManifestSections.js";

/**
 * A group as codegen found it in the specs, internal functions included.
 */
export interface FoundGroup {
  readonly path: string;
  readonly segments: ReadonlyArray<string>;
  readonly functions: ReadonlyArray<ManifestSection.TestingFunction>;
}

export interface Leaf {
  readonly spec: GroupSpec.AnyWithProps;
  readonly pathSegments: ReadonlyArray<string>;
}

/**
 * Every group that holds a function, by the path its refs name, such as
 * `tasks/tasks`, in spec order.
 */
export const groupsOf = (leaves: ReadonlyArray<Leaf>): Array<FoundGroup> => {
  const found: Array<FoundGroup> = [];
  const visit = (
    group: GroupSpec.AnyWithProps,
    segments: ReadonlyArray<string>,
  ) => {
    const functions = Object.values(group.functions).map(
      (spec): ManifestSection.TestingFunction => ({
        name: spec.name,
        kind: spec.runtimeAndFunctionType.functionType,
        visibility: spec.functionVisibility,
        provenance: spec.functionProvenance._tag,
      }),
    );
    if (functions.length > 0)
      found.push({ path: segments.join("/"), segments, functions });
    for (const [name, child] of Object.entries(group.groups))
      visit(child, [...segments, name]);
  };
  for (const leaf of leaves) visit(leaf.spec, leaf.pathSegments);
  return found.sort((a, b) => (a.path < b.path ? -1 : Number(a.path > b.path)));
};

const FunctionPath = Schema.String;
const Facts = Schema.Struct({
  owners: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.TemplateLiteral(["door:", Schema.String]),
    ),
  ),
  open: Schema.optional(Schema.Array(FunctionPath)),
  obligations: Schema.optional(
    Schema.Array(
      Schema.Union([
        Schema.Struct({ kind: Schema.Literal("roles") }),
        Schema.Struct({
          kind: Schema.Literals(["includeReach", "migration"]),
          ref: FunctionPath,
        }),
      ]),
    ),
  ),
  laws: Schema.optional(
    Schema.Array(
      Schema.Union([
        Schema.Struct({
          law: Schema.Literals(["placement", "audit"]),
          table: Schema.String,
        }),
        Schema.Struct({
          law: Schema.Literal("aggregate"),
          table: Schema.String,
          aggregate: Schema.String,
        }),
        Schema.Struct({
          law: Schema.Literal("reference"),
          table: Schema.String,
          field: Schema.String,
          policy: Schema.Literals(["restrict", "retain"]),
        }),
        Schema.Struct({
          law: Schema.Literal("unique"),
          table: Schema.String,
          index: Schema.String,
        }),
        Schema.Struct({
          law: Schema.Literal("fixed"),
          table: Schema.String,
          fields: Schema.Array(Schema.String),
        }),
        Schema.Struct({
          law: Schema.Literals(["observeEvent", "atomic"]),
        }),
      ]),
    ),
  ),
  ports: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        input: Schema.String,
        outcomes: Schema.NonEmptyArray(Schema.String),
      }),
    ),
  ),
});

type Facts = typeof Facts.Type;

/**
 * Run every declared section's `testing` over the functions it described and
 * the files its `generate` matched, and parse what it returns.
 */
export const collectFacts = (
  registry: Registry,
  modules: ReadonlyMap<string, ManifestSection.GenerateInput["modules"]>,
  groups: ReadonlyArray<FoundGroup>,
) =>
  Result.gen(function* () {
    const facts: Array<{ readonly key: string; readonly facts: Facts }> = [];
    for (const [key, { section, data }] of registry) {
      if (section.testing === undefined) continue;
      const invalid = (reason: string) =>
        new InvalidManifestSectionError({ sectionKey: key, reason });
      const raw = yield* Result.try({
        try: () =>
          section.testing?.({
            modules: modules.get(key) ?? [],
            functions: data.functions,
            groups: groups.map(({ path, functions }) => ({ path, functions })),
          }),
        catch: (cause) => invalid(`testing failed: ${String(cause)}`),
      });
      const parsed = yield* Result.mapError(
        Schema.decodeUnknownResult(Facts)(raw),
        (error) => invalid(`testing returned invalid facts: ${error.message}`),
      );
      facts.push({ key, facts: parsed });
    }
    return facts;
  });

export type Owner = "product" | `door:${string}`;

export interface PlannedGroup {
  readonly path: string;
  readonly segments: ReadonlyArray<string>;
  readonly owner: Owner;
  readonly functions: ReadonlyArray<string>;
  readonly open: ReadonlyArray<string>;
}

export type Obligation =
  | { readonly kind: "access"; readonly group: string }
  | { readonly kind: "realm" }
  | ManifestSection.DeclaredObligation;

export type Law =
  | { readonly law: "decodes"; readonly table: string }
  | { readonly law: "idScope"; readonly table: string }
  | ManifestSection.DeclaredLaw;

export interface Plan {
  readonly groups: ReadonlyArray<PlannedGroup>;
  readonly obligations: ReadonlyArray<Obligation>;
  readonly laws: ReadonlyArray<Law>;
  readonly ports: ReadonlyArray<ManifestSection.DeclaredPort>;
}

const split = (functionPath: string) => {
  const colon = functionPath.lastIndexOf(":");
  return colon < 0
    ? undefined
    : {
        group: functionPath.slice(0, colon),
        name: functionPath.slice(colon + 1),
      };
};

/**
 * The subject's groups, owners, open lists, obligations and laws. Every public
 * group owes its access proof, a door's as a product's does, so a raw Convex
 * function stays in its group. A fact naming no such group, public function,
 * table or port stops the plan.
 */
export const plan = ({
  groups,
  facts,
  tables,
  realm,
}: {
  readonly groups: ReadonlyArray<FoundGroup>;
  readonly facts: ReadonlyArray<{
    readonly key: string;
    readonly facts: Facts;
  }>;
  readonly tables: ReadonlyArray<string>;
  readonly realm: boolean;
}): Result.Result<Plan, InvalidManifestSectionError> =>
  Result.gen(function* () {
    const byPath = new Map(groups.map((group) => [group.path, group]));
    const isPublic = (functionPath: string) => {
      const parts = split(functionPath);
      return (
        parts !== undefined &&
        (byPath
          .get(parts.group)
          ?.functions.some(
            ({ name, visibility }) =>
              name === parts.name && visibility === "public",
          ) ??
          false)
      );
    };
    const owners = new Map<string, { owner: Owner; key: string }>();
    const open = new Set<string>();
    const declared: Array<ManifestSection.DeclaredObligation> = [];
    const declaredLaws: Array<ManifestSection.DeclaredLaw> = [];
    const ports: Array<ManifestSection.DeclaredPort> = [];
    for (const { key, facts: each } of facts) {
      const invalid = (reason: string) =>
        Result.fail(
          new InvalidManifestSectionError({ sectionKey: key, reason }),
        );
      for (const [path, owner] of Object.entries(each.owners ?? {})) {
        const group = byPath.get(path);
        if (
          group === undefined ||
          !group.functions.some(({ visibility }) => visibility === "public")
        )
          return yield* invalid(
            `testing names ${owner} the owner of ${path}, which is no public group.`,
          );
        const existing = owners.get(path);
        if (existing !== undefined && existing.owner !== owner)
          return yield* invalid(
            `testing names ${owner} the owner of ${path}, which section "${existing.key}" gives ${existing.owner}.`,
          );
        owners.set(path, { owner, key });
      }
      for (const functionPath of each.open ?? []) {
        if (!isPublic(functionPath))
          return yield* invalid(
            `testing opens ${functionPath}, which is no public function.`,
          );
        open.add(functionPath);
      }
      for (const obligation of each.obligations ?? []) {
        if (obligation.kind !== "roles" && !isPublic(obligation.ref))
          return yield* invalid(
            `testing owes ${obligation.kind} for ${obligation.ref}, which is no public function.`,
          );
        declared.push(obligation);
      }
      for (const law of each.laws ?? []) {
        if ("table" in law && !tables.includes(law.table))
          return yield* invalid(
            `testing declares the ${law.law} law on ${law.table}, which is no table.`,
          );
        declaredLaws.push(law);
      }
      for (const port of each.ports ?? []) {
        if (ports.some(({ name }) => name === port.name))
          return yield* invalid(
            `testing declares the port ${port.name} twice.`,
          );
        if (!/^[^#]+\.ts#[^#]+$/.test(port.input))
          return yield* invalid(
            `testing names ${port.input} the input codec of port ${port.name}; name it as <confect file>.ts#<export>.`,
          );
        ports.push({ ...port, outcomes: port.outcomes });
      }
    }
    const planned: Array<PlannedGroup> = [];
    for (const group of groups) {
      const publics = group.functions.filter(
        ({ visibility }) => visibility === "public",
      );
      if (publics.length === 0) continue;
      const owner = owners.get(group.path)?.owner ?? "product";
      const names = publics.map(({ name }) => name).sort();
      planned.push({
        path: group.path,
        segments: group.segments,
        owner,
        functions: names,
        open: names.filter((name) => open.has(`${group.path}:${name}`)),
      });
    }
    const unique = <A>(values: ReadonlyArray<A>) => {
      const seen = new Set<string>();
      return values.filter((value) => {
        const text = JSON.stringify(value);
        return seen.has(text) ? false : (seen.add(text), true);
      });
    };
    return {
      groups: planned,
      obligations: unique<Obligation>([
        ...planned.map(({ path }) => ({
          kind: "access" as const,
          group: path,
        })),
        ...(realm ? [{ kind: "realm" as const }] : []),
        ...declared,
      ]),
      laws: unique<Law>([
        ...[...tables].sort().flatMap((table) => [
          { law: "decodes" as const, table },
          { law: "idScope" as const, table },
        ]),
        ...declaredLaws,
      ]),
      ports: [...ports].sort((a, b) => (a.name < b.name ? -1 : 1)),
    };
  });

const isSecretNode = (ast: SchemaAST.AST): boolean =>
  ast._tag === "Declaration" &&
  (SchemaAST.resolve(ast)?.["representation"] as { id?: unknown } | undefined)
    ?.id === "effect/schema/Redacted";

/**
 * Whether `schema` holds a `Schema.Redacted` node, which
 * `Schema.RedactedFromValue` decodes to, through structs, records, arrays,
 * tuples, unions and suspended schemas. The kernel's redaction reads the same
 * nodes, so codegen lists a schema in the secret policy only when it has one.
 */
export const hasSecret = (schema: Schema.Top): boolean => {
  const seen = new Set<SchemaAST.AST>();
  const walk = (ast: SchemaAST.AST): boolean => {
    if (seen.has(ast)) return false;
    if (isSecretNode(ast)) return true;
    switch (ast._tag) {
      case "Objects":
        return (
          ast.propertySignatures.some((property) => walk(property.type)) ||
          ast.indexSignatures.some((index) => walk(index.type))
        );
      case "Arrays":
        return ast.elements.some(walk) || ast.rest.some(walk);
      case "Union":
        return ast.types.some(walk);
      case "Suspend":
        seen.add(ast);
        return walk(ast.thunk());
      default:
        return false;
    }
  };
  return walk(schema.ast);
};

/**
 * Every callback contract a handle in `schema` names, through structs, records,
 * arrays, tuples, unions, declarations' type parameters and suspended schemas.
 * A handle's contract sits on its encoded string.
 */
export const callbackContracts = (schema: Schema.Top): Array<Callback.Any> => {
  const found: Array<Callback.Any> = [];
  const seen = new Set<SchemaAST.AST>();
  const walk = (ast: SchemaAST.AST): void => {
    if (seen.has(ast)) return;
    seen.add(ast);
    const contract = Object.values(SchemaAST.resolve(ast) ?? {}).find(
      Callback.isContract,
    );
    if (contract !== undefined) {
      found.push(contract);
      return;
    }
    switch (ast._tag) {
      case "Objects":
        for (const property of ast.propertySignatures) walk(property.type);
        for (const index of ast.indexSignatures) walk(index.type);
        return;
      case "Arrays":
        for (const element of [...ast.elements, ...ast.rest]) walk(element);
        return;
      case "Union":
        for (const member of ast.types) walk(member);
        return;
      case "Declaration":
        for (const parameter of ast.typeParameters) walk(parameter);
        return;
      case "Suspend":
        walk(ast.thunk());
        return;
      default:
        return;
    }
  };
  walk(Schema.toEncoded(schema).ast);
  return found;
};

/**
 * One Confect function of a spec, with the codecs its ref carries.
 */
export interface ConfectFunction {
  readonly segments: ReadonlyArray<string>;
  readonly name: string;
  readonly visibility: "public" | "internal";
  readonly args: Schema.Top;
  readonly returns: Schema.Top;
}

/**
 * Every Confect function of a spec's groups, internal ones included.
 */
export const confectFunctions = (
  groups: Readonly<Record<string, GroupSpec.AnyWithProps>>,
  prefix: ReadonlyArray<string> = [],
): Array<ConfectFunction> => {
  const found: Array<ConfectFunction> = [];
  for (const [name, group] of Object.entries(groups)) {
    const segments = [...prefix, name];
    for (const spec of Object.values(group.functions))
      if (spec.functionProvenance._tag === "Confect")
        found.push({
          segments,
          name: spec.name,
          visibility: spec.functionVisibility,
          args: spec.functionProvenance.args,
          returns: spec.functionProvenance.returns,
        });
    found.push(...confectFunctions(group.groups, segments));
  }
  return found;
};
