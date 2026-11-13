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
    // oxlint-disable-next-line effecttsgo/global-fetch-in-effect -- The handler calls the runtime's own fetch, which the I/O bans refuse or allow.
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

const awaitTimer = (name: Timer) =>
  Effect.promise(
    () =>
      // oxlint-disable-next-line effecttsgo/new-promise -- The case waits on the runtime's own timer callback, which is what the I/O bans refuse or allow.
      new Promise<string>((resolve) => {
        (
          globalThis as unknown as Record<
            Timer,
            (callback: () => void, ms: number) => unknown
          >
        )[name](() => resolve("returned"), 10);
      }),
  );

const awaitedTimerInQuery = FunctionImpl.make(
  databaseSchema,
  ioBans,
  "awaitedTimerInQuery",
  ({ name }) => awaitTimer(name),
);

const awaitedTimerInMutation = FunctionImpl.make(
  databaseSchema,
  ioBans,
  "awaitedTimerInMutation",
  ({ name }) => awaitTimer(name),
);

const surface = () =>
  Effect.sync(() => ({
    setImmediate: typeof globalThis.setImmediate,
    queueMicrotask: typeof globalThis.queueMicrotask,
  }));

const surfaceInQuery = FunctionImpl.make(
  databaseSchema,
  ioBans,
  "surfaceInQuery",
  surface,
);

const surfaceInAction = FunctionImpl.make(
  databaseSchema,
  ioBans,
  "surfaceInAction",
  surface,
);

type FormBody = "multipart" | "urlencoded" | "multipartWithoutBoundary";

const formRequest = (body: FormBody) =>
  body === "urlencoded"
    ? new Request("https://example.com/", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "name=ada",
      })
    : new Request("https://example.com/", {
        method: "POST",
        headers: {
          "content-type":
            body === "multipart"
              ? "multipart/form-data; boundary=fence"
              : "multipart/form-data",
        },
        body: '--fence\r\nContent-Disposition: form-data; name="name"\r\n\r\nada\r\n--fence--\r\n',
      });

const parseForm = ({ body }: { readonly body: FormBody }) =>
  Effect.promise(() =>
    formRequest(body)
      .formData()
      .then(
        (form) => ({ returned: form.get("name") as string | null }),
        (error: Error) => ({ name: error.name, message: error.message }),
      ),
  );

const formDataInQuery = FunctionImpl.make(
  databaseSchema,
  ioBans,
  "formDataInQuery",
  parseForm,
);

const formDataInMutation = FunctionImpl.make(
  databaseSchema,
  ioBans,
  "formDataInMutation",
  parseForm,
);

const formDataInAction = FunctionImpl.make(
  databaseSchema,
  ioBans,
  "formDataInAction",
  parseForm,
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
    // oxlint-disable-next-line effecttsgo/global-fetch-in-effect -- The handler calls the runtime's own fetch, which the I/O bans refuse or allow.
    Effect.promise(() => fetch(url).then((response) => response.text())),
);

const timersInAction = FunctionImpl.make(
  databaseSchema,
  ioBans,
  "timersInAction",
  () =>
    // oxlint-disable-next-line effecttsgo/async-function -- A plain Convex handler is async, as product code is.
    Effect.promise(async () => {
      // oxlint-disable-next-line effecttsgo/new-promise -- The case waits on the runtime's own timer callback, which is what the I/O bans refuse or allow.
      const slept = await new Promise<string>((resolve) =>
        // oxlint-disable-next-line effecttsgo/global-timers -- The handler starts the runtime's own timer, which the I/O bans refuse or allow.
        setTimeout(() => resolve("slept"), 1),
      );
      // oxlint-disable-next-line effecttsgo/new-promise -- The case waits on the runtime's own timer callback, which is what the I/O bans refuse or allow.
      const ticked = await new Promise<string>((resolve) => {
        // oxlint-disable-next-line effecttsgo/global-timers -- The handler starts the runtime's own timer, which the I/O bans refuse or allow.
        const id = setInterval(() => {
          clearInterval(id);
          resolve("ticked");
        }, 1);
      });
      return [slept, ticked];
    }),
);

export default GroupImpl.make(databaseSchema, ioBans).pipe(
  Layer.provide(fetchInQuery),
  Layer.provide(fetchInMutation),
  Layer.provide(timerInQuery),
  Layer.provide(timerInMutation),
  Layer.provide(awaitedTimerInQuery),
  Layer.provide(awaitedTimerInMutation),
  Layer.provide(surfaceInQuery),
  Layer.provide(surfaceInAction),
  Layer.provide(formDataInQuery),
  Layer.provide(formDataInMutation),
  Layer.provide(formDataInAction),
  Layer.provide(clearInQuery),
  Layer.provide(fetchInAction),
  Layer.provide(timersInAction),
  GroupImpl.finalize,
);
