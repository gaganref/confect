import { Http } from "@confect/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import { classProbeHandler } from "../components/counter/confect/authoringHandler";
import { first } from "./componentBindings";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Layer from "effect/Layer";
import { ExecutionMetadata, RequestMetadata } from "./_generated/services";

const HostApi = HttpApi.make("host")
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

export default Http.make({
  api: HostApi,
  handlers: Layer.mergeAll(users, metadata, componentAuthoring),
});
