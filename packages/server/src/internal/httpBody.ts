import type * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Str from "effect/String";
import { pipe } from "effect/Function";

/**
 * Read the body once under the endpoint's cap before downstream middleware or
 * decoding. Configure maxBytes from the endpoint's policy. Non-identity
 * Content-Encoding receives 415 and a body past the cap 413. Stream readers and
 * decoders downstream see the same counted bytes.
 */
export const withBodyLimit = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: { readonly maxBytes: ByteSize.ByteSize },
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const header = request.headers["content-encoding"];
    const encoding =
      header === undefined
        ? undefined
        : pipe(header, Str.trim, Str.toLowerCase);
    if (encoding !== undefined && encoding !== "identity")
      return HttpServerResponse.empty({ status: 415 });
    const read = yield* request.arrayBuffer.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, options.maxBytes),
      Effect.result,
    );
    if (Result.isFailure(read)) {
      const { reason } = read.failure;
      if (
        reason._tag === "RequestParseError" &&
        reason.reason === "BodyTooLarge"
      )
        return HttpServerResponse.empty({ status: 413 });
      return yield* Effect.die(read.failure);
    }
    const bytes = read.success;
    const source = new Request(request.originalUrl, {
      method: request.method,
      headers: request.headers,
      ...(request.method === "GET" || request.method === "HEAD"
        ? {}
        : { body: bytes }),
    });
    // A verifier may drain the stream before the decoder reads the body, so
    // the buffered request serves the counted bytes rather than its consumed
    // body. Effect derives text from this read.
    source.arrayBuffer = () => Promise.resolve(bytes);
    const buffered = HttpServerRequest.fromWeb(source).modify({
      url: request.url,
      remoteAddress: request.remoteAddress,
    });
    return yield* Effect.provideService(
      effect,
      HttpServerRequest.HttpServerRequest,
      buffered,
    );
  });
