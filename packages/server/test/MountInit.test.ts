import {
  Callback as CoreCallback,
  Component,
  FunctionSpec,
  Mount,
  Ref,
} from "@confect/core";
import * as Callback from "@confect/server/Callback";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { vi } from "vitest";

const ProbeA = CoreCallback.mutation("probe/a", {
  args: () => ({ count: Schema.Finite }),
  returns: () => Schema.Null,
});
const ProbeB = CoreCallback.mutation("probe/b", {
  args: () => ({ label: Schema.String }),
  returns: () => Schema.Null,
});

const onLabel = Ref.make(
  "callbacks",
  FunctionSpec.internalMutation({
    name: "onLabel",
    args: () => ({ label: Schema.String }),
    returns: () => Schema.Null,
  }),
);

const create = (contract: CoreCallback.Any, ref: Ref.Any) =>
  Callback.create(contract, ref as never);

describe("Mount.initCall with Callback.create", () => {
  it.effect(
    "makes the handle for the union member whose contract the target satisfies",
    () =>
      Effect.gen(function* () {
        const Probe = Component.make("probe", {
          init: Ref.make(
            "install",
            FunctionSpec.internalMutation({
              name: "init",
              args: () => ({
                route: Schema.Union([
                  Schema.Struct({ cb: CoreCallback.handle(ProbeA) }),
                  Schema.Struct({ cb: CoreCallback.handle(ProbeB) }),
                ]),
              }),
              returns: () => Schema.Null,
            }),
          ),
          client: (native: unknown) => native,
        });
        const mount = Mount.make(Probe, {
          name: "probe",
          args: { route: { cb: onLabel } },
        });
        vi.stubGlobal("Convex", {
          asyncSyscall: () =>
            Promise.resolve(JSON.stringify("function://;callbacks:onLabel")),
        });
        const call = yield* Mount.initCall(mount, create).pipe(
          Effect.ensuring(Effect.sync(() => vi.unstubAllGlobals())),
        );
        expect(Option.map(call, ({ args }) => args)).toEqual(
          Option.some({ route: { cb: "function://;callbacks:onLabel" } }),
        );
      }),
  );
});
