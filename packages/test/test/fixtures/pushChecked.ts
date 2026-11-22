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
 * only `http.ts` imports is, and `registerIn: "module"` only as `tasks.ts`
 * loads, as a provider's module scope registers it.
 *
 * `runs.check` counts the check's runs and `runs.route` the route handler's.
 * The router's module keeps the site URL and `ROUTER_MARK` it read while it
 * loaded, and the random value it drew.
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
  readonly registerIn?: "graph" | "router" | "module";
  readonly name?: string;
} = {}) => {
  const schema = DatabaseSchema.make({});
  const runs: {
    check: number;
    route: number;
    read: number;
    siteUrl?: string | undefined;
    routerMark?: string | undefined;
    routerDraw?: number | undefined;
    handlerSiteUrl?: string | undefined;
    handlerSpreadSiteUrl?: string | undefined;
    handlerHasSiteUrl?: boolean | undefined;
    handlerKeysSiteUrl?: boolean | undefined;
  } = {
    check: 0,
    route: 0,
    read: 0,
  };
  const check = PushCheck.make(name, () => {
    runs.check++;
    return refusals;
  });
  if (register && registerIn === "graph") PushCheck.register(schema, check);
  const guard = <F>(fn: F, entry: string): F =>
    guarded ? PushCheck.guardCopy(fn, schema, entry) : fn;
  const functions = {
    read: guard(
      queryGeneric({
        args: {},
        handler: () => {
          runs.read++;
          return "read";
        },
      }),
      "read",
    ),
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
      // Every way a handler reads its site URL, which must agree.
      runs.handlerSiteUrl = process.env.CONVEX_SITE_URL;
      runs.handlerSpreadSiteUrl = { ...process.env }.CONVEX_SITE_URL;
      runs.handlerHasSiteUrl = "CONVEX_SITE_URL" in process.env;
      // oxlint-disable-next-line effecttsgo/prefer-effect-record -- The handler reads the keys the environment's own trap reports.
      runs.handlerKeysSiteUrl = Object.keys(process.env).includes(
        "CONVEX_SITE_URL",
      );
      return Promise.resolve(new Response("hi"));
    }),
  });
  const modules: Record<string, () => Promise<any>> = {
    "_generated/server.ts": () => Promise.resolve({}),
    "tasks.ts": () => {
      if (register && registerIn === "module")
        PushCheck.register(schema, check);
      return Promise.resolve(functions);
    },
    ...(router
      ? {
          // It reads its settings after yielding, as a module whose imports
          // load first does, so a backend building another router meanwhile
          // would show in what it reads.
          "http.ts": () =>
            Promise.resolve()
              .then(() => Promise.resolve())
              .then(() => {
                runs.siteUrl = process.env.CONVEX_SITE_URL;
                runs.routerMark = process.env.ROUTER_MARK;
                // oxlint-disable-next-line effecttsgo/global-random -- The router's module draws while it loads, from the stream its load gives it.
                runs.routerDraw = Math.random();
                if (register && registerIn === "router")
                  PushCheck.register(schema, check);
                return { default: PushCheck.guardRouter(routes, schema) };
              }),
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
