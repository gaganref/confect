/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";
import type { GenericId as Id } from "convex/values";
import { anyApi, componentsGeneric } from "convex/server";

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api: {
  authoring: {
    probe: FunctionReference<
      "query",
      "public",
      { value: string },
      { value: string }
    >;
    read: FunctionReference<
      "query",
      "public",
      { id: Id<"systemIds"> },
      { scheduled: Id<"_scheduled_functions">; storage: Id<"_storage"> }
    >;
    save: FunctionReference<
      "mutation",
      "public",
      { scheduled: Id<"_scheduled_functions">; storage: Id<"_storage"> },
      Id<"systemIds">
    >;
  };
  counter: {
    cancel: FunctionReference<"mutation", "public", { id: string }, null>;
    create: FunctionReference<
      "mutation",
      "public",
      { count: string; run: string },
      Id<"counters">
    >;
    environment: FunctionReference<
      "query",
      "public",
      {},
      {
        directRequired: string;
        hostOnly: string;
        marker: string;
        optional: string;
        required: string;
        unbound: string;
      }
    >;
    hasAuth: FunctionReference<"query", "public", {}, boolean>;
    list: FunctionReference<
      "query",
      "public",
      { run: string },
      Array<{
        _creationTime: number;
        _id: Id<"counters">;
        count: string;
        run: string;
      }>
    >;
    location: FunctionReference<"query", "public", {}, string>;
    page: FunctionReference<
      "query",
      "public",
      { cursor: string | null; numItems: number; run: string },
      {
        continueCursor: string;
        isDone: boolean;
        page: Array<{
          _creationTime: number;
          _id: Id<"counters">;
          count: string;
          run: string;
        }>;
      }
    >;
    reject: FunctionReference<"mutation", "public", { run: string }, null>;
    schedule: FunctionReference<
      "mutation",
      "public",
      { count: string; run: string },
      Id<"_scheduled_functions">
    >;
    scheduleAndCancel: FunctionReference<
      "mutation",
      "public",
      { run: string },
      {
        after: Id<"_scheduled_functions">;
        at: Id<"_scheduled_functions">;
        control: Id<"_scheduled_functions">;
      }
    >;
    storageUrl: FunctionReference<
      "query",
      "public",
      { id: Id<"_storage"> },
      string
    >;
    ticks: FunctionReference<"query", "public", {}, number>;
    uploadUrl: FunctionReference<"mutation", "public", {}, string>;
  };
  deliveries: {
    breach: FunctionReference<
      "mutation",
      "public",
      { id: Id<"deliveries"> },
      "success" | "failure" | "defect"
    >;
    get: FunctionReference<
      "query",
      "public",
      { id: Id<"deliveries"> },
      {
        onEvent: string;
        run: string;
        status: "queued" | "sent" | "delivered" | "bounced";
      }
    >;
    send: FunctionReference<
      "mutation",
      "public",
      { onEvent: string; run: string },
      Id<"deliveries">
    >;
    setStatus: FunctionReference<
      "mutation",
      "public",
      {
        id: Id<"deliveries">;
        status: "queued" | "sent" | "delivered" | "bounced";
      },
      string | null
    >;
  };
} = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export const internal: {
  counter: {
    createInternal: FunctionReference<
      "mutation",
      "internal",
      { count: string; run: string },
      Id<"counters">
    >;
    tick: FunctionReference<"mutation", "internal", {}, null>;
  };
  deliveries: {
    deliver: FunctionReference<
      "mutation",
      "internal",
      { id: Id<"deliveries"> },
      null
    >;
  };
} = anyApi as any;

export const components = componentsGeneric() as unknown as {};
