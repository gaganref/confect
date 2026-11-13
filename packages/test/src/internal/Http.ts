import { convexToJson, type Value } from "convex/values";
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

const uncaught = (thrown: unknown): string =>
  `Uncaught ${thrown instanceof Error ? Error.prototype.toString.call(thrown) : String(thrown)}`;

const isConvexError = (thrown: unknown): thrown is { readonly data: Value } =>
  typeof thrown === "object" &&
  thrown !== null &&
  Symbol.for("ConvexError") in thrown;

/**
 * A `ConvexError`'s data as JSON. Convex's `invokeFunction` serializes the data
 * of an error a handler throws as the JSON of its Convex JSON form.
 */
const errorData = (data: Value): unknown => {
  if (typeof data !== "string") return convexToJson(data);
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
};

/**
 * The binary's answer when a route's handler throws: 500, `application/json`,
 * and `{ code, trace, data? }`, as `RedactedJsError::to_http_response_parts`
 * builds it (`crates/application/src/redaction.rs:143-160`) for a deployment
 * that does not redact its logs. `code` names a fresh request ID and the
 * uncaught error, `trace` is that error and its stack frames, and `data` is a
 * `ConvexError`'s data. The kernel's frames are the host's, not the bundle's,
 * and `requestId` is the kernel's own 16 hex digits.
 */
export const serverError = (thrown: unknown, requestId: string): Response => {
  const message = uncaught(thrown);
  const frames =
    thrown instanceof Error
      ? (thrown.stack ?? "")
          .split("\n")
          .filter((line) => line.startsWith("    at "))
      : [];
  const body: Record<string, unknown> = {
    code: `[Request ID: ${requestId}] Server Error: ${message}`,
    trace: `${[message, ...frames].join("\n")}\n`,
  };
  if (isConvexError(thrown)) body["data"] = errorData(thrown.data);
  return new Response(JSON.stringify(body), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
};

/**
 * The `n`th request ID the kernel names in an error, 16 hex digits as the
 * binary's `RequestId` prints.
 */
export const errorRequestId = (n: number): string =>
  n.toString(16).padStart(16, "0");
