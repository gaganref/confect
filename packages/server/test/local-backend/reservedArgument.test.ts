import { Ref } from "@confect/core";
import { expect, layer } from "@effect/vitest";
import { makeFunctionReference } from "convex/server";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import refs from "./fixtures/confect/_generated/refs";
import * as LocalBackend from "./LocalBackend";

const Hop = Schema.Struct({ hop: Schema.String });
const hop = (value: unknown) => Schema.decodeUnknownSync(Hop)(value).hop;

layer(LocalBackend.layer, {
  timeout: "120 seconds",
  excludeTestServices: true,
})("reserved argument transport", (it) => {
  it.effect(
    "accepts arbitrary client context and keeps domain args clean",
    () =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        for (const context of [
          null,
          "text",
          42,
          { nested: [1, { ok: true }] },
        ]) {
          const result = yield* Effect.promise(() =>
            client.mutation(
              makeFunctionReference<
                "mutation",
                { run: string; context: unknown },
                {
                  args: { run: string };
                  received: {
                    value: unknown;
                    requestId: string;
                    deployment: string;
                  };
                }
              >("groups/reserved:echo"),
              { run: "client", context },
            ),
          );
          expect(result.args).toEqual({ run: "client" });
          expect(result.received).toEqual({
            value: context,
            requestId: expect.any(String),
            deployment: "http://127.0.0.1:3210",
          });
        }
      }),
  );

  it.effect(
    "crosses runners, an inline component and a scheduled mutation",
    () =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        const run = String(yield* Random.next);
        const result = yield* Ref.runWithCodec(
          refs.public.groups.reserved.chain,
          { run },
          (ref, args) => client.action(ref, args),
        );
        expect(result.mutation.args).toEqual({ run });
        expect(result.action.args).toEqual({ run });
        expect(result.hops[hop(result.mutation.received.value)]).toBe(
          "MutationRunner.runMutation",
        );
        expect(result.hops[hop(result.action.received.value)]).toBe(
          "ActionRunner.runAction",
        );
        expect(
          result.inline.hops[hop(result.inline.child.received.value)],
        ).toBe("MutationTransactionContext.runMutation");
        expect(result.inline.child.received.requestId).toBe(
          result.inline.parent.received.requestId,
        );
        expect(result.inline.child.args).toEqual({ run });
        expect(result.inline.plain).not.toBe("");
        const scheduled = yield* Ref.runWithCodec(
          refs.public.groups.reserved.read,
          { run },
          (ref, args) => client.query(ref, args),
        ).pipe(
          Effect.repeat({
            while: (value) => value === null,
            schedule: Schedule.spaced("100 millis"),
          }),
          Effect.timeout("20 seconds"),
        );
        expect(scheduled?.args).toEqual({ run });
        expect(result.hops[hop(scheduled?.received.value)]).toBe(
          "Scheduler.runAfter",
        );
        expect(result.jobId).not.toBe("");
      }),
  );
});
