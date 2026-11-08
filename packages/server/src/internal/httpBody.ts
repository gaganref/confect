import type * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

class BodyTooLarge extends Schema.TaggedError<BodyTooLarge>()(
  "BodyTooLarge",
  {},
) {}

/**
 * Count the body before downstream middleware or decoding. Configure maxBytes
 * from the endpoint's policy. Non-identity Content-Encoding receives 415. Read
 * arrayBuffer in the wrapped effect to verify the same bytes the decoder uses.
 */
export const withBodyLimit = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: { readonly maxBytes: ByteSize.ByteSize },
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const encoding = request.headers["content-encoding"]?.trim().toLowerCase();
    if (encoding !== undefined && encoding !== "identity")
      return HttpServerResponse.empty({ status: 415 });
    let size = 0;
    const chunks: Array<Uint8Array> = [];
    const empty =
      request.source instanceof Request && request.source.body === null;
    const read = empty
      ? Effect.void
      : Stream.runForEach(request.stream, (chunk) => {
          size += chunk.byteLength;
          if (BigInt(size) > options.maxBytes)
            return Effect.fail(new BodyTooLarge());
          chunks.push(chunk);
          return Effect.void;
        });
    const limited = yield* read.pipe(
      Effect.as(false),
      Effect.catchTag("BodyTooLarge", () => Effect.succeed(true)),
      Effect.orDie,
    );
    if (limited) return HttpServerResponse.empty({ status: 413 });
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const source = new Request(request.originalUrl, {
      method: request.method,
      headers: request.headers,
      ...(request.method === "GET" || request.method === "HEAD"
        ? {}
        : { body: bytes }),
    });
    // WORKAROUND: Effect 4.0.4 caches text and bytes independently. Remove these
    // overrides when the minimum Effect version shares text and byte reads.
    source.arrayBuffer = () => Promise.resolve(bytes.buffer);
    source.text = () => Promise.resolve(new TextDecoder().decode(bytes));
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
