import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/* oxlint-disable effecttsgo/any-unknown-in-error-context -- Preserve the router's erased request errors at the routing boundary. */

type Route = Parameters<HttpRouter.HttpRouter["addAll"]>[0][number];

export const withOptions = <A, E, R>(routes: Layer.Layer<A, E, R>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      const registered: Array<{
        readonly route: Route;
        readonly prefix: string;
        readonly context: Context.Context<never>;
      }> = [];
      const wrap = (
        target: HttpRouter.HttpRouter,
        prefix: string,
      ): HttpRouter.HttpRouter => {
        const addAll: HttpRouter.HttpRouter["addAll"] = (entries) =>
          Effect.contextWith((context: Context.Context<never>) => {
            for (const route of entries)
              registered.push({ route, prefix, context });
            return target.addAll(entries);
          });
        return HttpRouter.HttpRouter.of({
          ...target,
          addAll,
          add: (method, path, handler, options) =>
            addAll([HttpRouter.route(method, path, handler, options)]),
          prefixed: (next) =>
            wrap(target.prefixed(next), `${prefix}${next.replace(/\/$/, "")}`),
        });
      };
      const register = Effect.gen(function* () {
        const paths = new Map<string, typeof registered>();
        for (const entry of registered) {
          const path = `${entry.prefix}${entry.route.path}`;
          const entries = paths.get(path) ?? [];
          entries.push(entry);
          paths.set(path, entries);
        }
        for (const [path, entries] of paths) {
          if (
            entries.some(
              ({ route }) => route.method === "OPTIONS" || route.method === "*",
            )
          )
            continue;
          const candidates = new Map<
            string,
            ReturnType<HttpRouter.HttpRouter["asHttpEffect"]>
          >();
          for (const { route, prefix, context } of entries) {
            const candidate = yield* HttpRouter.make;
            const target =
              prefix === "" ? candidate : candidate.prefixed(prefix);
            // Route registration erases request requirements, as in Effect's router.
            yield* Effect.provideContext(
              target.addAll([{ ...route, method: "OPTIONS" }]),
              context,
            );
            candidates.set(route.method, candidate.asHttpEffect());
          }
          yield* router.add(
            "OPTIONS",
            path as HttpRouter.PathInput,
            Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
              const method = request.headers["access-control-request-method"];
              const candidate =
                method === undefined
                  ? candidates.values().next().value
                  : candidates.get(method);
              return (
                candidate ??
                Effect.succeed(HttpServerResponse.empty({ status: 404 }))
              );
            }),
          );
        }
      });
      return Layer.effectDiscard(register).pipe(
        Layer.provideMerge(
          routes.pipe(
            Layer.provide(
              Layer.succeed(HttpRouter.HttpRouter, wrap(router, "")),
            ),
          ),
        ),
      );
    }),
  );
