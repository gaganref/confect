import { Http } from "@confect/core";
import * as Auth from "@confect/server/Auth";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import { classProbeHandler } from "../components/counter/confect/authoringHandler";
import { optionalPrefix } from "../components/counter/confect/optionalPrefix";
import { first } from "./componentBindings";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as SignedEnvelope from "../../../signedEnvelope";
import refs from "./_generated/refs";
import {
  ExecutionMetadata,
  MutationRunner,
  RequestMetadata,
} from "./_generated/services";

const HostApi = HttpApi.make("host")
  .add(
    HttpApiGroup.make("auth").add(
      HttpApiEndpoint.get("identity", "/identity", { success: Schema.Unknown }),
    ),
  )
  .add(
    HttpApiGroup.make("componentAuthoring").add(
      HttpApiEndpoint.get("classProbe", "/component-class-probe/:value", {
        params: Schema.Struct({ value: Schema.String }),
        success: Schema.String.pipe(HttpApiSchema.asText()),
      }),
    ),
  )
  .add(
    HttpApiGroup.make("users").add(
      HttpApiEndpoint.get("get", "/users/:id", {
        params: Schema.Struct({ id: Schema.String }),
        success: Schema.String,
      }),
    ),
  )
  .add(
    HttpApiGroup.make("metadata").add(
      HttpApiEndpoint.get("contextMetadata", "/context-metadata", {
        success: Schema.Struct({
          functionName: Schema.String,
          deploymentName: Schema.String,
          requestId: Schema.String,
        }),
      }),
    ),
  );

const users = HttpApiBuilder.group(HostApi, "users", (handle) =>
  handle.handle("get", ({ params }) => Effect.succeed(params.id)),
);

const auth = HttpApiBuilder.group(HostApi, "auth", (handle) =>
  handle.handle("identity", () => Auth.getUserIdentity),
);

const metadata = HttpApiBuilder.group(HostApi, "metadata", (handle) =>
  handle.handle("contextMetadata", () =>
    Effect.gen(function* () {
      const execution = yield* ExecutionMetadata;
      const request = yield* RequestMetadata;
      const fn = yield* execution.getFunction();
      const deployment = yield* execution.getDeployment();
      const meta = yield* request.get();
      return {
        functionName: fn.name,
        deploymentName: deployment.name,
        requestId: meta.requestId,
      };
    }).pipe(Effect.orDie),
  ),
);

const componentAuthoring = HttpApiBuilder.group(
  HostApi,
  "componentAuthoring",
  (handle) =>
    handle.handle("classProbe", ({ params }) =>
      classProbeHandler(first.authoring.probe, params.value),
    ),
);

// The route-local signed ingress rule of `../../../signedEnvelope.ts`: a
// refused envelope gets its declared refusal before anything is written.
const ingress = HttpRouter.add(
  "POST",
  SignedEnvelope.path,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = new Uint8Array(yield* request.arrayBuffer);
    const verdict = yield* Effect.promise(() =>
      SignedEnvelope.verify((name) => request.headers[name], body),
    );
    if (verdict.kind === "refused") {
      return HttpServerResponse.text(verdict.refusal.body, {
        status: verdict.refusal.status,
      });
    }
    const { runMutation } = yield* MutationRunner;
    yield* runMutation(refs.internal.groups.transactions.write, {
      caseId: "ingress",
      value: `${verdict.event}:${verdict.id}`,
      fail: false,
    });
    return HttpServerResponse.text(`accepted ${verdict.event} ${verdict.id}`);
  }).pipe(Effect.orDie),
);

const http = Http.make({
  api: HostApi,
  handlers: Layer.mergeAll(users, metadata, componentAuthoring, auth),
});

export default {
  ...http,
  routes: Layer.mergeAll(http.routes, optionalPrefix, ingress),
};
