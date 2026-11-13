import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * The origin of a request the test sends to the kernel's HTTP routes, as
 * convex-test sends it. The binary's is its deployment's `.convex.site` URL.
 */
export const origin = "https://some.convex.site";

/**
 * A path given to `fetch` must start with `/`, as convex-test requires.
 */
export class InvalidFetchPath extends Schema.TaggedError<InvalidFetchPath>()(
  "InvalidFetchPath",
  { path: Schema.String, message: Schema.String },
) {}

/**
 * The URL a test's `fetch(path)` requests: the path, query and fragment on the
 * kernel's site origin.
 */
export const requestUrl = (
  path: unknown,
): Result.Result<URL, InvalidFetchPath> =>
  typeof path === "string" && path.startsWith("/")
    ? Result.succeed(new URL(`${origin}${path}`))
    : Result.fail(
        new InvalidFetchPath({
          path: String(path),
          message: "Path given to `t.fetch` must start with a `/`",
        }),
      );

/**
 * The binary's answer when the router's `lookup` finds no route: 404 with the
 * text "No matching routes found" (`run_http_action_inner` in
 * `crates/isolate/src/environment/action/mod.rs`). The npm router's own
 * `runRequest` fallback, which convex-test answers, is never reached there.
 */
export const noRoute = (): Response =>
  new Response("No matching routes found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

/**
 * A HEAD response carries the handler's status and headers and no body, as an
 * HTTP server sends it.
 */
export const forMethod = (method: string, response: Response): Response =>
  method === "HEAD"
    ? new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    : response;
