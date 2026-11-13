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

export default http;
