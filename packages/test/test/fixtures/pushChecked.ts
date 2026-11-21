import * as DatabaseSchema from "@confect/server/DatabaseSchema";
import * as PushCheck from "@confect/server/PushCheck";
import {
  defineSchema,
  httpActionGeneric,
  httpRouter,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
} from "convex/server";

declare const process: { env: Record<string, string | undefined> };

/**
 * One evaluated module graph of a target that registers a push check under its
 * own database schema, as its generated `_generated/schema` module makes it. It
 * has a query and a mutation, guarded as the library's group builders guard
 * them unless `guarded` is false, and, unless `router` is false, a router
 * guarded as `HttpRouter.make` guards it. `registerIn: "router"` registers the
 * check only as the router's module loads, as a check registered from a module
 * only `http.ts` imports is.
 *
 * `runs.check` counts the check's runs, `runs.route` the route handler's, and
 * `runs.siteUrl` holds the site URL the router's module loaded under.
 */
export const pushChecked = ({
  refusals = [],
  register = true,
  router = true,
  guarded = true,
  registerIn = "graph",
  name = "authz",
}: {
  readonly refusals?: ReadonlyArray<string>;
  readonly register?: boolean;
  readonly router?: boolean;
  readonly guarded?: boolean;
  readonly registerIn?: "graph" | "router";
  readonly name?: string;
} = {}) => {
  const schema = DatabaseSchema.make({});
  const runs: { check: number; route: number; siteUrl?: string | undefined } = {
    check: 0,
    route: 0,
  };
  const check = PushCheck.make(name, () => {
    runs.check++;
    return refusals;
  });
  if (register && registerIn === "graph") PushCheck.register(schema, check);
  const guard = <F>(fn: F, entry: string): F =>
    guarded ? PushCheck.guardCopy(fn, schema, entry) : fn;
  const functions = {
    read: guard(queryGeneric({ args: {}, handler: () => "read" }), "read"),
    write: guard(
      mutationGeneric({ args: {}, handler: () => "written" }),
      "write",
    ),
  };
  const routes = httpRouter();
  routes.route({
    path: "/hello",
    method: "GET",
    handler: httpActionGeneric(() => {
      runs.route++;
      return Promise.resolve(new Response("hi"));
    }),
  });
  const modules: Record<string, () => Promise<any>> = {
    "_generated/server.ts": () => Promise.resolve({}),
    "tasks.ts": () => Promise.resolve(functions),
    ...(router
      ? {
          "http.ts": () => {
            runs.siteUrl = process.env.CONVEX_SITE_URL;
            if (register && registerIn === "router")
              PushCheck.register(schema, check);
            return Promise.resolve({
              default: PushCheck.guardRouter(routes, schema),
            });
          },
        }
      : {}),
  };
  return { schema, convexSchema: defineSchema({}), modules, runs };
};

export const pushCheckedRefs = {
  read: makeFunctionReference<"query", {}, string>("tasks:read"),
  write: makeFunctionReference<"mutation", {}, string>("tasks:write"),
};

export const pushCheckRefusal =
  "two permissions are named tasks.read: give each its own name";
