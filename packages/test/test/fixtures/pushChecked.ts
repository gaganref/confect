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

/**
 * One evaluated module graph of a target that registers a push check under its
 * own database schema, as its generated `_generated/schema` module makes it: a
 * query and a mutation guarded as the library's group builders guard them, and,
 * unless `router` is false, a router guarded as `HttpRouter.make` guards it.
 * `runs.check` counts the check's runs, and `runs.route` the route handler's.
 */
export const pushChecked = ({
  refusals = [],
  register = true,
  router = true,
  name = "authz",
}: {
  readonly refusals?: ReadonlyArray<string>;
  readonly register?: boolean;
  readonly router?: boolean;
  readonly name?: string;
} = {}) => {
  const schema = DatabaseSchema.make({});
  const runs = { check: 0, route: 0 };
  if (register)
    PushCheck.register(
      schema,
      PushCheck.make(name, () => {
        runs.check++;
        return refusals;
      }),
    );
  const functions = {
    read: PushCheck.guardCopy(
      queryGeneric({ args: {}, handler: () => "read" }),
      schema,
      "read",
    ),
    write: PushCheck.guardCopy(
      mutationGeneric({ args: {}, handler: () => "written" }),
      schema,
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
          "http.ts": () =>
            Promise.resolve({
              default: PushCheck.guardRouter(routes, schema),
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
