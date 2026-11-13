import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

const answersOptions = HttpRouter.middleware((next) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return request.method === "OPTIONS"
      ? HttpServerResponse.text("POST middleware")
      : yield* next;
  }),
).layer;

/**
 * @internal
 */
export const optionalPrefix = Layer.mergeAll(
  HttpRouter.add("GET", "/prefix/:id", HttpServerResponse.text("GET ran")),
  HttpRouter.addAll(
    [HttpRouter.route("POST", "/", HttpServerResponse.text("POST ran"))],
    { prefix: "/prefix/:slug?" },
  ).pipe(Layer.provide(answersOptions)),
);
