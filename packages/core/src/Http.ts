import * as Data from "effect/Data";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import type * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import type * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiScalar from "effect/http-api/HttpApiScalar";
import * as App from "./App";

const TypeId = "~@confect/core/Http";

/**
 * A backend's HTTP declaration: the app's own `HttpApi`, its handlers, and an
 * optional Scalar docs path. `routes` is the layer the generated
 * `convex/http.ts` serves. Mounted components serve their own routes.
 *
 * It does not reference `confect/app.ts`: `http.ts` runs in every HTTP action,
 * and `app.ts` imports component definitions that only load in Convex's config
 * analysis. Codegen checks these routes against the app's mounts.
 */
export interface Http<Api extends App.Api, Routes extends Layer.Any> {
  readonly [TypeId]: typeof TypeId;
  readonly api: Api;
  readonly docs: `/${string}` | undefined;
  readonly routes: Routes;
}

export type Any = Http<App.Api, Layer.Any>;

/**
 * Declare the backend's HTTP API, in `confect/http.ts`. Every route is an
 * `HttpApi` endpoint. `docs` serves a Scalar page for the api at that path.
 *
 * ```ts
 * export default Http.make({
 *   api: TenantApi,
 *   handlers: TenantHandlers,
 *   docs: "/docs",
 * });
 * ```
 */
export const make = <
  Id extends string,
  Groups extends HttpApiGroup.Constraint,
  R,
>(options: {
  readonly api: HttpApi.HttpApi<Id, Groups>;
  readonly handlers: Layer.Layer<HttpApiGroup.ToService<Id, Groups>, never, R>;
  readonly docs?: `/${string}`;
}) => {
  const api = HttpApiBuilder.layer(options.api).pipe(
    Layer.provide(options.handlers),
  );
  const routes =
    options.docs === undefined
      ? api
      : Layer.merge(
          api,
          HttpApiScalar.layerCdn(options.api, { path: options.docs }),
        );
  const http: Http<HttpApi.HttpApi<Id, Groups>, typeof routes> = {
    [TypeId]: TypeId,
    api: options.api,
    docs: options.docs,
    routes,
  };
  return http;
};

export const isHttp = (u: unknown): u is Any =>
  Predicate.hasProperty(u, TypeId) && u[TypeId] === TypeId;

export type Owner =
  | { readonly kind: "app" }
  | { readonly kind: "docs" }
  | { readonly kind: "mount"; readonly mount: string };

export interface Route {
  readonly method: string;
  readonly path: string;
  readonly owner: Owner;
}

export class RouteUnderMountPrefix extends Data.TaggedError(
  "RouteUnderMountPrefix",
)<{
  readonly method: string;
  readonly path: string;
  readonly mount: string;
  readonly httpPrefix: string;
}> {
  override get message(): string {
    return `The app route ${this.method} ${this.path} is under the HTTP prefix ${this.httpPrefix} of the mount "${this.mount}". Convex would let it shadow the component's routes; move it or change the prefix.`;
  }
}

export class DuplicateRoute extends Data.TaggedError("DuplicateRoute")<{
  readonly method: string;
  readonly path: string;
  readonly first: Owner;
  readonly second: Owner;
}> {
  override get message(): string {
    return `${this.method} ${this.path} is declared twice (${ownerLabel(this.first)} and ${ownerLabel(this.second)}).`;
  }
}

export class OverlappingMountPrefixes extends Data.TaggedError(
  "OverlappingMountPrefixes",
)<{
  readonly first: { readonly mount: string; readonly httpPrefix: string };
  readonly second: { readonly mount: string; readonly httpPrefix: string };
}> {
  override get message(): string {
    return `The mounts "${this.first.mount}" (${this.first.httpPrefix}) and "${this.second.mount}" (${this.second.httpPrefix}) have overlapping HTTP prefixes.`;
  }
}

export type RouteError =
  | RouteUnderMountPrefix
  | DuplicateRoute
  | OverlappingMountPrefixes;

const ownerLabel = (owner: Owner): string =>
  owner.kind === "mount" ? `mount "${owner.mount}"` : owner.kind;

const trimSlash = (prefix: string): string =>
  prefix.length > 1 && prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;

const isUnder = (path: string, prefix: string): boolean =>
  prefix === "/" ||
  path === prefix ||
  path === `${prefix}/` ||
  path.startsWith(`${prefix}/`);

/**
 * The parameter names an endpoint declares. As in Effect's router, a colon
 * segment is a parameter only when its name is declared; otherwise it is
 * literal text.
 */
const paramNames = (params: Schema.Top | undefined): ReadonlySet<string> => {
  if (params === undefined) return new Set();
  let ast = params.ast;
  while (ast.encoding !== undefined) {
    ast = ast.encoding[ast.encoding.length - 1].to;
  }
  return SchemaAST.isObjects(ast)
    ? new Set(ast.propertySignatures.map(({ name }) => String(name)))
    : new Set();
};

interface KeyedRoute {
  readonly route: Route;
  /**
   * Method and path with declared parameter names erased.
   */
  readonly key: string;
}

const apiRoutes = (
  api: App.Api,
  prefix: string,
  owner: Owner,
): ReadonlyArray<KeyedRoute> =>
  Object.values<HttpApiGroup.Top>(api.groups).flatMap((group) =>
    Object.values(group.endpoints).map((endpoint) => {
      const path = prefix + endpoint.path;
      const declared = paramNames(endpoint.params);
      return {
        route: { method: endpoint.method, path, owner },
        key: `${endpoint.method} ${path.replaceAll(/:(\w+)/g, (param, name: string) => (declared.has(name) ? ":" : param))}`,
      };
    }),
  );

/**
 * Every HTTP route the backend serves: the app's api, its docs page and each
 * mount's api under its prefix. Fails when an app route or the docs page is at
 * or under a mount's prefix (Convex accepts that and lets the app route
 * silently shadow the component's), when two routes share a method and path, or
 * when two mount prefixes overlap.
 */
export const routes = (
  app: App.Any,
  http?: Any,
): Result.Result<ReadonlyArray<Route>, RouteError> => {
  const mounts = App.mounts(app).flatMap(({ name, httpPrefix, api }) =>
    httpPrefix === undefined
      ? []
      : [{ name, httpPrefix: trimSlash(httpPrefix), api }],
  );

  for (const [index, first] of mounts.entries()) {
    for (const second of mounts.slice(index + 1)) {
      if (
        isUnder(second.httpPrefix, first.httpPrefix) ||
        isUnder(first.httpPrefix, second.httpPrefix)
      ) {
        return Result.fail(
          new OverlappingMountPrefixes({
            first: { mount: first.name, httpPrefix: first.httpPrefix },
            second: { mount: second.name, httpPrefix: second.httpPrefix },
          }),
        );
      }
    }
  }

  const own: ReadonlyArray<KeyedRoute> =
    http === undefined
      ? []
      : [
          ...apiRoutes(http.api, "", { kind: "app" }),
          ...(http.docs === undefined
            ? []
            : [
                {
                  route: {
                    method: "GET",
                    path: http.docs,
                    owner: { kind: "docs" } as const,
                  },
                  key: `GET ${http.docs}`,
                },
              ]),
        ];

  for (const { route } of own) {
    const mount = mounts.find(({ httpPrefix }) =>
      isUnder(route.path, httpPrefix),
    );
    if (mount !== undefined) {
      return Result.fail(
        new RouteUnderMountPrefix({
          method: route.method,
          path: route.path,
          mount: mount.name,
          httpPrefix: mount.httpPrefix,
        }),
      );
    }
  }

  const all = [
    ...own,
    ...mounts.flatMap(({ name, httpPrefix, api }) =>
      api === undefined
        ? []
        : apiRoutes(api, httpPrefix, { kind: "mount", mount: name }),
    ),
  ];
  const seen = new Map<string, Route>();
  for (const { route, key } of all) {
    const previous = seen.get(key);
    if (previous !== undefined) {
      return Result.fail(
        new DuplicateRoute({
          method: route.method,
          path: route.path,
          first: previous.owner,
          second: route.owner,
        }),
      );
    }
    seen.set(key, route);
  }
  return Result.succeed(all.map(({ route }) => route));
};
