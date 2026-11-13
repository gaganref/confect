import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

/**
 * Check a response is the binary's answer to a route that throws: 500,
 * `application/json` and `{ code, trace, data? }`. The pinned binary's answers
 * are in `../local-backend/httpErrors.test.ts`.
 */
export const expectServerError = (
  response: Response,
  uncaught: string,
  data?: unknown,
) =>
  Effect.gen(function* () {
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe("application/json");
    const body = (yield* Effect.promise(() => response.json())) as Record<
      string,
      unknown
    >;
    expect(Object.keys(body)).toStrictEqual(
      data === undefined ? ["code", "trace"] : ["code", "trace", "data"],
    );
    expect(body["code"]).toMatch(
      new RegExp(
        `^\\[Request ID: [0-9a-f]{16}\\] Server Error: ${RegExp.escape(uncaught)}$`,
      ),
    );
    expect(body["trace"]).toMatch(
      new RegExp(`^${RegExp.escape(uncaught)}\\n(    at .*\\n)*$`),
    );
    expect(body["data"]).toStrictEqual(data);
  });
