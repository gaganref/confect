import type { GenericId as ConvexGenericId } from "convex/values";
import * as Array from "effect/Array";
import { memoize } from "effect/Function";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as IdScope from "./IdScope";
import type * as Ref from "./Ref";

const ConvexId = "~@confect/core/ConvexId";
const ConvexIdScope = "~@confect/core/ConvexIdScope";

/**
 * Scoping changes only the TypeScript identity, never the stored string. The
 * qualified table brand prevents a component ID from also being assignable to a
 * vanilla application ID with the same table name.
 */
export type GenericId<
  TableName extends string,
  Scope extends IdScope.IdScope = IdScope.App,
> = Scope extends IdScope.App
  ? ConvexGenericId<TableName>
  : ConvexGenericId<`@confect(${Scope})/${TableName}`> & {
      readonly "~@confect/core/ScopedId": {
        readonly table: TableName;
        readonly scope: Scope;
      };
    };

export const GenericId = <
  TableName extends string,
  const Scope extends IdScope.IdScope = IdScope.App,
>(
  tableName: TableName,
  scope?: Scope,
): Schema.Codec<GenericId<TableName, Scope>> =>
  Schema.String.annotate({
    [ConvexId]: tableName,
    [ConvexIdScope]: scope ?? IdScope.app,
  }) as unknown as Schema.Codec<GenericId<TableName, Scope>>;

export const scope = (ast: SchemaAST.AST): IdScope.IdScope =>
  SchemaAST.resolveAt<IdScope.IdScope>(ConvexIdScope)(ast) ?? IdScope.app;

/**
 * Rebind only IDs owned by `From`; IDs belonging to other scopes survive. A ref
 * (such as a callback handle) names a function, not scoped data, so it passes
 * through unchanged.
 */
export type Rebase<
  A,
  From extends IdScope.IdScope,
  To extends IdScope.IdScope,
> = RebaseValue<A, From, To, true>;

// Compare against a purely structural mapping. Comparing a recursive object
// against its nominal-preserving mapping makes the compatibility check circular.
type RebaseValue<
  A,
  From extends IdScope.IdScope,
  To extends IdScope.IdScope,
  PreserveIdentity extends boolean,
> = A extends { readonly [Ref.TypeId]: Ref.TypeId }
  ? A
  : A extends {
        readonly "~@confect/core/ScopedId": {
          readonly table: infer Table extends string;
          readonly scope: infer Scope extends IdScope.IdScope;
        };
      }
    ? GenericId<Table, IdScope.Rebase<Scope, From, To>>
    : A extends ConvexGenericId<infer Table>
      ? From extends IdScope.App
        ? GenericId<Table, To>
        : A
      : A extends
            | string
            | number
            | boolean
            | bigint
            | symbol
            | null
            | undefined
            | Date
            | URL
            | ArrayBuffer
            | RegExp
            | ((...args: never[]) => unknown)
        ? A
        : A extends Map<infer Key, infer Value>
          ? Map<
              RebaseValue<Key, From, To, PreserveIdentity>,
              RebaseValue<Value, From, To, PreserveIdentity>
            >
          : A extends ReadonlyMap<infer Key, infer Value>
            ? ReadonlyMap<
                RebaseValue<Key, From, To, PreserveIdentity>,
                RebaseValue<Value, From, To, PreserveIdentity>
              >
            : A extends Set<infer Value>
              ? Set<RebaseValue<Value, From, To, PreserveIdentity>>
              : A extends ReadonlySet<infer Value>
                ? ReadonlySet<RebaseValue<Value, From, To, PreserveIdentity>>
                : A extends object
                  ? {
                      [K in keyof A]: RebaseValue<
                        A[K],
                        From,
                        To,
                        PreserveIdentity
                      >;
                    } & (PreserveIdentity extends true
                      ? A extends RebaseValue<A, From, To, false>
                        ? A
                        : unknown
                      : unknown)
                  : A;

/**
 * Preserve Structs and field maps while rebinding their value types. Other
 * specialised schema members are not promised by the resulting codec.
 */
export type RebaseSchema<
  S extends Schema.Constraint,
  From extends IdScope.IdScope,
  To extends IdScope.IdScope,
> =
  S extends Schema.Struct<infer Fields>
    ? Schema.Struct<{ [K in keyof Fields]: RebaseSchema<Fields[K], From, To> }>
    : Schema.Codec<
        Rebase<S["Type"], From, To>,
        Rebase<S["Encoded"], From, To>,
        S["DecodingServices"],
        S["EncodingServices"]
      > &
        Pick<
          S,
          | "~type.optionality"
          | "~encoded.optionality"
          | "~type.mutability"
          | "~encoded.mutability"
          | "~type.constructor.default"
        > & {
          readonly "~type.make.in": Rebase<S["~type.make.in"], From, To>;
          readonly "~type.make": Rebase<S["~type.make"], From, To>;
          readonly Iso: Rebase<S["Iso"], From, To>;
        } & (S extends {
          readonly fields: infer Fields extends Schema.Struct.Fields;
        }
          ? {
              readonly fields: {
                [K in keyof Fields]: RebaseSchema<Fields[K], From, To>;
              };
            }
          : unknown);

/**
 * Scope annotations belong to both sides of a codec. Keep its transformations,
 * checks, optional fields and declaration parsers intact while rebinding IDs.
 */
export const rebase = <
  Schema_ extends Schema.ConstraintCodec<any, any, never, never>,
  const From extends IdScope.IdScope,
  const To extends IdScope.IdScope,
>(
  schema: Schema_,
  from: From,
  to: To,
): RebaseSchema<Schema_, From, To> => {
  const visit = memoize((ast: SchemaAST.AST): SchemaAST.AST => {
    // Suspended schemas must retain a lazy rebinding thunk even before it runs.
    let changed = SchemaAST.isSuspend(ast);
    const child = (input: SchemaAST.AST): SchemaAST.AST => {
      const next = visit(input);
      if (next !== input) changed = true;
      return next;
    };
    const next = Match.value(ast).pipe(
      Match.tag(
        "Objects",
        (objects) =>
          new SchemaAST.Objects(
            Array.map(
              objects.propertySignatures,
              (property) =>
                new SchemaAST.PropertySignature(
                  property.name,
                  child(property.type),
                ),
            ),
            Array.map(
              objects.indexSignatures,
              (index) =>
                new SchemaAST.IndexSignature(
                  child(index.parameter),
                  child(index.type),
                ),
            ),
            objects.annotations,
            objects.checks,
            undefined,
            objects.context,
            objects.encodingChecks,
          ),
      ),
      Match.tag(
        "Arrays",
        (arrays) =>
          new SchemaAST.Arrays(
            arrays.isMutable,
            Array.map(arrays.elements, child),
            Array.map(arrays.rest, child),
            arrays.annotations,
            arrays.checks,
            undefined,
            arrays.context,
            arrays.encodingChecks,
          ),
      ),
      Match.tag(
        "Union",
        (union) =>
          new SchemaAST.Union(
            Array.map(union.types, child),
            union.options,
            union.annotations,
            union.checks,
            undefined,
            union.context,
            union.encodingChecks,
          ),
      ),
      Match.tag(
        "Suspend",
        (suspend) =>
          new SchemaAST.Suspend(
            () => visit(suspend.thunk()),
            suspend.annotations,
            suspend.checks,
            undefined,
            suspend.context,
          ),
      ),
      Match.tag(
        "Declaration",
        (declaration) =>
          new SchemaAST.Declaration(
            Array.map(declaration.typeParameters, child),
            declaration.run,
            declaration.annotations,
            declaration.checks,
            undefined,
            declaration.context,
            declaration.encodingChecks,
            declaration.encodingRun,
          ),
      ),
      Match.tag(
        "Null",
        "Undefined",
        "Void",
        "Never",
        "Unknown",
        "Any",
        "String",
        "Number",
        "Boolean",
        "BigInt",
        "Symbol",
        "Literal",
        "UniqueSymbol",
        "ObjectKeyword",
        "Enum",
        "TemplateLiteral",
        (leaf) => leaf,
      ),
      Match.exhaustive,
    );
    const ownScope = scope(ast);
    const scoped =
      Option.isSome(tableName(ast)) &&
      (ownScope === from || ownScope.startsWith(`${from}/instance:`))
        ? Schema.make<Schema.Codec<unknown>>(next).annotate({
            [ConvexIdScope]: to + ownScope.slice(from.length),
          }).ast
        : next;
    if (ast.encoding === undefined) {
      return changed || scoped !== next ? scoped : ast;
    }
    const encoding = Array.map(ast.encoding, (link) => {
      const target = child(link.to);
      return target === link.to
        ? link
        : new SchemaAST.Link(target, link.transformation);
    });
    if (!changed && scoped === next) return ast;
    // Effect's replaceEncoding helper is internal and omitted from its published
    // declarations. Preserve AST prototypes and descriptors at this boundary;
    // spreading the node itself would lose its class behavior.
    return Object.create(Object.getPrototypeOf(scoped), {
      ...Object.getOwnPropertyDescriptors(scoped),
      encoding: {
        value: encoding,
        enumerable: true,
        configurable: true,
        writable: true,
      },
    }) as SchemaAST.AST;
  });
  const rebuild = memoize((input: Schema.Constraint): Schema.Constraint => {
    const ast = visit(input.ast);
    if (ast === input.ast) return input;
    if ("fields" in input) {
      const fields = (input as { readonly fields: Schema.Struct.Fields })
        .fields;
      const reboundFields = Object.fromEntries(
        Reflect.ownKeys(fields).map((key) => [key, rebuild(fields[key]!)]),
      );
      if (
        ast.encoding === undefined &&
        SchemaAST.isObjects(ast) &&
        "mapFields" in input
      ) {
        return (input as Schema.Struct<Schema.Struct.Fields>)
          .mapFields(() => reboundFields, { unsafePreserveChecks: true })
          .rebuild(ast);
      }
      return Schema.make(ast, { fields: reboundFields });
    }
    return Schema.make(ast);
  });
  return rebuild(schema) as RebaseSchema<Schema_, From, To>;
};

export const tableName = <TableName extends string>(
  ast: SchemaAST.AST,
): Option.Option<TableName> =>
  Option.fromNullishOr(SchemaAST.resolveAt<TableName>(ConvexId)(ast));
