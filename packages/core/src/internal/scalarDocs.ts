import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type * as HttpApi from "effect/http-api/HttpApi";
import type * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as OpenApi from "effect/http-api/OpenApi";

const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const escapeAttribute = (value: string) =>
  escape(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const escapeJson = (value: unknown) =>
  JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");

// WORKAROUND: Effect's Scalar module also imports the inline script dynamically.
// Convex splits even that unused import with keepNames. Remove this CDN-only
// renderer when Convex's bundler drops unused dynamic imports without chunks.
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
        const description = spec.info.description
          ? `<meta name="description" content="${escapeAttribute(spec.info.description)}"/><meta name="og:description" content="${escapeAttribute(spec.info.description)}"/>`
          : "";
        response = HttpServerResponse.html(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escape(spec.info.title)}</title>
    ${description}
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <div id="api-reference-container"></div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@latest/dist/browser/standalone.min.js" crossorigin></script>
    <script>
      window.Scalar.createApiReference(document.getElementById('api-reference-container'), {
        _integration: "html",
        content: ${escapeJson(spec)}
      })
    </script>
  </body>
</html>`);
        return response;
      }),
    );
  });
