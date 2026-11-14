import { expect } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Rec from "effect/Record";
import type { Outcome } from "./conformance";

/**
 * What a fetch did, as a conformance outcome named `name`: the response's
 * status, or the tag (or name) and message of the error it rejected with, as
 * convex-test rejects a route that throws. The response, when there is one,
 * comes back for its body to be checked.
 */
export const fetchOutcome = <E, R>(
  name: string,
  fetched: Effect.Effect<Response, E, R>,
) =>
  Effect.exit(fetched).pipe(
    Effect.map(
      (
        exit,
      ): {
        readonly outcome: Outcome;
        readonly response: Response | undefined;
      } => {
        if (Exit.isSuccess(exit)) {
          return {
            outcome: { function: name, returned: exit.value.status },
            response: exit.value,
          };
        }
        const error = Cause.squash(exit.cause) as {
          readonly _tag?: string;
          readonly name?: string;
          readonly message?: string;
        };
        return {
          outcome: {
            function: name,
            failed: {
              tag: error._tag ?? error.name ?? "unknown",
              message: error.message ?? "",
            },
          },
          response: undefined,
        };
      },
    ),
  );

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
    expect(Rec.keys(body)).toStrictEqual(
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
