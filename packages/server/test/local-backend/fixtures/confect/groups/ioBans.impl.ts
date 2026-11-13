// oxlint-disable effecttsgo/global-fetch-in-effect, effecttsgo/global-timers, effecttsgo/new-promise, effecttsgo/async-function -- These handlers call the runtime's own fetch and timers, which is what the I/O bans refuse or allow.
import { FunctionImpl, GroupImpl } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import databaseSchema from "../_generated/schema";
import ioBans from "./ioBans.spec";

// These handlers call the runtime's globals directly, as the test kernel's
// `IoBans.test.ts` does, so the binary answers the same calls.

type Timer = "setTimeout" | "setInterval";

const startTimer = (name: Timer) =>
  (
    globalThis as unknown as Record<
      Timer,
      (callback: () => void, ms: number) => unknown
    >
  )[name](() => {}, 0);

const rejectionOf = (url: string) =>
  Effect.promise(() =>
    fetch(url).then(
      () => ({ name: "none", message: "fetched" }),
      (error: Error) => ({ name: error.name, message: error.message }),
    ),
  );

const fetchInQuery = FunctionImpl.make(
  databaseSchema,
  ioBans,
  "fetchInQuery",
  ({ url }) => rejectionOf(url),
);

const fetchInMutation = FunctionImpl.make(
  databaseSchema,
  ioBans,
  "fetchInMutation",
  ({ url }) => rejectionOf(url),
);

const timerInQuery = FunctionImpl.make(
  databaseSchema,
  ioBans,
  "timerInQuery",
  ({ name }) =>
    Effect.sync(() => {
      startTimer(name);
      return "returned";
    }),
);

const timerInMutation = FunctionImpl.make(
  databaseSchema,
  ioBans,
  "timerInMutation",
  ({ name }) =>
    Effect.sync(() => {
      startTimer(name);
      return "returned";
    }),
);

const immediateInQuery = FunctionImpl.make(
  databaseSchema,
  ioBans,
  "immediateInQuery",
  () => Effect.sync(() => typeof globalThis.setImmediate),
);

const clearInQuery = FunctionImpl.make(
  databaseSchema,
  ioBans,
  "clearInQuery",
  () =>
    Effect.sync(() => {
      clearTimeout(1);
      clearInterval(1);
      return "cleared";
    }),
);

const fetchInAction = FunctionImpl.make(
  databaseSchema,
  ioBans,
  "fetchInAction",
  ({ url }) =>
    Effect.promise(() => fetch(url).then((response) => response.text())),
);

const timersInAction = FunctionImpl.make(
  databaseSchema,
  ioBans,
  "timersInAction",
  () =>
    Effect.promise(async () => {
      const slept = await new Promise<string>((resolve) =>
        setTimeout(() => resolve("slept"), 1),
      );
      const ticked = await new Promise<string>((resolve) => {
        const id = setInterval(() => {
          clearInterval(id);
          resolve("ticked");
        }, 1);
      });
      return [slept, ticked, typeof globalThis.setImmediate];
    }),
);

export default GroupImpl.make(databaseSchema, ioBans).pipe(
  Layer.provide(fetchInQuery),
  Layer.provide(fetchInMutation),
  Layer.provide(timerInQuery),
  Layer.provide(timerInMutation),
  Layer.provide(immediateInQuery),
  Layer.provide(clearInQuery),
  Layer.provide(fetchInAction),
  Layer.provide(timersInAction),
  GroupImpl.finalize,
);
