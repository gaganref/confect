import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type * as HttpApi from "effect/http-api/HttpApi";
import type * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as OpenApi from "effect/http-api/OpenApi";
import * as String from "effect/String";
import { pipe } from "effect/Function";

const escape = (value: string) =>
  pipe(
    value,
    String.replaceAll("&", "&amp;"),
    String.replaceAll("<", "&lt;"),
    String.replaceAll(">", "&gt;"),
  );

const escapeAttribute = (value: string) =>
  pipe(
    escape(value),
    String.replaceAll('"', "&quot;"),
    String.replaceAll("'", "&#39;"),
  );

const escapeJson = (value: unknown) =>
  pipe(
    JSON.stringify(value),
    String.replaceAll("<", "\\u003c"),
    String.replaceAll("\u2028", "\\u2028"),
    String.replaceAll("\u2029", "\\u2029"),
  );

// WORKAROUND: Effect 4.0.6's HttpApiScalar module imports its inline Scalar
// script dynamically, and Convex's bundler then splits a schema that reaches it
// into an imported chunk, which Convex refuses. This copies `layerCdn`'s page
// byte for byte. Remove when `checkSchemaBundle.mjs` passes with
// `HttpApiScalar.layerCdn` restored.
/**
 * @internal
 */
export const scalarDocs = <
  Id extends string,
  Groups extends HttpApiGroup.Constraint,
>(
  api: HttpApi.HttpApi<Id, Groups>,
  path: `/${string}`,
) =>
  HttpRouter.use((router) => {
    let response: HttpServerResponse.HttpServerResponse | undefined;
    return router.add(
      "GET",
      path,
      Effect.sync(() => {
        if (response !== undefined) return response;
        const spec = OpenApi.fromApi(api);
        const description = (tag: string) =>
          !spec.info.description
            ? ""
            : `<meta name="${tag}" content="${escapeAttribute(spec.info.description)}"/>`;
        response = HttpServerResponse.html(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escape(spec.info.title)}</title>
    ${description("description")}
    ${description("og:description")}
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <div id="api-reference-container"></div>
    <script src="${escapeAttribute("https://cdn.jsdelivr.net/npm/@scalar/api-reference@latest/dist/browser/standalone.min.js")}" crossorigin></script>
    <script>
      window.Scalar.createApiReference(document.getElementById('api-reference-container'), {
        ...${escapeJson({ _integration: "html" })},
        content: ${escapeJson(spec)}
      })
    </script>
  </body>
</html>`);
        return response;
      }),
    );
  });
