import { Ref } from "@confect/core";
import { expect, layer } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import {
  client,
  expected,
  normalize,
  type Observed,
} from "../../../test/test/fixtures/requestProbe";
import { mintToken, send } from "./clientCall";
import refs from "confect-local-backend/refs";
import { Recorded } from "../../../../tools/local-backend/fixtures/confect/groups/requests.spec";
import * as LocalBackend from "confect-local-backend/LocalBackend";

const requests = refs.public.groups.requests;
const decodeRecorded = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Recorded),
);

layer(LocalBackend.layer, {
  timeout: "120 seconds",
  excludeTestServices: true,
})("request metadata on a real backend", (it) => {
  it.effect(
    "gives each client call its own request, carries it into nested calls, and starts each job fresh with its ID",
    () =>
      Effect.gen(function* () {
        const token = yield* mintToken(client.subject);
        // The binary reads the address from `x-forwarded-for` and the agent
        // from `user-agent`.
        const headers = {
          authorization: `Bearer ${token}`,
          "x-forwarded-for": client.ip,
          "user-agent": client.userAgent,
        };
        const caseId = `binary-${yield* Clock.currentTimeMillis}`;
        const mutation = yield* Ref.runWithCodec(
          requests.mutation,
          {},
          send("mutation", headers),
        );
        const action = yield* Ref.runWithCodec(
          requests.action,
          {},
          send("action", headers),
        );
        const schedule = yield* Ref.runWithCodec(
          requests.schedule,
          { caseId },
          send("mutation", headers),
        );
        // The scheduler runs both jobs on its own; wait for both records.
        const recorded = yield* Ref.runWithCodec(
          requests.recorded,
          { caseId },
          send("query", {}),
        ).pipe(
          Effect.filterOrFail((rows) => rows.length === 2),
          Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
        );
        const observed: Observed = {
          mutation,
          action,
          schedule,
          scheduled: yield* Effect.forEach(recorded, (row) =>
            decodeRecorded(row),
          ),
        };
        expect(normalize(observed, { ...client, token })).toEqual(expected);
      }),
  );
});
