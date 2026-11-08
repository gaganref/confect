import {
  Callback as CoreCallback,
  Component,
  FunctionSpec,
  Mount,
  Ref,
} from "@confect/core";
import * as Callback from "@confect/server/Callback";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { vi } from "vitest";

const internalMutation = <const Fields extends Schema.Struct.Fields>(
  name: string,
  fields: Fields,
) =>
  FunctionSpec.internalMutation({
    name,
    args: () => fields,
    returns: () => Schema.Null,
  });
const handle = (id: `probe/${string}`, fields: Schema.Struct.Fields) =>
  CoreCallback.handle(
    CoreCallback.mutation(id, {
      args: () => fields,
      returns: () => Schema.Null,
    }),
  );
const route = Schema.Union([
  Schema.Struct({ cb: handle("probe/a", { count: Schema.Finite }) }),
  Schema.Struct({ cb: handle("probe/b", { label: Schema.String }) }),
]);
const Probe = Component.make("probe", {
  init: Ref.make("install", internalMutation("init", { route })),
  client: (native: unknown) => native,
});
const onLabel = Ref.make(
  "callbacks",
  internalMutation("onLabel", { label: Schema.String }),
);

it.effect(
  "Mount.initCall makes the handle for the union member whose contract the target satisfies",
  () =>
    Effect.gen(function* () {
      const mount = Mount.make(Probe, {
        name: "probe",
        args: { route: { cb: onLabel } },
      });
      vi.stubGlobal("Convex", {
        asyncSyscall: () =>
          Promise.resolve(JSON.stringify("function://;callbacks:onLabel")),
      });
      const call = yield* Mount.initCall(mount, (contract, ref) =>
        Callback.create(contract, ref as never),
      ).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllGlobals())));
      expect(Option.map(call, ({ args }) => args)).toEqual(
        Option.some({ route: { cb: "function://;callbacks:onLabel" } }),
      );
    }),
);
