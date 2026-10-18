import { Http } from "@confect/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
const api = HttpApi.make("host").add(
  HttpApiGroup.make("health").add(
    HttpApiEndpoint.get("health", "/health", {
      success: Schema.String.pipe(HttpApiSchema.asText()),
    }),
  ),
);
export default Http.make({
  api,
  handlers: HttpApiBuilder.group(api, "health", (handle) =>
    handle.handle("health", () => Effect.succeed("host ready")),
  ),
});
