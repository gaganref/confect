import { httpActionGeneric, httpRouter } from "convex/server";
import { ConvexError, convexToJson } from "convex/values";
import { callFromAction, type Payload, type Target } from "./convexErrors";
import * as TokenReview from "./tokenReview";

// Plain Convex HTTP actions, with no Confect router in front, so the binary's
// own answer to a route that throws shows through.
const http = httpRouter();

http.route({
  path: "/ok",
  method: "GET",
  handler: httpActionGeneric(() => Promise.resolve(new Response("ok"))),
});

http.route({
  path: "/throws",
  method: "GET",
  handler: httpActionGeneric(() =>
    Promise.reject(new Error("The route failed.")),
  ),
});

http.route({
  path: "/throws-convex-error",
  method: "GET",
  handler: httpActionGeneric(() =>
    Promise.reject(new ConvexError({ code: "denied", attempt: 2 })),
  ),
});

http.route({
  path: "/echo",
  method: "OPTIONS",
  handler: httpActionGeneric((_ctx, request) =>
    request
      .arrayBuffer()
      .then((body) => new Response(`received ${body.byteLength}`)),
  ),
});

http.route({
  path: "/headers",
  method: "GET",
  handler: httpActionGeneric((_ctx, request) => {
    const headers = new Headers();
    headers.append("set-cookie", "a=1; Path=/");
    headers.append("set-cookie", "b=2; Path=/");
    headers.append("x-multi", "first");
    headers.append("x-multi", "second");
    return Promise.resolve(
      new Response(request.headers.get("x-dup") ?? "none", { headers }),
    );
  }),
});

// An HTTP action calls a function that throws a ConvexError and answers what
// reached it as Convex JSON. Its calls go through Convex's own action syscalls.
http.route({
  path: "/nested-convex-error",
  method: "GET",
  handler: httpActionGeneric((ctx, request) => {
    const params = new URL(request.url).searchParams;
    return callFromAction(ctx, {
      payload: params.get("payload") as Payload,
      target: params.get("target") as Target,
    }).then((caught) => Response.json(convexToJson(caught)));
  }),
});

// An HTTP action calls a function that reads its identity and answers what it
// saw of the request's token.
http.route({
  path: TokenReview.path,
  method: "GET",
  handler: httpActionGeneric((ctx, request) =>
    TokenReview.reviewFrom(
      ctx,
      new URL(request.url).searchParams.get("hop") as TokenReview.Hop,
    ).then((review) => Response.json(review)),
  ),
});

export default http;
