import { Ref } from "@confect/core";
import type { ClassProbe } from "./fixtures/components/counter/confect/authoring.spec";
import refs from "./fixtures/confect/_generated/refs";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { expect, expectTypeOf, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import type {
  first,
  second,
  left,
  right,
} from "./fixtures/confect/componentBindings";
import { api } from "./fixtures/convex/_generated/api";
import * as LocalBackend from "./LocalBackend";

// These identities come from Convex's generated ComponentApi<MountName>,
// including the nested child's scope carried by the parent's contract.
expectTypeOf<Ref.Returns<typeof first.counter.create>>().not.toExtend<
  Ref.Returns<typeof second.counter.create>
>();
expectTypeOf<Ref.Returns<typeof left.parent.create>>().not.toExtend<
  Ref.Returns<typeof right.parent.create>
>();
expectTypeOf<Ref.Returns<typeof first.counter.create>>().not.toExtend<
  Ref.Returns<typeof left.parent.create>
>();

layer(Layer.mergeAll(LocalBackend.layer, NodeHttpClient.layerUndici), {
  timeout: "120 seconds",
  // Scheduled functions run on the real backend's clock.
  excludeTestServices: true,
})("Confect-authored components on a real backend", (it) => {
  it.effect(
    "supports vanilla wire calls, decoded Confect calls, nested isolation, and typed-error rollback",
    () =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        const run = String(yield* Random.next);
        const native = yield* Effect.promise(() =>
          client.mutation(api.groups.nativeComponents.roundTrip, { run }),
        );
        expect(native.docs).toEqual([
          {
            _id: native.id,
            _creationTime: expect.any(Number),
            run,
            count: "2",
          },
        ]);
        const result = yield* Effect.promise(() =>
          client.mutation(api.groups.components.exercise, { run }),
        );
        expect(result).toEqual({
          first: [2],
          second: [7],
          left: [11],
          right: [13],
          rejectedId: expect.any(String),
        });
      }),
  );

  it.effect(
    "round-trips generated system IDs stored in a component table",
    () =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        const uploadUrl = yield* Effect.promise(() =>
          client.mutation(api.groups.components.uploadUrl, {}),
        );
        const uploaded = yield* HttpClient.post(uploadUrl, {
          body: HttpBody.text("stored system id"),
        }).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(
            HttpClientResponse.schemaBodyJson(
              Schema.Struct({ storageId: Schema.String }),
            ),
          ),
        );
        const scheduled = yield* Effect.promise(() =>
          client.mutation(api.groups.components.schedule, {
            run: "system-id-proof",
          }),
        );
        const ids = { storage: uploaded.storageId, scheduled };
        const id = yield* Effect.promise(() =>
          client.mutation(api.groups.componentAuthoring.save, ids),
        );
        expect(
          yield* Effect.promise(() =>
            client.query(api.groups.componentAuthoring.read, { id }),
          ),
        ).toEqual(ids);
      }),
  );

  it.effect(
    "decodes an id-free class through its host schema and shared HTTP handler",
    () =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        const result = yield* Effect.promise(() =>
          client.query(api.groups.componentAuthoring.render, {
            value: "backend",
          }),
        );
        expect(result).toBe("class:backend");
        const wire = yield* Effect.promise(() =>
          client.query(api.groups.componentAuthoring.probe, {
            value: "schema",
          }),
        );
        const decoded: ClassProbe = Ref.decodeReturnsSync(
          refs.public.groups.componentAuthoring.probe,
          wire,
        );
        expect(decoded.render()).toBe("class:schema");
        for (const path of [
          "/first/class-probe/http",
          "/component-class-probe/http",
        ]) {
          const body = yield* HttpClient.get(
            `http://127.0.0.1:3211${path}`,
          ).pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap((response) => response.text),
          );
          expect(body).toBe("class:http");
        }
      }),
  );

  it.effect(
    "schedules an encoded mutation only in the originating installation",
    () =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        const run = String(yield* Random.next);
        const id = yield* Effect.promise(() =>
          client.mutation(api.groups.components.schedule, { run }),
        );
        expect(id).toEqual(expect.any(String));
        yield* Effect.promise(() =>
          client.query(api.groups.components.list, { run }),
        ).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("100 millis"),
            until: (result) => result.first.length > 0,
          }),
          Effect.timeout("10 seconds"),
        );
        const result = yield* Effect.promise(() =>
          client.query(api.groups.components.list, { run }),
        );
        expect(result).toEqual({ first: [17], second: [] });
      }),
  );

  it.effect(
    "cancels component jobs from both scheduling methods before their deadlines",
    () =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        const run = String(yield* Random.next);
        const ids = yield* Effect.promise(() =>
          client.mutation(api.groups.components.scheduleAndCancel, { run }),
        );
        expect(ids).toEqual({
          after: expect.any(String),
          at: expect.any(String),
          control: expect.any(String),
        });
        const result = yield* Effect.promise(() =>
          client.query(api.groups.components.list, { run }),
        ).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("100 millis"),
            until: (rows) => rows.first.length > 0,
          }),
          Effect.timeout("10 seconds"),
        );
        expect(result).toEqual({ first: [17], second: [] });
        expect(
          yield* Effect.promise(() =>
            client.mutation(api.groups.components.cancel, { id: ids.control }),
          ),
        ).toBeNull();
        yield* Effect.promise(() =>
          expect(
            client.mutation(api.groups.components.cancel, {
              id: "invalid-scheduled-id",
            }),
          ).rejects.toThrow(/Invalid.*(?:scheduled function|ID)/),
        );
      }),
  );

  it.effect("uses component-scoped storage across the host boundary", () =>
    Effect.gen(function* () {
      const { client } = yield* LocalBackend.LocalBackend;
      const uploadUrl = yield* Effect.promise(() =>
        client.mutation(api.groups.components.uploadUrl, {}),
      );
      const uploadResponse = yield* HttpClient.post(uploadUrl, {
        body: HttpBody.text("component storage"),
      }).pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
      const { storageId } = yield* HttpClientResponse.schemaBodyJson(
        Schema.Struct({ storageId: Schema.String }),
      )(uploadResponse);
      const url = yield* Effect.promise(() =>
        client.query(api.groups.components.storageUrl, { id: storageId }),
      );
      const body = yield* HttpClient.get(url).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.text),
      );
      expect(body).toBe("component storage");
    }),
  );

  it.effect(
    "mounts component HTTP routes and omits application auth from component contexts",
    () =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        expect(
          yield* Effect.promise(() =>
            client.query(api.groups.components.hasAuth, {}),
          ),
        ).toBe(false);
        for (const mount of [
          "first",
          "second",
          "left/child",
          "right/child",
          "left/deep/child/child",
          "right/deep/child/child",
        ]) {
          const body = yield* HttpClient.get(
            `http://127.0.0.1:3211/${mount}/health`,
          ).pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap((response) => response.text),
          );
          expect(body).toBe("component-ready");
          const echo = yield* HttpClient.post(
            `http://127.0.0.1:3211/${mount}/echo`,
            {
              body: HttpBody.text(`body for ${mount}`),
            },
          ).pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap((response) => response.text),
          );
          expect(echo).toBe(`body for ${mount}`);
          const missing = yield* HttpClient.get(
            `http://127.0.0.1:3211/${mount}/missing`,
          );
          expect(missing.status).toBe(404);
        }
      }),
  );
  it.effect(
    "keeps three nested child bindings isolated across parent installations",
    () =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        const run = String(yield* Random.next);
        yield* Effect.promise(() =>
          client.mutation(api.groups.components.deepCreate, {
            run,
            installation: "left",
            count: 23,
          }),
        );
        yield* Effect.promise(() =>
          client.mutation(api.groups.components.deepCreate, {
            run,
            installation: "right",
            count: 29,
          }),
        );
        // Read both installations after both writes so either direction of leakage fails.
        const left = yield* Effect.promise(() =>
          client.query(api.groups.components.deepRead, {
            run,
            installation: "left",
          }),
        );
        const right = yield* Effect.promise(() =>
          client.query(api.groups.components.deepRead, {
            run,
            installation: "right",
          }),
        );
        expect({
          left: left.counts,
          right: right.counts,
          paths: [left.path, right.path],
        }).toEqual({
          left: [23],
          right: [29],
          paths: ["left/deep/child/child", "right/deep/child/child"],
        });
      }),
  );

  it.effect(
    "decodes a declared component error as its tagged class with its payload",
    () =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        const run = String(yield* Random.next);
        const result = yield* Effect.promise(() =>
          client.mutation(api.groups.components.declaredError, { run }),
        );
        expect(result).toEqual({
          tag: "Rejected",
          run,
          instance: true,
          remaining: [],
        });
      }),
  );

  it.effect(
    "paginates a component QueryStream without gaps or rows from another installation",
    () =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        const run = String(yield* Random.next);
        yield* Effect.promise(() =>
          client.mutation(api.groups.components.seed, {
            run,
            counts: [1, 2, 3, 4, 5],
          }),
        );
        const page = (cursor: string | null) =>
          Effect.promise(() =>
            client.query(api.groups.components.page, {
              run,
              cursor,
              numItems: 2,
            }),
          );
        const firstPage = yield* page(null);
        const secondPage = yield* page(firstPage.continueCursor);
        const lastPage = yield* page(secondPage.continueCursor);
        expect([firstPage.page, secondPage.page, lastPage.page]).toEqual([
          [1, 2],
          [3, 4],
          [5],
        ]);
        expect([firstPage.isDone, secondPage.isDone, lastPage.isDone]).toEqual([
          false,
          false,
          true,
        ]);
      }),
  );

  it.effect(
    "reads each mount's bound env and the host's own env through the declared Config entries",
    () =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        const result = yield* Effect.promise(() =>
          client.query(api.groups.components.environment, {}),
        );
        expect(result).toEqual({
          first: {
            required: "first-required",
            directRequired: "first-required",
            optional: "first-optional",
            marker: "from-app",
            unbound: "unset",
            hostOnly: "unset",
          },
          second: {
            required: "second-required",
            directRequired: "second-required",
            optional: "from-app",
            marker: "from-app",
            unbound: "unset",
            hostOnly: "unset",
          },
          host: { marker: "from-app", hostOnly: "host-only" },
        });
      }),
  );

  it.effect(
    "runs component crons in both installations after the observed baseline",
    () =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        const read = Effect.promise(() =>
          client.query(api.groups.components.ticks, {}),
        );
        const baseline = yield* read;
        const result = yield* read.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("100 millis"),
            until: (counts) =>
              counts.first > baseline.first && counts.second > baseline.second,
          }),
          Effect.timeout("15 seconds"),
        );
        expect(result.first).toBeGreaterThan(baseline.first);
        expect(result.second).toBeGreaterThan(baseline.second);
      }),
  );

  it.effect(
    "a component stores a host handle and calls it back across a redeploy",
    () =>
      Effect.gen(function* () {
        const { client, redeploy } = yield* LocalBackend.LocalBackend;
        const run = String(yield* Random.next);
        const events = Effect.promise(() =>
          client.query(api.groups.callbacks.events, { run }),
        );
        const id = yield* Effect.promise(() =>
          client.mutation(api.groups.callbacks.send, { run }),
        );
        expect(
          yield* events.pipe(
            Effect.repeat({
              schedule: Schedule.spaced("100 millis"),
              until: (statuses) => statuses.length > 0,
            }),
            Effect.timeout("15 seconds"),
          ),
        ).toEqual(["sent"]);

        expect(
          yield* Effect.promise(() =>
            client.mutation(api.groups.callbacks.setStatus, {
              id,
              status: "bounced",
            }),
          ),
        ).toBe(`host refuses bounced for ${run}`);
        expect(
          yield* Effect.promise(() =>
            client.query(api.groups.callbacks.get, { id }),
          ),
        ).toEqual({ run, status: "bounced" });
        expect(
          yield* Effect.promise(() =>
            client.mutation(api.groups.callbacks.breach, { id }),
          ),
        ).toBe("defect");

        yield* redeploy;
        expect(
          yield* Effect.promise(() =>
            client.mutation(api.groups.callbacks.sameHandle, { id }),
          ),
        ).toBe(true);
        expect(
          yield* Effect.promise(() =>
            client.mutation(api.groups.callbacks.setStatus, {
              id,
              status: "delivered",
            }),
          ),
        ).toBeNull();
        expect(yield* events).toEqual(["sent", "delivered"]);
      }),
  );

  it.effect(
    "fails to create a handle for a function that is not deployed",
    () =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        const observed = yield* Effect.promise(() =>
          client.mutation(api.groups.callbacks.createRetired, {}),
        );
        yield* Effect.logInfo("handle for an undeployed function", observed);
        expect(observed.outcome).toBe("defect");
      }),
  );

  it.effect(
    "refuses to create a handle for a host function whose validators differ from the contract",
    () =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        expect(
          yield* Effect.promise(() =>
            client.mutation(api.groups.callbacks.createMismatched, {}),
          ),
        ).toEqual({
          outcome: "failure",
          message: `The host function does not satisfy callback contract "counter/onReported": its args compile to {"kind":"object","fields":{"state":{"kind":"string"}}}, the contract's to {"kind":"object","fields":{"status":{"kind":"string"}}}.`,
        });
      }),
  );
});
