import { HttpRouter as ConfectHttpRouter } from "@confect/server";
import { httpActionGeneric } from "convex/server";
import { ConvexError } from "convex/values";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import type * as HttpMiddleware from "effect/http/HttpMiddleware";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiScalar from "effect/http-api/HttpApiScalar";
import refs from "./_generated/refs";
import * as SignedEnvelope from "../../../signedEnvelope";
import { MutationRunner, QueryRunner } from "./_generated/services";
import notes from "./_generated/tables/notes";
import databaseSchema from "./_generated/schema";

class NotesGroup extends HttpApiGroup.make("notes").add(
  HttpApiEndpoint.get("listNotes", "/notes", {
    success: Schema.Array(notes.Doc),
  }),
) {}

/**
 * @internal
 */
export class NotesApi extends HttpApi.make("NotesApi")
  .add(NotesGroup)
  .prefix("/api") {}

const NotesApiLive = HttpApiBuilder.group(NotesApi, "notes", (handlers) =>
  handlers.handle("listNotes", () =>
    Effect.gen(function* () {
      const { runQuery } = yield* QueryRunner;

      return yield* runQuery(refs.public.databaseReader.listNotes, {});
    }).pipe(Effect.orDie),
  ),
);

class MetaGroup extends HttpApiGroup.make("meta").add(
  HttpApiEndpoint.get("ping", "/ping", { success: Schema.String }),
) {}

class MetaApi extends HttpApi.make("MetaApi").add(MetaGroup).prefix("/meta") {}

const MetaApiLive = HttpApiBuilder.group(MetaApi, "meta", (handlers) =>
  handlers.handle("ping", () => Effect.succeed("pong")),
);

class ActionsApi extends HttpApi.make("ActionsApi").add(
  HttpApiGroup.make("actions").add(
    HttpApiEndpoint.post("cancel", "/actions/:id:cancel", {
      params: Schema.Struct({ id: Schema.String }),
      success: Schema.String,
    }),
    HttpApiEndpoint.post("archive", "/actions/:id:archive", {
      params: Schema.Struct({ id: Schema.String }),
      success: Schema.String,
    }),
    HttpApiEndpoint.post("literal", "/literal/:status", {
      params: Schema.Struct({}),
      success: Schema.String,
    }),
  ),
) {}

const ActionsLive = HttpApiBuilder.group(ActionsApi, "actions", (handlers) =>
  handlers
    .handle("cancel", ({ params }) => Effect.succeed(`cancelled ${params.id}`))
    .handle("archive", ({ params }) => Effect.succeed(`archived ${params.id}`))
    .handle("literal", () => Effect.succeed("literal colon")),
);

const withTestHeader: HttpMiddleware.HttpMiddleware = (httpApp) =>
  Effect.map(httpApp, (response) =>
    HttpServerResponse.setHeader(response, "x-confect-middleware", "applied"),
  );

// The route-local signed ingress rule of `../../../signedEnvelope.ts`: a
// refused envelope gets its declared refusal before anything is written.
const ingress = HttpRouter.add(
  "POST",
  SignedEnvelope.path,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const arrayBuffer2 = yield* request.arrayBuffer;
    const body = new Uint8Array(arrayBuffer2);
    const verdict = yield* Effect.promise(() =>
      SignedEnvelope.verify((name) => request.headers[name], body),
    );
    if (verdict.kind === "refused") {
      return HttpServerResponse.text(verdict.refusal.body, {
        status: verdict.refusal.status,
      });
    }
    const { runMutation } = yield* MutationRunner;
    yield* runMutation(refs.public.groups.notes.insert, {
      text: `${verdict.event}:${verdict.id}`,
    });
    return HttpServerResponse.text(`accepted ${verdict.event} ${verdict.id}`);
  }).pipe(Effect.orDie),
);

const http = ConfectHttpRouter.make(
  databaseSchema,
  Layer.mergeAll(
    HttpApiBuilder.layer(NotesApi).pipe(Layer.provide(NotesApiLive)),
    HttpApiBuilder.layer(MetaApi).pipe(Layer.provide(MetaApiLive)),
    HttpApiBuilder.layer(ActionsApi).pipe(Layer.provide(ActionsLive)),
    HttpApiScalar.layer(NotesApi, { path: "/api/docs" }),
    HttpRouter.add("GET", "/health", HttpServerResponse.text("OK")),
    ingress,
    HttpRouter.add(
      "GET",
      "/logging",
      Effect.logWarning("HTTP request").pipe(
        Effect.as(HttpServerResponse.text("logged")),
      ),
    ),
    HttpRouter.add(
      "GET",
      "/logging/disabled",
      Effect.logWarning("hidden").pipe(
        Effect.provideService(Logger.CurrentLoggers, new Set()),
        Effect.as(HttpServerResponse.text("silent")),
      ),
    ),
    HttpRouter.middleware(withTestHeader, { global: true }),
  ),
  { api: NotesApi.addHttpApi(ActionsApi) },
);

// A plain Convex route on the same router: Convex matches exact paths before
// the catch-all path prefix, so this bypasses the Effect router entirely.
http.route({
  path: "/convex-native",
  method: "GET",
  handler: httpActionGeneric(() =>
    Promise.resolve(new Response("native", { status: 200 })),
  ),
});

// Plain Convex routes that throw, so the backend's own answer to an uncaught
// handler error shows through instead of the Effect router's.
http.route({
  path: "/convex-native/throws",
  method: "GET",
  handler: httpActionGeneric(() =>
    Promise.reject(new Error("The route failed.")),
  ),
});
http.route({
  path: "/convex-native/throws-convex-error",
  method: "GET",
  handler: httpActionGeneric(() =>
    Promise.reject(new ConvexError({ code: "denied", attempt: 2 })),
  ),
});

export default http;
