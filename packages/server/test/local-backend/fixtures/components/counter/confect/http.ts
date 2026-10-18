import { Http } from "@confect/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { ActionCtx } from "./_generated/services";
import refs from "./_generated/refs";
import { classProbeHandler } from "./authoringHandler";
import { CounterApi } from "./api";

const health = HttpApiBuilder.group(CounterApi, "health", (handle) =>
  handle
    .handle("health", () =>
      Effect.map(ActionCtx, (ctx) =>
        Predicate.hasProperty(ctx, "auth")
          ? "unexpected-auth"
          : "component-ready",
      ),
    )
    .handle("echo", ({ payload }) => Effect.succeed(payload)),
);

const users = HttpApiBuilder.group(CounterApi, "users", (handle) =>
  handle.handle("get", ({ params }) => Effect.succeed(params.id)),
);

const authoring = HttpApiBuilder.group(CounterApi, "authoring", (handle) =>
  handle.handle("classProbe", ({ params }) =>
    classProbeHandler(refs.public.authoring.probe, params.value),
  ),
);

export default Http.make({
  api: CounterApi,
  handlers: Layer.mergeAll(health, users, authoring),
});
