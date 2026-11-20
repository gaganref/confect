import { Http } from "@confect/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import { runs } from "./guard";
import { verdict } from "./verdict";

const Text = Schema.String.pipe(HttpApiSchema.asText());

const GuardApi = HttpApi.make("guard").add(
  HttpApiGroup.make("probe").add(
    HttpApiEndpoint.get("version", "/guard/version", { success: Text }),
    HttpApiEndpoint.get("checkRuns", "/guard/checkRuns", { success: Text }),
  ),
);

const probe = HttpApiBuilder.group(GuardApi, "probe", (handle) =>
  handle
    .handle("version", () => Effect.succeed(String(verdict.version)))
    .handle("checkRuns", () => Effect.sync(() => String(runs.count))),
);

/**
 * @internal
 */
export default Http.make({ api: GuardApi, handlers: probe });
