import type { GroupSpec, ManifestSection } from "@confect/core";
import * as Array from "effect/Array";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as String from "effect/String";
import { InvalidManifestSectionError } from "./CodegenError.js";
import { stringify } from "./Json.js";
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
 * `tasks/tasks`, in path order.
 */
export const groupsOf = (leaves: ReadonlyArray<Leaf>): Array<FoundGroup> => {
  const found: Array<FoundGroup> = [];
  const visit = (
    group: GroupSpec.AnyWithProps,
    segments: ReadonlyArray<string>,
  ) => {
    const functions = Array.map(
      Record.values(group.functions),
      (spec): ManifestSection.TestingFunction => ({
        name: spec.name,
        kind: spec.runtimeAndFunctionType.functionType,
        visibility: spec.functionVisibility,
        provenance: spec.functionProvenance._tag,
      }),
    );
    if (functions.length > 0)
      found.push({ path: Array.join(segments, "/"), segments, functions });
    for (const [name, child] of Record.toEntries(group.groups))
      visit(child, [...segments, name]);
  };
  for (const leaf of leaves) visit(leaf.spec, leaf.pathSegments);
  return Array.sort(
    found,
    Order.mapInput(Order.String, (group: FoundGroup) => group.path),
  );
};

const FunctionPath = Schema.String;
const Facts = Schema.Struct({
  owners: Schema.Record(
    Schema.String,
    Schema.TemplateLiteral(["door:", Schema.String]),
  ).pipe(Schema.optional),
  open: Schema.Array(FunctionPath).pipe(Schema.optional),
  obligations: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("roles") }),
    Schema.Struct({
      kind: Schema.Literals(["includeReach", "migration"]),
      ref: FunctionPath,
    }),
  ]).pipe(Schema.Array, Schema.optional),
  laws: Schema.Union([
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
    Schema.Struct({ law: Schema.Literals(["observeEvent", "atomic"]) }),
  ]).pipe(Schema.Array, Schema.optional),
  ports: Schema.Struct({
    name: Schema.String,
    input: Schema.String,
    outcomes: Schema.NonEmptyArray(Schema.String),
  }).pipe(Schema.Array, Schema.optional),
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
        InvalidManifestSectionError.make({ sectionKey: key, reason });
      const raw = yield* Result.try({
        try: () =>
          section.testing?.({
            modules: modules.get(key) ?? [],
            functions: data.functions,
            groups: Array.map(groups, ({ path, functions }) => ({
              path,
              functions,
            })),
          }),
        catch: (cause) =>
          invalid(`testing failed: ${globalThis.String(cause)}`),
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

/**
 * A function path's group and name, split at its last colon.
 */
const split = (functionPath: string) =>
  pipe(
    functionPath,
    String.lastIndexOf(":"),
    Option.map((colon) => ({
      group: pipe(functionPath, String.slice(0, colon)),
      name: pipe(functionPath, String.slice(colon + 1)),
    })),
  );

/**
 * An app table as a fact may name it: its fields and its declared indexes.
 */
export interface TableInfo {
  readonly name: string;
  readonly fields: ReadonlyArray<string>;
  readonly indexes: ReadonlyArray<string>;
}

/**
 * Why a declared law names something the backend does not have: a table, a
 * field or index of it, or, for an aggregate, the mount that keeps it. An
 * aggregate in the app profile is an official wrapper's mount; an engine
 * aggregate is a component's, which the component profile plans.
 */
const lawRefusal = (
  law: ManifestSection.DeclaredLaw,
  tables: ReadonlyMap<string, TableInfo>,
  mounts: ReadonlyArray<string>,
): string | undefined => {
  if (!("table" in law)) return undefined;
  const table = tables.get(law.table);
  if (table === undefined) return `on ${law.table}, which is no table`;
  const missingField = (field: string) =>
    table.fields.includes(field)
      ? undefined
      : `on ${law.table}.${field}, which is no field of it`;
  switch (law.law) {
    case "aggregate":
      return mounts.includes(law.aggregate)
        ? undefined
        : `on ${law.table} kept by ${law.aggregate}, which is no mount`;
    case "unique":
      return table.indexes.includes(law.index)
        ? undefined
        : `on ${law.table} by ${law.index}, which is no index of it`;
    case "reference":
      return missingField(law.field);
    case "fixed":
      return pipe(
        law.fields,
        Array.findFirst((field) => Option.fromUndefinedOr(missingField(field))),
        Option.getOrUndefined,
      );
    default:
      return undefined;
  }
};

/**
 * The subject's groups, owners, open lists, obligations and laws. Every public
 * group owes its access proof, a door's as a product's does, so a raw Convex
 * function stays in its group. A fact naming no such group, public function,
 * table, field, index, mount or port stops the plan before anything is
 * written.
 */
export const plan = ({
  groups,
  facts,
  tables,
  mounts,
  realm,
}: {
  readonly groups: ReadonlyArray<FoundGroup>;
  readonly facts: ReadonlyArray<{
    readonly key: string;
    readonly facts: Facts;
  }>;
  readonly tables: ReadonlyArray<TableInfo>;
  readonly mounts: ReadonlyArray<string>;
  readonly realm: boolean;
}): Result.Result<Plan, InvalidManifestSectionError> =>
  Result.gen(function* () {
    const tableNamed = new Map(
      Array.map(tables, (table) => [table.name, table] as const),
    );
    const byPath = new Map(
      Array.map(groups, (group) => [group.path, group] as const),
    );
    const isPublic = (functionPath: string) =>
      Option.match(split(functionPath), {
        onNone: () => false,
        onSome: (parts) =>
          Array.some(
            byPath.get(parts.group)?.functions ?? [],
            ({ name, visibility }) =>
              name === parts.name && visibility === "public",
          ),
      });
    const owners = new Map<string, { owner: Owner; key: string }>();
    const open = new Set<string>();
    const declared: Array<ManifestSection.DeclaredObligation> = [];
    const declaredLaws: Array<ManifestSection.DeclaredLaw> = [];
    const ports: Array<ManifestSection.DeclaredPort> = [];
    for (const { key, facts: each } of facts) {
      const invalid = (reason: string) =>
        Result.fail(
          InvalidManifestSectionError.make({ sectionKey: key, reason }),
        );
      for (const [path, owner] of Record.toEntries(each.owners ?? {})) {
        const group = byPath.get(path);
        if (
          group === undefined ||
          !Array.some(
            group.functions,
            ({ visibility }) => visibility === "public",
          )
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
        const refused = lawRefusal(law, tableNamed, mounts);
        if (refused !== undefined)
          return yield* invalid(
            `testing declares the ${law.law} law ${refused}.`,
          );
        declaredLaws.push(law);
      }
      for (const port of each.ports ?? []) {
        if (Array.some(ports, ({ name }) => name === port.name))
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
      const publics = Array.filter(
        group.functions,
        ({ visibility }) => visibility === "public",
      );
      if (publics.length === 0) continue;
      const owner = owners.get(group.path)?.owner ?? "product";
      const names = pipe(
        publics,
        Array.map(({ name }) => name),
        Array.sort(Order.String),
      );
      planned.push({
        path: group.path,
        segments: group.segments,
        owner,
        functions: names,
        open: Array.filter(names, (name) => open.has(`${group.path}:${name}`)),
      });
    }
    const unique = <A>(values: ReadonlyArray<A>) => {
      const seen = new Set<string>();
      return Array.filter(values, (value) => {
        const text = stringify(value);
        return seen.has(text) ? false : (seen.add(text), true);
      });
    };
    return {
      groups: planned,
      obligations: unique<Obligation>([
        ...Array.map(planned, ({ path }) => ({
          kind: "access" as const,
          group: path,
        })),
        ...(realm ? [{ kind: "realm" as const }] : []),
        ...declared,
      ]),
      laws: unique<Law>([
        ...pipe(
          tables,
          Array.map(({ name }) => name),
          Array.sort(Order.String),
          Array.flatMap((table) => [
            { law: "decodes" as const, table },
            { law: "idScope" as const, table },
          ]),
        ),
        ...declaredLaws,
      ]),
      ports: Array.sort(
        ports,
        Order.mapInput(
          Order.String,
          (port: ManifestSection.DeclaredPort) => port.name,
        ),
      ),
    };
  });

/**
 * What a mount binds one of its component's settings to: a literal, or a
 * setting of the backend that mounts it.
 */
export type Binding = { readonly value: string } | { readonly from: string };

/**
 * A mount as the generated subject lists it, in the order a push runs inits.
 */
export interface MountEntry {
  readonly path: string;
  readonly kit: string;
  readonly env: Readonly<Record<string, Binding>>;
  readonly required: ReadonlyArray<string>;
}

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
  for (const [name, group] of Record.toEntries(groups)) {
    const segments = [...prefix, name];
    for (const spec of Record.values(group.functions))
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
