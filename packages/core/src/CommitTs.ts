import { CommitTsPlaceholder } from "convex/values";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";

const ConvexCommitTs = "~@confect/core/ConvexCommitTs";

/**
 * A commit timestamp as Convex types it. A mutation writes the database
 * writer's `vars.commitTs` placeholder, which resolves to an int64 when the
 * mutation commits. Reading the field back inside that mutation still yields
 * the placeholder, so a reader narrows with `typeof value === "bigint"` before
 * using it as a number.
 */
export type CommitTs = bigint | CommitTsPlaceholder;

/**
 * A field Convex stores as `v.commitTs()`. An index on it orders documents by
 * commit order.
 */
export const CommitTs: Schema.Codec<CommitTs> = Schema.Union([
  Schema.BigInt,
  Schema.instanceOf(CommitTsPlaceholder),
]).annotate({ [ConvexCommitTs]: true });

export const isCommitTs = (ast: SchemaAST.AST): boolean =>
  SchemaAST.resolveAt<boolean>(ConvexCommitTs)(ast) === true;
