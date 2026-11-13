import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import refs from "../../../tools/local-backend/fixtures/confect/_generated/refs";
import { Recorded } from "../../../tools/local-backend/fixtures/confect/groups/requests.spec";
import { createTestJwt } from "../src/internal/KernelValues";
import { call, localBackendWorld } from "./fixtures/localBackendWorld";
import {
  client,
  expected,
  normalize,
  type Observed,
} from "./fixtures/requestProbe";

const requests = refs.public.groups.requests;
const RecordedJson = Schema.fromJsonString(Recorded);

const issuer = "https://confect-auth.invalid";
const identity = {
  subject: client.subject,
  issuer,
  tokenIdentifier: `${issuer}|${client.subject}`,
};

/**
 * Run the probe as the client: its identity, address and agent on every call.
 * The kernel mints the client's token from the identity as `withIdentity`
 * does.
 */
const observe = Effect.gen(function* () {
  const t = localBackendWorld();
  const caller = t
    .withIdentity(identity)
    .withRequestMetadata({ ip: client.ip, userAgent: client.userAgent });
  const caseId = "kernel";
  const mutation = yield* call(caller, "mutation", requests.mutation);
  const action = yield* call(caller, "action", requests.action);
  const schedule = yield* call(caller, "mutation", requests.schedule, {
    caseId,
  });
  yield* Effect.promise(() => t.finishAllScheduledFunctions());
  const recorded = yield* call(t, "query", requests.recorded, { caseId });
  const observed: Observed = {
    mutation,
    action,
    schedule,
    scheduled: yield* Effect.forEach(recorded, (row) =>
      Schema.decodeEffect(RecordedJson)(row),
    ),
  };
  return normalize(observed, { ...client, token: createTestJwt(identity) });
});

describe("request metadata on the kernel", () => {
  it.effect(
    "gives each client call its own request, carries it into nested calls, and starts each job fresh with its ID",
    () =>
      Effect.gen(function* () {
        const observed = yield* observe;
        expect(observed).toEqual(expected);
      }),
  );
});
