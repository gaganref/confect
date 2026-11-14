/**
 * What the binary hands a component that calls a host's function handle with
 * arguments the target's validator refuses, compared with the test kernel,
 * where the same handle names a callback slot that declares the same validator
 * (`packages/test/src/internal/ArgumentValidation.ts`). Both refuse before the
 * target runs, with an `Error` whose message is the binary's
 * `ArgumentValidationError`, one newline longer for an action's call.
 */
import { expect, layer } from "@effect/vitest";
import { makeFunctionReference } from "convex/server";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Rec from "effect/Record";
import * as LocalBackend from "confect-local-backend/LocalBackend";
import { convexTest } from "../../../test/src/internal/ConvexTest";
import { parse } from "../../../test/src/internal/Json";
import {
  onShape,
  type Refusal,
} from "../../../../tools/local-backend/fixtures/plain/convex/callbackArgs";

const valid: Readonly<Record<string, unknown>> = {
  token: "t",
  count: 1.5,
  big: 7n,
  flag: true,
  nothing: null,
  tags: ["x"],
  nested: { a: "y" },
  kind: "a",
  scores: { s: 1 },
  blob: new Uint8Array([1, 2]).buffer,
  anything: { deep: [1] },
};

const without = (key: string) => Rec.remove(valid, key);

/**
 * Each argument shape the probe sends, the valid one first.
 */
const shapes: Readonly<Record<string, unknown>> = {
  valid,
  missing: without("token"),
  extra: { ...valid, extra: 1 },
  missingAndExtra: { ...without("token"), aaa: 1 },
  missingAndMismatch: { ...without("token"), count: "x" },
  extraAndMismatch: { ...valid, zzz: 1, count: "x" },
  twoMismatches: { ...valid, tags: [1], count: "x" },
  nestedPath: { ...valid, nested: { a: 1 } },
  nestedMissing: { ...valid, nested: {} },
  nestedExtra: { ...valid, nested: { a: "y", z: 1 } },
  arrayIndex: { ...valid, tags: ["x", 2] },
  arrayNotArray: { ...valid, tags: "x" },
  objectNotObject: { ...valid, nested: "x" },
  union: { ...valid, kind: "c" },
  int64AsNumber: { ...valid, big: 3 },
  numberAsInt64: { ...valid, count: 4n },
  record: { ...valid, scores: { s: "no" } },
  bytes: { ...valid, blob: "nope" },
  optional: { ...valid, maybe: 5 },
  null: { ...valid, nothing: false },
  negativeZero: { ...valid, token: -0 },
  largeFloat: { ...valid, token: 1e21 },
  nan: { ...valid, token: Number.NaN },
  empty: {},
};

type Caller = "fromMutation" | "fromAction";

const callers = {
  fromMutation: makeFunctionReference<
    "mutation",
    { handle: string; args: unknown },
    Refusal
  >("callbackArgs:fromMutation"),
  fromAction: makeFunctionReference<
    "action",
    { handle: string; args: unknown },
    Refusal
  >("callbackArgs:fromAction"),
};

interface Calls {
  readonly mutation: (reference: any, args: any) => Promise<any>;
  readonly action: (reference: any, args: any) => Promise<any>;
}

const refusalIn = (
  calls: Calls,
  caller: Caller,
  handle: string,
  args: unknown,
): Promise<Refusal> =>
  caller === "fromMutation"
    ? calls.mutation(callers.fromMutation, { handle, args })
    : calls.action(callers.fromAction, { handle, args });

/**
 * The plain fixture on the test kernel, with a sink whose one slot declares
 * `onShape`'s validator and returns `null`.
 */
const kernel = (): Calls =>
  convexTest({
    modules: {
      "_generated/server.ts": () => Promise.resolve({}),
      "callbackArgs.ts": () =>
        import("../../../../tools/local-backend/fixtures/plain/convex/callbackArgs"),
    },
    sink: {
      args: () =>
        parse(
          (onShape as unknown as { exportArgs: () => string }).exportArgs(),
        ),
      call: () => Promise.resolve(null),
    },
  });

const sinkHandle = "function://~sink;fixture/onShape";

layer(LocalBackend.plainLayer, { timeout: "120 seconds" })(
  "callback handle arguments on the binary",
  (it) => {
    it.effect.each(
      Arr.flatMap(Rec.keys(shapes), (shape) =>
        Arr.map(["fromMutation", "fromAction"] as const, (caller) => ({
          shape,
          caller,
        })),
      ),
    )(
      "a handle called $caller with $shape arguments reaches its caller as on the test kernel's sink",
      ({ shape, caller }) =>
        Effect.gen(function* () {
          const { client } = yield* LocalBackend.LocalBackend;
          const handle = yield* Effect.promise(() =>
            client.mutation(
              makeFunctionReference<"mutation", {}, string>(
                "callbackArgs:handle",
              ),
              {},
            ),
          );
          const args = shapes[shape];
          const binary = yield* Effect.promise(() =>
            refusalIn(
              {
                mutation: (reference, a) => client.mutation(reference, a),
                action: (reference, a) => client.action(reference, a),
              },
              caller,
              handle,
              args,
            ),
          );
          if (shape === "valid") expect(binary).toEqual({ returned: true });
          else
            expect(binary).toMatchObject({
              returned: false,
              name: "Error",
              message: expect.stringMatching(/^ArgumentValidationError: /),
            });
          const onKernel = yield* Effect.promise(() =>
            refusalIn(kernel(), caller, sinkHandle, args),
          );
          expect(onKernel).toEqual(binary);
        }),
    );
  },
);
