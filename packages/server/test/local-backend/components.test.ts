import { type Component, Ref } from "@confect/core";
import type {
  FunctionArgs,
  FunctionHandle,
  FunctionHandle_future,
  FunctionReference,
  FunctionReturnType,
} from "convex/server";
import type { ClassProbe } from "../../../../tools/local-backend/fixtures/components/counter/confect/authoring.spec";
import type counterSpec from "../../../../tools/local-backend/fixtures/components/counter/confect/_generated/spec";
import type { ComponentApi as CounterApi } from "../../../../tools/local-backend/fixtures/convexComponentApi/_generated/counter";
import type innerSpec from "../../../../tools/local-backend/fixtures/components/inner/confect/_generated/spec";
import type { ComponentApi as InnerApi } from "../../../../tools/local-backend/fixtures/convexComponentApi/_generated/inner";
import type middleSpec from "../../../../tools/local-backend/fixtures/components/middle/confect/_generated/spec";
import type { ComponentApi as MiddleApi } from "../../../../tools/local-backend/fixtures/convexComponentApi/_generated/middle";
import type parentSpec from "../../../../tools/local-backend/fixtures/components/parent/confect/_generated/spec";
import type { ComponentApi as ParentApi } from "../../../../tools/local-backend/fixtures/convexComponentApi/_generated/parent";
import type guardedSpec from "../../../../tools/local-backend/fixtures/guard/components/guarded/confect/_generated/spec";
import type { ComponentApi as GuardedApi } from "../../../../tools/local-backend/fixtures/convexComponentApi/_generated/guarded";
import refs from "confect-local-backend/refs";
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
} from "../../../../tools/local-backend/fixtures/confect/componentBindings";
import { api } from "../../../../tools/local-backend/fixtures/convex/_generated/api";
import * as LocalBackend from "confect-local-backend/LocalBackend";

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

type Fn = FunctionReference<any, any, any, any, any>;

type IsAny<A> = 0 extends 1 & A ? true : false;

type Identical<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * `A` with what assignability cannot see made visible, so that two revealed
 * types are mutually assignable only when a host can make the same calls with
 * both. `any` becomes a marker. Each key becomes required and carries markers
 * for its optional and readonly modifiers, so a key on one side only, or a
 * modifier on one side only, is a difference. A function handle reveals its
 * args and returns.
 */
type Reveal<A> =
  IsAny<A> extends true
    ? { readonly "~reveal": "any" }
    : A extends FunctionHandle_future<infer Type, infer Args, infer Returns>
      ? { handle: Type; args: Reveal<Args>; returns: Reveal<Returns> }
      : A extends
            | string
            | number
            | bigint
            | boolean
            | null
            | undefined
            | ArrayBuffer
        ? A
        : A extends ReadonlyArray<infer Element>
          ? A extends Array<any>
            ? Array<Reveal<Element>>
            : ReadonlyArray<Reveal<Element>>
          : {
              -readonly [K in keyof A]-?:
                | Reveal<A[K]>
                | ({} extends Pick<A, K>
                    ? { readonly "~reveal": "optional" }
                    : never)
                | (Identical<Pick<A, K>, Readonly<Pick<A, K>>> extends true
                    ? { readonly "~reveal": "readonly" }
                    : never);
            };

type Compare<Confect, Convex, What extends string> =
  | ([Reveal<Convex>] extends [Reveal<Confect>]
      ? never
      : `${What}: Convex's are not Confect's`)
  | ([Reveal<Confect>] extends [Reveal<Convex>]
      ? never
      : `${What}: Confect's are not Convex's`);

type ArgsMismatch<Confect, Convex> = true extends IsAny<Confect> | IsAny<Convex>
  ? Compare<Confect, Convex, "args">
  : {
      [
        Key in (keyof Confect | keyof Convex) & string
      ]: Key extends keyof Confect
        ? Key extends keyof Convex
          ? Compare<Pick<Confect, Key>, Pick<Convex, Key>, `args.${Key}`>
          : `args.${Key}: missing from Convex`
        : `args.${Key}: missing from Component.Api`;
    }[(keyof Confect | keyof Convex) & string];

type FunctionMismatch<Confect extends Fn, Convex extends Fn> =
  | (Mutual<Confect["_type"], Convex["_type"]> extends true ? never : "kind")
  | (Mutual<Confect["_visibility"], Convex["_visibility"]> extends true
      ? never
      : "visibility")
  | (Mutual<Confect["_componentPath"], Convex["_componentPath"]> extends true
      ? never
      : "component path")
  | ArgsMismatch<FunctionArgs<Confect>, FunctionArgs<Convex>>
  | Compare<FunctionReturnType<Confect>, FunctionReturnType<Convex>, "returns">;

/**
 * One label per difference between `Component.Api` and Convex's generated
 * `ComponentApi`, as `<path>: <difference>`.
 */
type ApiMismatches<Confect, Convex, Path extends string> = {
  [Key in (keyof Confect | keyof Convex) & string]: Key extends keyof Confect
    ? Key extends keyof Convex
      ? Confect[Key] extends Fn
        ? Convex[Key] extends Fn
          ? `${Path}${Key}: ${FunctionMismatch<Confect[Key], Convex[Key]>}`
          : `${Path}${Key}: a function in Confect, a group in Convex`
        : Convex[Key] extends Fn
          ? `${Path}${Key}: a group in Confect, a function in Convex`
          : ApiMismatches<Confect[Key], Convex[Key], `${Path}${Key}.`>
      : `${Path}${Key}: missing from Convex`
    : `${Path}${Key}: missing from Component.Api`;
}[(keyof Confect | keyof Convex) & string];

// Convex generates a component's ComponentApi from its pushed functions. A host
// that reads Component.Api instead must get the same call types. Each API is
// read under a mount name, so the component path is compared too.
expectTypeOf<Component.Api<typeof counterSpec>>().not.toBeAny();
expectTypeOf<Component.Api<typeof innerSpec>>().not.toBeAny();
expectTypeOf<Component.Api<typeof middleSpec>>().not.toBeAny();
expectTypeOf<Component.Api<typeof parentSpec>>().not.toBeAny();
expectTypeOf<Component.Api<typeof guardedSpec>>().not.toBeAny();

interface Comparisons {
  readonly counter: ApiMismatches<
    Component.Api<typeof counterSpec, "child">,
    CounterApi<"child">,
    "counter/"
  >;
  readonly inner: ApiMismatches<
    Component.Api<typeof innerSpec, "child">,
    InnerApi<"child">,
    "inner/"
  >;
  readonly middle: ApiMismatches<
    Component.Api<typeof middleSpec, "deep">,
    MiddleApi<"deep">,
    "middle/"
  >;
  readonly parent: ApiMismatches<
    Component.Api<typeof parentSpec, "left">,
    ParentApi<"left">,
    "parent/"
  >;
  readonly guarded: ApiMismatches<
    Component.Api<typeof guardedSpec, "guarded">,
    GuardedApi<"guarded">,
    "guarded/"
  >;
}
type Mismatches = Comparisons[keyof Comparisons];

/**
 * The differences kept on purpose. Neither lets a call through that Convex
 * refuses. The third, a recursive schema that lowers to `v.any()`, has no
 * fixture; the core suite's lowering matrix names it. The matrix also names a
 * fourth, which is not deliberate. A `Schema.declare` whose check accepts an
 * `ArrayBuffer` lowers to `v.bytes()`, and `Component.Api` keeps its declared
 * type.
 */
type Excused =
  // Convex types a query without a returns validator as returning `any`.
  // Component.Api gives the handler's declared return, checked below.
  | `${"inner" | "middle" | "parent"}/parent.identityChain: returns: ${"Convex's are not Confect's" | "Confect's are not Convex's"}`
  // Convex's type has the reserved `context?: any` arg, which only the
  // runners fill in. Component.Api leaves it out, so a host that passes it is
  // refused where Convex's type accepts it.
  | "counter/reserved.echo: args.context: missing from Component.Api";

// A failure lists each unexcused difference as a property `{}` is missing.
({}) satisfies { readonly [Label in Exclude<Mismatches, Excused>]: true };
// An exception that no longer happens fails here, and so does a comparison
// that widens to every label.
expectTypeOf<Mismatches>().toEqualTypeOf<Excused>();

type IdentityChain = Array<{ componentPath: string; subject: string | null }>;
expectTypeOf<
  FunctionReturnType<InnerApi["parent"]["identityChain"]>
>().toBeAny();
expectTypeOf<
  FunctionReturnType<Component.Api<typeof innerSpec>["parent"]["identityChain"]>
>().toEqualTypeOf<IdentityChain>();
expectTypeOf<
  FunctionReturnType<
    Component.Api<typeof middleSpec>["parent"]["identityChain"]
  >
>().toEqualTypeOf<IdentityChain>();
expectTypeOf<
  FunctionReturnType<
    Component.Api<typeof parentSpec>["parent"]["identityChain"]
  >
>().toEqualTypeOf<IdentityChain>();
expectTypeOf<
  Pick<FunctionArgs<CounterApi["reserved"]["echo"]>, "context">
>().toEqualTypeOf<{ context?: any }>();

type DeliveryStatus = "queued" | "sent" | "delivered" | "bounced";
type OnEvent = FunctionArgs<
  Component.Api<typeof counterSpec>["deliveries"]["send"]
>["onEvent"];
expectTypeOf<
  FunctionHandle_future<
    "mutation",
    { run: string; status: DeliveryStatus },
    null
  >
>().toExtend<OnEvent>();
expectTypeOf<"not-a-handle">().not.toExtend<OnEvent>();
expectTypeOf<
  FunctionHandle_future<
    "mutation",
    { run: number; status: DeliveryStatus },
    null
  >
>().not.toExtend<OnEvent>();

// What `createFunctionHandle` returns for a host mutation with the args and
// returns Convex's validators give the contract.
expectTypeOf<
  FunctionHandle<
    "mutation",
    {
      id: string;
      meta: { run: string; tags: Array<string> };
      runs: Array<string>;
    },
    Array<{ id: string; status: DeliveryStatus }>
  >
>().toExtend<
  FunctionArgs<
    Component.Api<typeof counterSpec>["deliveries"]["echoBatch"]
  >["onBatch"]
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
        const random = yield* Random.next;
        const run = String(random);
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
        const resolved = yield* Effect.promise(() =>
          client.query(api.groups.componentAuthoring.read, { id }),
        );
        expect(resolved).toEqual(ids);
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
          const body = yield* HttpClient.get(LocalBackend.siteUrl(path)).pipe(
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
        const random = yield* Random.next;
        const run = String(random);
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
        const random = yield* Random.next;
        const run = String(random);
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
        const resolved = yield* Effect.promise(() =>
          client.mutation(api.groups.components.cancel, { id: ids.control }),
        );
        expect(resolved).toBeNull();
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
        const resolved = yield* Effect.promise(() =>
          client.query(api.groups.components.hasAuth, {}),
        );
        expect(resolved).toBe(false);
        for (const mount of [
          "first",
          "second",
          "left/child",
          "right/child",
          "left/deep/child/child",
          "right/deep/child/child",
        ]) {
          const body = yield* HttpClient.get(
            LocalBackend.siteUrl(`/${mount}/health`),
          ).pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap((response) => response.text),
          );
          expect(body).toBe("component-ready");
          const echo = yield* HttpClient.post(
            LocalBackend.siteUrl(`/${mount}/echo`),
            {
              body: HttpBody.text(`body for ${mount}`),
            },
          ).pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap((response) => response.text),
          );
          expect(echo).toBe(`body for ${mount}`);
          const missing = yield* HttpClient.get(
            LocalBackend.siteUrl(`/${mount}/missing`),
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
        const random = yield* Random.next;
        const run = String(random);
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
        const random = yield* Random.next;
        const run = String(random);
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
        const random = yield* Random.next;
        const run = String(random);
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
    "reads each mount's bound env, in a helper its modules read while they load and through the declared Config entries, and the host's own env",
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
            loaded: "first-required",
            drawn: expect.any(Number),
            outside: "first-required",
            outsideDrawn: expect.any(Number),
            app: "first-required",
            chain: "first-required",
            optional: "first-optional",
            marker: "from-app",
            unbound: "unset",
            hostOnly: "unset",
          },
          second: {
            required: "second-required",
            directRequired: "second-required",
            loaded: "second-required",
            drawn: expect.any(Number),
            outside: "second-required",
            outsideDrawn: expect.any(Number),
            app: "second-required",
            chain: "second-required",
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
    "rejects a malformed callback handle stored in a component table",
    () =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        yield* Effect.promise(() =>
          expect(
            client.mutation(api.groups.callbacks.storeMalformed, {
              run: "malformed-handle",
            }),
          ).rejects.toThrow(/does not match the schema[\s\S]*v\.function/),
        );
      }),
  );

  it.effect(
    "a component stores a host handle and calls it back across a redeploy",
    () =>
      Effect.gen(function* () {
        const { client, redeploy } = yield* LocalBackend.LocalBackend;
        const random = yield* Random.next;
        const run = String(random);
        const events = Effect.promise(() =>
          client.query(api.groups.callbacks.events, { run }),
        );
        const id = yield* Effect.promise(() =>
          client.mutation(api.groups.callbacks.send, { run }),
        );
        const eventsResult = yield* events.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("100 millis"),
            until: (statuses) => statuses.length > 0,
          }),
          Effect.timeout("15 seconds"),
        );
        expect(eventsResult).toEqual(["sent"]);

        const resolved = yield* Effect.promise(() =>
          client.mutation(api.groups.callbacks.setStatus, {
            id,
            status: "bounced",
          }),
        );
        expect(resolved).toBe(`host refuses bounced for ${run}`);
        const resolved2 = yield* Effect.promise(() =>
          client.query(api.groups.callbacks.get, { id }),
        );
        expect(resolved2).toEqual({ run, status: "bounced" });
        const resolved3 = yield* Effect.promise(() =>
          client.mutation(api.groups.callbacks.breach, { id }),
        );
        expect(resolved3).toBe("defect");

        yield* redeploy;
        const resolved4 = yield* Effect.promise(() =>
          client.mutation(api.groups.callbacks.sameHandle, { id }),
        );
        expect(resolved4).toBe(true);
        const resolved5 = yield* Effect.promise(() =>
          client.mutation(api.groups.callbacks.setStatus, {
            id,
            status: "delivered",
          }),
        );
        expect(resolved5).toBeNull();
        const eventsValue = yield* events;
        expect(eventsValue).toEqual(["sent", "delivered"]);
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
        const resolved = yield* Effect.promise(() =>
          client.mutation(api.groups.callbacks.createMismatched, {}),
        );
        expect(resolved).toEqual({
          outcome: "failure",
          message: `The host function does not satisfy callback contract "counter/onReported": its args compile to {"kind":"object","fields":{"state":{"kind":"string"}}}, the contract's to {"kind":"object","fields":{"status":{"kind":"string"}}}.`,
        });
      }),
  );
});
