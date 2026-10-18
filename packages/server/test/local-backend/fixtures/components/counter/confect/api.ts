import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";

const Text = Schema.String.pipe(HttpApiSchema.asText());

export const CounterApi = HttpApi.make("counter").add(
  HttpApiGroup.make("health").add(
    HttpApiEndpoint.get("health", "/health", { success: Text }),
    HttpApiEndpoint.post("echo", "/echo", { payload: Text, success: Text }),
  ),
  HttpApiGroup.make("authoring").add(
    HttpApiEndpoint.get("classProbe", "/class-probe/:value", {
      params: Schema.Struct({ value: Schema.String }),
      success: Text,
    }),
  ),
  HttpApiGroup.make("users").add(
    HttpApiEndpoint.get("get", "/members/:id", {
      params: Schema.Struct({ id: Schema.String }),
      success: Schema.String,
    }),
  ),
);
