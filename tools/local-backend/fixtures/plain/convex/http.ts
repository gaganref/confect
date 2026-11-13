import { httpActionGeneric, httpRouter } from "convex/server";
import { ConvexError } from "convex/values";

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

export default http;
