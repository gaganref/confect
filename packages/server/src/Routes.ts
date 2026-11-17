import * as FunctionSpec from "@confect/core/FunctionSpec";
import type * as GroupSpec from "@confect/core/GroupSpec";
import * as MiddlewareSpec from "@confect/core/MiddlewareSpec";
import type { GenericDataModel } from "convex/server";
import * as Array from "effect/Array";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Str from "effect/String";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiError from "effect/http-api/HttpApiError";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpMethod from "effect/http/HttpMethod";
import * as ActionCtx from "./ActionCtx.js";
import type * as DatabaseSchema from "./DatabaseSchema.js";
import * as FunctionRegistryItem from "./FunctionRegistryItem.js";
import type * as GroupImpl from "./GroupImpl.js";
import * as GroupRegistry from "./GroupRegistry.js";
import type * as HttpRouter from "./HttpRouter.js";
import * as RegisteredFunction from "./RegisteredFunction.js";
import * as ResolvedMiddleware from "./ResolvedMiddleware.js";

/**
 * The route spec an endpoint serves, as its annotation, keyed by the function
 * path Convex would give the function (`notes:read`).
 *
 * @stability unstable
 */
export class Route extends Context.Service<
  Route,
  {
    readonly functionPath: string;
    readonly spec: FunctionSpec.AnyHttpAction;
  }
>()("@confect/server/Routes/Route") {}

/**
 * A leaf module's spec and finalized impl, as the generated registration module
 * imports them.
 *
 * @stability unstable
 */
export type Leaf = readonly [
  GroupSpec.AnyWithProps,
  Layer.Layer<GroupImpl.GroupImpl<"Finalized">>,
];

/**
 * A route whose error, or a middleware error that covers it, has no
 * `HttpApiSchema.status`. Effect would answer it 500, which is wrong for a
 * declared error, and no default fits most.
 *
 * @stability unstable
 */
export class RouteErrorWithoutStatus extends Schema.TaggedError<
  RouteErrorWithoutStatus,
  { readonly brand: unique symbol }
>()("RouteErrorWithoutStatus", {
  functionPath: Schema.String,
  error: Schema.String,
}) {
  override get message(): string {
    return `Route "${this.functionPath}" can fail with ${this.error}, which has no HttpApiSchema.status annotation`;
  }
}

/**
 * Whether a defect is Convex refusing a nested call's arguments: the real
 * backend's `ArgumentValidationError: ` message, or convex-test's `Validator
 * error:`. Neither carries a class, name or code.
 *
 * @stability unstable
 */
export const isArgumentValidationFailure = (defect: unknown): boolean =>
  defect instanceof Error &&
  (pipe(defect.message, Str.startsWith("ArgumentValidationError: ")) ||
    pipe(defect.message, Str.startsWith("Validator error:")));

/* oxlint-disable effecttsgo/any-unknown-in-error-context -- A route's errors are erased across the api built at runtime; each endpoint's error schemas type them again at the wire. */

/**
 * Serve each leaf's route specs over HTTP, one `HttpApiGroup` per leaf named by
 * its module path. Each endpoint runs the route's impl through the action
 * middleware chain with an `http` invocation. Path parameters and the query
 * (GET, OPTIONS) or JSON body (other methods) merge into the args, `returns`
 * encodes as a JSON 200, and each error answers its annotated status. A nested
 * call Convex refuses for its arguments answers Effect's empty 400.
 *
 * ```ts
 * export default Routes.make(schema, { notes: [notesSpec, notesImpl] });
 * ```
 *
 * @stability unstable
 */
export const make = <Schema_ extends DatabaseSchema.AnyWithProps>(
  schema: Schema_,
  leaves: { readonly [modulePath: string]: Leaf },
): {
  readonly api: HttpApi.HttpApi<"routes", HttpApiGroup.Top>;
  readonly routes: HttpRouter.Routes<Schema_>;
} => {
  const served = Array.filter(
    Array.map(Record.toEntries(leaves), ([modulePath, [spec, impl]]) =>
      serveLeaf(schema, modulePath, spec, impl),
    ),
    ({ endpoints }) => endpoints.length > 0,
  );
  const api = Array.reduce(
    served,
    HttpApi.make("routes") as unknown as HttpApi.HttpApi<
      "routes",
      HttpApiGroup.Top
    >,
    (built, { group }) => built.add(group) as never,
  );
  const groups = Array.map(served, ({ modulePath, endpoints }) =>
    HttpApiBuilder.group(
      api,
      modulePath as never,
      (builder) =>
        Array.reduce(
          endpoints,
          builder as unknown as Handlers,
          (built, { name, handle }) => built.handle(name, handle),
        ) as never,
    ),
  );
  return {
    api,
    routes: HttpApiBuilder.layer(api).pipe(
      Layer.provide(groups as never),
    ) as never,
  };
};

interface Handlers {
  readonly handle: (
    name: string,
    handler: (request: RouteRequest) => Effect.Effect<unknown, unknown, any>,
  ) => Handlers;
}

interface RouteRequest {
  readonly params?: Readonly<Record<string, unknown>>;
  readonly query?: Readonly<Record<string, unknown>>;
  readonly payload?: Readonly<Record<string, unknown>>;
}

const serveLeaf = (
  databaseSchema: DatabaseSchema.AnyWithProps,
  modulePath: string,
  spec: GroupSpec.AnyWithProps,
  impl: Layer.Layer<GroupImpl.GroupImpl<"Finalized">>,
) => {
  const { functionRegistryItems, middlewareRegistryItems } =
    GroupRegistry.make(impl);
  const endpoints = Array.flatMap(
    Record.values(spec.functions),
    (functionSpec) => {
      const item = functionRegistryItems[functionSpec.name];
      return FunctionSpec.isHttpAction(functionSpec) &&
        FunctionRegistryItem.isFunctionRegistryItem(item) &&
        item._tag === "Confect"
        ? [
            serveRoute(
              databaseSchema,
              `${modulePath}:${functionSpec.name}`,
              functionSpec,
              item,
              ResolvedMiddleware.resolve(item, middlewareRegistryItems),
            ),
          ]
        : [];
    },
  );
  const group = Array.reduce(
    endpoints,
    HttpApiGroup.make(modulePath) as unknown as HttpApiGroup.Top,
    (built, { endpoint }) => built.add(endpoint) as never,
  );
  return { modulePath, group, endpoints };
};

const serveRoute = (
  databaseSchema: DatabaseSchema.AnyWithProps,
  functionPath: string,
  spec: FunctionSpec.AnyHttpAction,
  item: FunctionRegistryItem.ConfectFunctionRegistryItem,
  resolvedMiddlewares: ReadonlyArray<ResolvedMiddleware.ResolvedMiddleware>,
) => {
  const { method, path, params } = spec.route;
  const fields = (item.args as unknown as Schema.Struct<Schema.Struct.Fields>)
    .fields;
  const paramFields = Record.filter(fields, (_, name) => params.includes(name));
  const otherFields = Record.filter(
    fields,
    (_, name) => !params.includes(name),
  );
  const others = Record.isEmptyRecord(otherFields)
    ? undefined
    : Schema.Struct(otherFields);
  const errors = routeErrors(functionPath, item, resolvedMiddlewares);
  const endpoint = HttpApiEndpoint.make(method)(
    spec.name,
    path as never,
    {
      ...(params.length === 0 ? {} : { params: Schema.Struct(paramFields) }),
      ...(others === undefined
        ? {}
        : HttpMethod.hasBody(method)
          ? { payload: others }
          : { query: others }),
      success: item.returns,
      ...(errors.length === 0 ? {} : { error: errors }),
    } as never,
  ).annotate(Route, { functionPath, spec });
  const declared = (error: unknown) =>
    Array.some(errors, (errorSchema) => Schema.is(errorSchema)(error));
  const run = RegisteredFunction.runAction({
    name: functionPath,
    functionVisibility: "http",
    handler: item.handler as (args: unknown) => Effect.Effect<unknown>,
    resolvedMiddlewares,
    createLayer: (ctx) =>
      RegisteredFunction.actionLayer(databaseSchema, ctx as never),
  });
  const handle = (request: RouteRequest) =>
    Effect.flatMap(ActionCtx.ActionCtx<GenericDataModel>(), (ctx) =>
      run(ctx, { ...request.query, ...request.payload, ...request.params }),
    ).pipe(
      Effect.catchCause((cause) => {
        const defect = Option.getOrUndefined(
          Array.findFirst(cause.reasons, Cause.isDieReason),
        )?.defect;
        if (isArgumentValidationFailure(defect)) {
          return Effect.die(
            new HttpApiError.HttpApiSchemaError({
              kind: HttpMethod.hasBody(method) ? "Payload" : "Query",
              cause: new Schema.SchemaError(
                new SchemaIssue.InvalidValue({
                  message: (defect as Error).message,
                }),
              ),
            }),
          );
        }
        const failure = Option.getOrUndefined(
          Array.findFirst(cause.reasons, Cause.isFailReason),
        );
        return failure !== undefined && !declared(failure.error)
          ? Effect.die(failure.error)
          : Effect.failCause(cause);
      }),
    );
  return { name: spec.name, endpoint, handle };
};

/* oxlint-enable effecttsgo/any-unknown-in-error-context */

/**
 * The route's error schemas, one per union member, each with its status.
 */
const routeErrors = (
  functionPath: string,
  item: FunctionRegistryItem.ConfectFunctionRegistryItem,
  resolvedMiddlewares: ReadonlyArray<ResolvedMiddleware.ResolvedMiddleware>,
): ReadonlyArray<Schema.Top> => {
  const errors = Array.flatMap(
    [
      ...(item.error === undefined ? [] : [item.error]),
      ...MiddlewareSpec.errorSchemas(
        Array.map(resolvedMiddlewares, ({ middlewareSpec }) => middlewareSpec),
      ),
    ],
    members,
  );
  for (const error of errors) {
    if (status(error.ast) === undefined) {
      throw RouteErrorWithoutStatus.make({
        functionPath,
        error: errorName(error),
      });
    }
  }
  return errors;
};

const members = (schema: Schema.Top): ReadonlyArray<Schema.Top> =>
  Schema.isSchema(schema) && "members" in schema
    ? Array.flatMap(schema.members as ReadonlyArray<Schema.Top>, members)
    : [schema];

// Effect reads the status as below (`HttpApiSchema.ts` resolveHttpApiStatus),
// but does not export the reader.
const status = (ast: SchemaAST.AST): number | undefined => {
  const annotated = statusAnnotation(ast);
  const value =
    annotated === undefined
      ? ast.context?.annotations?.["httpApiStatus"]
      : annotated["httpApiStatus"];
  return typeof value === "number" ? value : undefined;
};

const statusAnnotation = (
  ast: SchemaAST.AST | SchemaAST.FilterGroup<any>,
): Schema.Annotations.Annotations | undefined => {
  for (const check of Array.reverse(ast.checks ?? [])) {
    if (Predicate.hasProperty(check.annotations, "httpApiStatus")) {
      return check.annotations;
    }
    if (check._tag === "FilterGroup") {
      const nested = statusAnnotation(check);
      if (nested !== undefined) return nested;
    }
  }
  return Predicate.hasProperty(ast.annotations, "httpApiStatus")
    ? ast.annotations
    : undefined;
};

const errorName = (schema: Schema.Top): string => {
  const identifier = schema.ast.annotations?.["identifier"];
  return typeof identifier === "string" ? identifier : String(schema.ast);
};
