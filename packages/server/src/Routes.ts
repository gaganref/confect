import * as FunctionSpec from "@confect/core/FunctionSpec";
import type * as GroupSpec from "@confect/core/GroupSpec";
import * as MiddlewareSpec from "@confect/core/MiddlewareSpec";
import type { GenericActionCtx, GenericDataModel } from "convex/server";
import * as Array from "effect/Array";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as SchemaIssue from "effect/SchemaIssue";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiError from "effect/http-api/HttpApiError";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpMethod from "effect/http/HttpMethod";
import * as EffectHttpRouter from "effect/http/HttpRouter";
import * as ActionCtx from "./ActionCtx.js";
import * as ArgumentRefusal from "./internal/argumentRefusal.js";
import * as SecretSides from "./internal/secretSides.js";
import * as SecretSchema from "@confect/core/SecretSchema";
import type * as DatabaseSchema from "./DatabaseSchema.js";
import * as FunctionRegistryItem from "./FunctionRegistryItem.js";
import type * as GroupImpl from "./GroupImpl.js";
import * as GroupRegistry from "./GroupRegistry.js";
import type * as HttpRouter from "./HttpRouter.js";
import * as RegisteredFunction from "./RegisteredFunction.js";
import * as ResolvedMiddleware from "./ResolvedMiddleware.js";
import { identities, type RouteIdentity } from "./internal/routeIdentity.js";

/**
 * The route spec an endpoint serves, as its annotation, keyed by the function
 * path Convex would give the function (`notes:read`).
 *
 * @stability unstable
 */
export class Route extends Context.Service<Route, RouteIdentity>()(
  "@confect/server/Routes/Route",
) {}

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
 * A route whose path parameters, query, body or response holds a secret, a
 * `Schema.Redacted` that `Schema.RedactedFromValue` decodes to. Effect's HTTP
 * layer decodes and encodes a route's request and response itself and reports a
 * failure's cause, which holds the value, to an `ErrorReporter` and the logs,
 * so a route takes no secret. A secret goes through a function, which Confect
 * checks in Convex's place.
 *
 * @stability unstable
 */
export class RouteHoldsSecret extends Schema.TaggedError<
  RouteHoldsSecret,
  { readonly brand: unique symbol }
>()("RouteHoldsSecret", {
  functionPath: Schema.String,
  slot: Schema.Literals(["params", "query", "payload", "returns"]),
}) {
  override get message(): string {
    return `Route "${this.functionPath}" holds a secret in its ${this.slot}. Effect's HTTP layer reports a route's refused request and response with their values, so a route takes no secret: send it through a function instead.`;
  }
}

/**
 * A route's nested `runQuery`, `runMutation` or `runAction` that Convex refused
 * for its arguments, raised as a defect with Convex's message. It answers
 * Effect's empty 400. Only the nested-call boundary makes one.
 *
 * @stability unstable
 */
export interface ArgumentValidationFailure extends Error {
  readonly _tag: "ArgumentValidationFailure";
}

/**
 * The markers a route request's nested calls raised. Each request makes its own
 * and drops it when it ends. Identity is membership, not shape or prototype, so
 * neither a copy, nor the constructor of a marker product code caught, nor a
 * marker kept from another request makes a marker.
 */
type Refused = WeakSet<object>;

const CurrentRefused = Context.Reference<Refused | undefined>(
  "@confect/server/Routes/CurrentRefused",
  { defaultValue: () => undefined },
);

const argumentValidationFailure = (
  refused: Refused,
  message: string,
): ArgumentValidationFailure => {
  const failure = Object.assign(new Error(message), {
    _tag: "ArgumentValidationFailure" as const,
    name: "ArgumentValidationFailure",
  });
  refused.add(failure);
  return failure;
};

const refusedBy = (
  refused: Refused | undefined,
  defect: unknown,
): defect is ArgumentValidationFailure =>
  refused !== undefined && Predicate.isObject(defect) && refused.has(defect);

/**
 * Whether a defect is a nested call of the current route request that Convex
 * refused for its arguments. Only that request's nested-call boundary makes
 * one, so a product error never matches, whatever its message or shape, and
 * neither does a marker another request raised. Outside a route request it is
 * `false`.
 *
 * @stability unstable
 */
export const isArgumentValidationFailure = (
  defect: unknown,
): Effect.Effect<boolean> =>
  Effect.map(Effect.service(CurrentRefused), (refused) =>
    refusedBy(refused, defect),
  );

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
  readonly api: HttpApi.HttpApi<"routes", any>;
  readonly routes: HttpRouter.Routes<Schema_>;
} => {
  // Built on first read, so assembling the routes evaluates no schema.
  let built: ReturnType<typeof serve> | undefined;
  const served = () => (built ??= serve(schema, leaves));
  return {
    get api() {
      return served().api;
    },
    routes: Layer.suspend(() => served().routes) as never,
  };
};

const serve = (
  schema: DatabaseSchema.AnyWithProps,
  leaves: { readonly [modulePath: string]: Leaf },
) => {
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
  const byKey = new Map(
    Array.flatMap(served, ({ endpoints }) =>
      Array.map(endpoints, ({ key, identity }) => [key, identity] as const),
    ),
  );
  return {
    api,
    routes: HttpApiBuilder.layer(api).pipe(
      Layer.provide(groups as never),
      Layer.provide(identify(byKey)),
    ),
  };
};

// Tags each registration with the route it serves, so the router knows a
// route spec by its registration alone.
const identify = (byKey: ReadonlyMap<string, RouteIdentity>) =>
  Layer.effect(
    EffectHttpRouter.HttpRouter,
    Effect.map(EffectHttpRouter.HttpRouter, (router) =>
      EffectHttpRouter.HttpRouter.of({
        ...router,
        addAll: (entries) => {
          for (const entry of entries) {
            const identity = byKey.get(`${entry.method} ${entry.path}`);
            if (identity !== undefined) identities.set(entry, identity);
          }
          return router.addAll(entries);
        },
      }),
    ),
  );

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
  const slots = [
    ["params", Schema.Struct(paramFields)],
    [
      HttpMethod.hasBody(method) ? "payload" : "query",
      Schema.Struct(otherFields),
    ],
    ["returns", item.returns],
  ] as const;
  const secret = Array.findFirst(slots, ([, schema]) =>
    SecretSchema.hasSecret(schema.ast),
  );
  if (secret._tag === "Some")
    throw RouteHoldsSecret.make({ functionPath, slot: secret.value[0] });
  const errors = routeErrors(functionPath, item, resolvedMiddlewares);
  const identity: RouteIdentity = { functionPath, spec };
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
  ).annotate(Route, identity);
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
  // A nested call's refusal of this request answers 400, and an undeclared
  // failure dies, so it answers 500.
  const translate = (refused: Refused, cause: Cause.Cause<unknown>) => {
    const defect = Option.getOrUndefined(
      Array.findFirst(cause.reasons, Cause.isDieReason),
    )?.defect;
    if (refusedBy(refused, defect)) {
      return Effect.die(
        new HttpApiError.HttpApiSchemaError({
          kind: HttpMethod.hasBody(method) ? "Payload" : "Query",
          cause: new Schema.SchemaError(
            new SchemaIssue.InvalidValue({ message: defect.message }),
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
  };
  const handle = (request: RouteRequest) =>
    Effect.suspend(() => {
      const refused: Refused = new WeakSet();
      return Effect.flatMap(ActionCtx.ActionCtx<GenericDataModel>(), (ctx) =>
        run(refusingNestedCalls(ctx, refused), {
          ...request.query,
          ...request.payload,
          ...request.params,
        }),
      ).pipe(
        Effect.provideService(CurrentRefused, refused),
        Effect.catchCause((cause) => translate(refused, cause)),
      );
    });
  return {
    name: spec.name,
    endpoint,
    handle,
    key: `${method} ${path}`,
    identity,
  };
};

/* oxlint-enable effecttsgo/any-unknown-in-error-context */

/**
 * The route's ctx, whose nested calls reject an argument refusal as an
 * `ArgumentValidationFailure` of the request's own. Convex reports its own
 * refusal only by its message, so it is read here, where the error can only
 * have come from Convex. Confect's refusal of arguments that hold a secret,
 * which it checks in Convex's place, is recognised by its `ConvexError` data.
 */
const refusingNestedCalls = (
  ctx: GenericActionCtx<GenericDataModel>,
  refused: Refused,
): GenericActionCtx<GenericDataModel> => {
  const refusing =
    <Args extends ReadonlyArray<unknown>, A>(
      call: (...args: Args) => Promise<A>,
    ) =>
    (...args: Args): Promise<A> =>
      call(...args).catch((error: unknown) => {
        throw ArgumentRefusal.isRefusal(error) ||
          SecretSides.isArgumentRefusal(error)
          ? argumentValidationFailure(refused, error.message)
          : error;
      });
  return {
    ...ctx,
    runQuery: refusing(ctx.runQuery.bind(ctx)) as typeof ctx.runQuery,
    runMutation: refusing(ctx.runMutation.bind(ctx)) as typeof ctx.runMutation,
    runAction: refusing(ctx.runAction.bind(ctx)) as typeof ctx.runAction,
  };
};

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

// A `Schema.Never` member can never occur, so like an absent error it needs no
// status and declares nothing.
const members = (schema: Schema.Top): ReadonlyArray<Schema.Top> =>
  SchemaAST.isNever(schema.ast)
    ? []
    : Schema.isSchema(schema) && "members" in schema
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
