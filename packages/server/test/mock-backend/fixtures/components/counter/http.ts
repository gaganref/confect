import {
  HttpRouter as ConfectHttpRouter,
  MutationRunner,
} from "@confect/server";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import schema from "../../../../../../cli/test/fixtures/authored-component/confect/_generated/schema";
import refs from "../../../../../../cli/test/fixtures/authored-component/confect/_generated/refs";

export const makeHttp = () =>
  ConfectHttpRouter.forSchema(schema)(
    Layer.unwrap(
      Effect.gen(function* () {
        const siteUrl = yield* Config.schema(Schema.String, "CONVEX_SITE_URL");
        return Layer.mergeAll(
          HttpRouter.add("GET", "/ping", HttpServerResponse.json({ siteUrl })),
          HttpRouter.add(
            "GET",
            "/",
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              return yield* HttpServerResponse.json({
                siteUrl,
                url: request.url,
                originalUrl: request.originalUrl,
                header: request.headers["x-test"],
              });
            }),
          ),
          HttpRouter.add(
            "POST",
            "/record",
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              const mutation = yield* MutationRunner.MutationRunner;
              const count = Number(yield* request.text);
              yield* mutation.runMutation(refs.public.counter.create, {
                count,
              });
              return HttpServerResponse.empty({ status: 204 });
            }),
          ),
        );
      }).pipe(Effect.orDie),
    ),
  );
