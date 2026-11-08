import type { DefaultFunctionArgs, FunctionReference } from "convex/server";
import { getFunctionAddress } from "convex/server";
import * as Array from "effect/Array";
import * as Data from "effect/Data";
import * as Result from "effect/Result";
import { memoize, pipe } from "effect/Function";
import * as Match from "effect/Match";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import type * as FunctionProvenance from "./FunctionProvenance.js";
import type * as FunctionSpec from "./FunctionSpec.js";
import * as GenericId from "./GenericId.js";
import type * as GroupSpec from "./GroupSpec.js";
import * as IdScope from "./IdScope.js";
import * as Lazy from "./Lazy.js";
import type * as MiddlewareSpec from "./MiddlewareSpec.js";
import * as Ref from "./Ref.js";
import type * as Refs from "./Refs.js";
import type * as RuntimeAndFunctionType from "./RuntimeAndFunctionType.js";
import * as Spec from "./Spec.js";
import type * as Table_ from "./Table.js";

export class EmptyComponentScopeError extends Data.TaggedError(
  "EmptyComponentScopeError",
)<{
  readonly definitionScope: IdScope.IdScope;
}> {
  override get message(): string {
    return "A component contract requires a nonempty definition scope.";
  }
}

export class ComponentNameCollisionError extends Data.TaggedError(
  "ComponentNameCollisionError",
)<{
  readonly groupPath: string;
  readonly functionName: string;
}> {
  override get message(): string {
    return `Group and function at same level have same name ('${this.groupPath}:${this.functionName}')`;
  }
}

export class UninstalledComponentReferenceError extends Data.TaggedError(
  "UninstalledComponentReferenceError",
)<{
  readonly definitionScope: IdScope.IdScope;
}> {
  override get message(): string {
    return "Component.bind expects an installed component from the generated components registry.";
  }
}

const validateNames = (
  groups: Readonly<Record<string, GroupSpec.AnyWithProps>>,
  prefix = "",
): Result.Result<void, ComponentNameCollisionError> => {
  for (const [name, group] of Record.toEntries(groups)) {
    const path = prefix === "" ? name : `${prefix}/${name}`;
    for (const functionSpec of Record.values(group.functions)) {
      if (Record.has(group.groups, functionSpec.name)) {
        return Result.fail(
          new ComponentNameCollisionError({
            groupPath: path,
            functionName: functionSpec.name,
          }),
        );
      }
    }
    const nested = validateNames(group.groups, path);
    if (Result.isFailure(nested)) return nested;
  }
  return Result.succeed(undefined);
};

const validateContract = (
  scope: IdScope.IdScope,
  groups: Readonly<Record<string, GroupSpec.AnyWithProps>>,
): Result.Result<
  void,
  EmptyComponentScopeError | ComponentNameCollisionError
> =>
  scope === ""
    ? Result.fail(new EmptyComponentScopeError({ definitionScope: scope }))
    : validateNames(groups);

const TypeId = "~@confect/core/Component";
const BoundTypeId = "~@confect/core/BoundComponent";

/**
 * Convex's generated ComponentApi erases database ID brands at the boundary.
 */
type Wire<A> = A extends { readonly __tableName: string }
  ? string
  : A extends
        | string
        | number
        | bigint
        | boolean
        | null
        | undefined
        | ArrayBuffer
    ? A
    : { [K in keyof A]: Wire<A[K]> };

type OmitEmpty<A> = {
  [K in keyof A as keyof A[K] extends never ? never : K]: A[K];
};
type ApiGroups<
  GroupSpec_ extends GroupSpec.AnyWithProps,
  Name extends string | undefined,
> = OmitEmpty<{
  [GroupName in GroupSpec.Name<GroupSpec_>]: ApiGroup<
    GroupSpec.WithName<GroupSpec_, GroupName>,
    Name
  >;
}>;
type ApiGroup<
  GroupSpec_ extends GroupSpec.AnyWithProps,
  Name extends string | undefined,
> = ApiGroups<GroupSpec.Groups<GroupSpec_>, Name> & {
  [
    FunctionSpec_ in GroupSpec.Functions<GroupSpec_> as FunctionSpec.GetFunctionVisibility<FunctionSpec_> extends "public"
      ? FunctionSpec.Name<FunctionSpec_>
      : never
  ]: FunctionReference<
    RuntimeAndFunctionType.GetFunctionType<
      FunctionSpec_["runtimeAndFunctionType"]
    >,
    "internal",
    Extract<Wire<FunctionSpec.EncodedArgs<FunctionSpec_>>, DefaultFunctionArgs>,
    Wire<FunctionSpec.EncodedReturns<FunctionSpec_>>,
    Name
  >;
};

export type Api<
  Spec_ extends Spec.AnyWithProps,
  Name extends string | undefined = string | undefined,
> = ApiGroups<Spec.Groups<Spec_>, Name>;

interface Tree {
  readonly [key: string]: Tree | Ref.Any;
}

/**
 * Each grouped table's name, mapped to its id field and that id's table.
 */
export interface GroupMap {
  readonly [table: string]: { readonly key: string; readonly table: string };
}

export interface Component<
  Spec_ extends Spec.AnyWithProps,
  Scope extends IdScope.IdScope,
  Tables extends string = string,
  Groups_ extends GroupMap = GroupMap,
> {
  readonly [TypeId]: {
    readonly refs: Tree;
    readonly scope: Scope;
    readonly tables: ReadonlyArray<Tables>;
    readonly groups: Groups_;
  };
  readonly "~Spec": Spec_;
}

/**
 * A component's tables as `contract` takes them: a table, or the name of a
 * system table.
 */
export type TableEntry = string | Table_.AnyWithProps;

type EntryName<Entry extends TableEntry> = Entry extends string
  ? Entry
  : Entry extends Table_.AnyWithProps
    ? Table_.Name<Entry>
    : never;

type MaybeTable<Entry, InTuple, All = Entry> = Entry extends Table_.AnyWithProps
  ? [All, InTuple] extends [Entry, true]
    ? never
    : `${Table_.Name<Entry>} may be absent: list one table or name per entry, in a tuple`
  : never;

type StrayGroup<
  Entries extends ReadonlyArray<TableEntry>,
  Scope extends IdScope.IdScope,
> = {
  [Index in keyof Entries]:
    | MaybeTable<
        Entries[Index],
        number extends Entries["length"] ? false : true
      >
    | (Entries[Index] extends {
        readonly tableName: infer Name extends string;
        readonly group: Table_.Group<infer Key, infer Target, infer GroupScope>;
      }
        ? [Target, GroupScope] extends [EntryName<Entries[number]>, Scope]
          ? never
          : `${Name}.${Key} is not an id of a table of this component`
        : never);
}[number];

/**
 * The group map `contract` publishes for these table entries.
 */
export type Groups<Entries extends ReadonlyArray<TableEntry>> = {
  readonly [
    Entry in Extract<
      Entries[number],
      { readonly tableName: string; readonly group: Table_.Group }
    > as Entry["tableName"]
  ]: {
    readonly key: Entry["group"]["key"];
    readonly table: Entry["group"]["table"];
  };
};

/**
 * `unknown` when every entry is one table or name and every group's id names a
 * table of this component in its scope, otherwise an object type naming the
 * refused entry.
 */
export type CheckGroups<
  Entries extends ReadonlyArray<TableEntry>,
  Scope extends IdScope.IdScope,
> = [StrayGroup<Entries, Scope>] extends [never]
  ? unknown
  : { readonly "~StrayGroup": StrayGroup<Entries, Scope> };

/**
 * An opaque identity: its string representation is not part of the API.
 */
export type MountScope<
  Parent extends IdScope.IdScope,
  Name extends string | undefined,
> = IdScope.Mount<Parent, Name>;

type MountName<ComponentApi> =
  ComponentApi extends FunctionReference<any, any, any, any, infer Name>
    ? Name
    : ComponentApi extends object
      ? {
          [Key in keyof ComponentApi]: MountName<ComponentApi[Key]>;
        }[keyof ComponentApi]
      : never;

type BindRefs<
  RefTree,
  From extends IdScope.IdScope,
  To extends IdScope.IdScope,
> = RefTree extends Ref.Any
  ? RefTree extends { readonly _tag: "Convex" }
    ? Ref.ConvexRef<
        Ref.GetRuntimeAndFunctionType<RefTree>,
        "internal",
        Extract<Wire<Ref.Args<RefTree>>, DefaultFunctionArgs>,
        Wire<Ref.Returns<RefTree>>
      >
    : Extract<
        Ref.Ref<
          Ref.GetRuntimeAndFunctionType<RefTree>,
          "internal",
          Extract<
            GenericId.Rebase<Ref.Args<RefTree>, From, To>,
            DefaultFunctionArgs
          >,
          GenericId.Rebase<Ref.Returns<RefTree>, From, To>,
          GenericId.Rebase<Ref.Error<RefTree>, From, To>
        >,
        { readonly _tag: RefTree["_tag"] }
      >
  : { [Key in keyof RefTree]: BindRefs<RefTree[Key], From, To> };

export type Bound<
  Spec_ extends Spec.AnyWithProps,
  From extends IdScope.IdScope,
  To extends IdScope.IdScope,
  Tables extends string,
> = BindRefs<Refs.Refs<Spec_, Ref.AnyPublic>, From, To> & {
  readonly [BoundTypeId]: {
    readonly from: From;
    readonly scope: To;
    readonly tables: ReadonlyArray<Tables>;
  };
};

/**
 * Build a publishable contract containing only exported functions and codecs.
 * `tables` lists the component's tables, each a table or a system table's name.
 * A table grouped by an id must group by an id of one of these tables.
 */
export function contract<
  Spec_ extends Spec.AnyWithProps,
  const Scope extends IdScope.IdScope,
  const Entries extends ReadonlyArray<TableEntry>,
>(
  spec: Spec_,
  scope: Scope,
  tables: Entries & CheckGroups<Entries, Scope>,
): Component<Spec_, Scope, EntryName<Entries[number]>, Groups<Entries>>;
/**
 * Table names alone, as in an explicit third type argument, carry no groups.
 */
export function contract<
  Spec_ extends Spec.AnyWithProps,
  const Scope extends IdScope.IdScope,
  const Tables extends string,
>(
  spec: Spec_,
  scope: Scope,
  tables: ReadonlyArray<Tables>,
): Component<Spec_, Scope, Tables, {}>;
export function contract(
  spec: Spec.AnyWithProps,
  scope: IdScope.IdScope,
  tables: ReadonlyArray<TableEntry>,
): Component<Spec.AnyWithProps, IdScope.IdScope> {
  const specGroups = Spec.groups(spec);
  Result.getOrThrow(validateContract(scope, specGroups));
  const collect = (
    groups: Readonly<Record<string, GroupSpec.AnyWithProps>>,
    prefix = "",
  ): Tree =>
    pipe(
      groups,
      Record.map((group, name) => {
        const path = prefix === "" ? name : `${prefix}/${name}`;
        const functions = pipe(
          group.functions,
          Record.filter((functionSpec) => {
            return Match.value(functionSpec.functionVisibility).pipe(
              Match.when("public", () => true),
              Match.when("internal", () => false),
              Match.exhaustive,
            );
          }),
          Record.map((functionSpec) =>
            Ref.make(path, functionSpec, group.middlewareAttachments),
          ),
        );
        return { ...collect(group.groups, path), ...functions };
      }),
      Record.filter((children) => !Record.isEmptyRecord(children)),
    );
  const grouped: GroupMap = pipe(
    tables,
    Array.flatMap((entry) =>
      typeof entry !== "string" && entry.group !== undefined
        ? [[entry.tableName, entry.group] as const]
        : [],
    ),
    Record.fromEntries,
  );
  const published: Component<
    Spec.AnyWithProps,
    IdScope.IdScope
  >[typeof TypeId] = {
    refs: collect(specGroups),
    scope,
    tables: Array.map(tables, (entry) =>
      typeof entry === "string" ? entry : entry.tableName,
    ),
    groups: grouped,
  };
  return { [TypeId]: published } as Component<
    Spec.AnyWithProps,
    IdScope.IdScope
  >;
}

/**
 * Each grouped table's id field and the table that id names.
 */
export const groups = <Groups_ extends GroupMap>(
  component: Component<Spec.AnyWithProps, IdScope.IdScope, string, Groups_>,
): Groups_ =>
  Record.map(component[TypeId].groups, ({ key, table }) => ({
    key,
    table,
  })) as Groups_;

/**
 * Bind the published contract to an actual installed component reference.
 */
export const bind = <
  Spec_ extends Spec.AnyWithProps,
  From extends IdScope.IdScope,
  Tables extends string,
  Native extends Api<NoInfer<Spec_>>,
  const Parent extends IdScope.IdScope = IdScope.App,
>(
  component: Component<Spec_, From, Tables>,
  native: Native,
  options?: { readonly parentScope: Parent },
): Bound<
  Spec_,
  From,
  MountScope<Parent, Extract<MountName<Native>, string | undefined>>,
  Tables
> => {
  const published = component[TypeId];
  const address = getFunctionAddress(native);
  const installedReference = Result.getOrThrow(
    Result.fromNullishOr(
      address.reference,
      () =>
        new UninstalledComponentReferenceError({
          definitionScope: published.scope,
        }),
    ),
  );
  // Preserve the opaque address as an identity only. Calls retain the native
  // references; no component address is constructed or parsed for routing.
  const scope = IdScope.instance(
    options?.parentScope ?? IdScope.app,
    installedReference,
  );
  const rebase = (schema: Schema.ConstraintCodec<any, any, never, never>) =>
    GenericId.rebase(schema, published.scope, scope);
  const rebaseMiddleware = memoize(
    (middleware: MiddlewareSpec.AnyMiddlewareSpec) => {
      if (!("error" in middleware)) return middleware;
      const boundMiddleware = Object.create(
        middleware,
      ) as MiddlewareSpec.AnyMiddlewareSpec;
      Lazy.defineProperty(boundMiddleware, "error", () => {
        const error = middleware.error;
        return error === undefined ? undefined : rebase(error);
      });
      return boundMiddleware;
    },
  );
  const visit = (tree: Tree, references: unknown): Tree =>
    Record.map(tree, (child, key) => {
      const reference = (references as Record<string, unknown>)[key];
      if (Ref.isRef(child)) {
        const nativeRef = reference as FunctionReference<any, any>;
        return Match.value(child).pipe(
          Match.tag("Convex", (ref) => ({
            ...ref,
            functionReference: nativeRef,
          })),
          Match.tag("Confect", (ref) => {
            const provenance = {
              _tag: "Confect" as const,
              kind: Match.value(ref.kind).pipe(
                Match.tag("Standard", (kind) => kind),
                Match.tag("Paginated", (kind) => {
                  const boundKind = { _tag: "Paginated" as const };
                  Lazy.defineProperty(boundKind, "userArgs", () =>
                    Schema.Struct(Record.map(kind.userArgs.fields, rebase)),
                  );
                  Lazy.defineProperty(boundKind, "item", () =>
                    rebase(kind.item),
                  );
                  Lazy.defineProperty(boundKind, "page", () =>
                    rebase(kind.page),
                  );
                  return boundKind as FunctionProvenance.Paginated;
                }),
                Match.exhaustive,
              ),
            };
            Lazy.defineProperty(provenance, "args", () =>
              Schema.Struct(Record.map(ref.args.fields, rebase)),
            );
            Lazy.defineProperty(provenance, "returns", () =>
              rebase(ref.returns),
            );
            if ("error" in ref) {
              Lazy.defineProperty(provenance, "error", () => {
                const error = ref.error;
                return error === undefined ? undefined : rebase(error);
              });
            }
            return Ref.fromProvenance(
              ref.convexFunctionName,
              provenance as FunctionProvenance.AnyConfect,
              Array.map(ref.middlewareAttachments, (attachment) => ({
                ...attachment,
                spec: rebaseMiddleware(attachment.spec),
              })),
              nativeRef,
              ref.functionType,
              ref.reservedArgument,
            );
          }),
          Match.exhaustive,
        );
      } else {
        return visit(child, reference);
      }
    });
  const refs = visit(published.refs, native);
  Object.defineProperty(refs, BoundTypeId, {
    value: { from: published.scope, scope, tables: published.tables },
  });
  return refs as Bound<
    Spec_,
    From,
    MountScope<Parent, Extract<MountName<Native>, string | undefined>>,
    Tables
  >;
};

/**
 * Reference an installed component's table ID in host schemas.
 */
export const id = <
  From extends IdScope.IdScope,
  To extends IdScope.IdScope,
  Tables extends string,
  const Table extends Tables,
>(
  component: {
    readonly [BoundTypeId]: {
      readonly from: From;
      readonly scope: To;
      readonly tables: ReadonlyArray<Tables>;
    };
  },
  table: Table,
) => GenericId.GenericId(table, component[BoundTypeId].scope);

/**
 * Reuse a component's codec in a host function or table without losing its
 * scope.
 */
export const schema = <
  From extends IdScope.IdScope,
  To extends IdScope.IdScope,
  Schema_ extends Schema.Codec<any, any>,
>(
  component: {
    readonly [BoundTypeId]: { readonly from: From; readonly scope: To };
  },
  codec: Schema_,
) =>
  GenericId.rebase(
    codec,
    component[BoundTypeId].from,
    component[BoundTypeId].scope,
  );

/**
 * A component's `init`: an internal Confect mutation whose args are the install
 * args each mount passes.
 */
export type Init = Ref.AnyConfect & {
  readonly "~RuntimeAndFunctionType": RuntimeAndFunctionType.ConvexMutation;
  readonly "~FunctionVisibility": "internal";
};

export interface DescriptorOptions {
  readonly init?: Init;
  /**
   * The component's `_generated/component` contract. A mount of a descriptor
   * with one rebases a callback slot's args with `callbackArgs`.
   */
  readonly contract?: Component<Spec.AnyWithProps, IdScope.IdScope, string>;
  readonly env?: Readonly<Record<string, Schema.Top>>;
  /**
   * Builds the component's client from its native mount, then the mount's
   * `options` when the client takes any.
   */
  readonly client: (...args: never) => unknown;
}

export type Descriptor<
  Name extends string = string,
  Options extends DescriptorOptions = DescriptorOptions,
> = Options & { readonly name: Name };

/**
 * Describe a Convex component for `Mount.make`, as `defineComponent` does for
 * Convex. A component with `init` takes install `args` at each mount, and one
 * with `env` takes `env`. Export it from the package's `./client` entry.
 *
 * ```ts
 * export default Component.make("email", {
 *   init: refs.internal.install.init,
 *   env: { RESEND_API_KEY: Schema.String },
 *   client: Client.make,
 * });
 * ```
 */
export const make = <
  const Name extends string,
  const Options extends DescriptorOptions,
>(
  name: Name,
  options: Options,
): Descriptor<Name, Options> => ({ ...options, name });
