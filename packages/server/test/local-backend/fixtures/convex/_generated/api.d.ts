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

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: {
  egressNode: {
    rawFetchNode: FunctionReference<
      "action",
      "public",
      { url: string },
      string
    >;
  };
  groups: {
    cacheControl: {
      control: FunctionReference<"query", "public", {}, any>;
    };
    cacheStubbed: {
      confectNoTime: FunctionReference<"query", "public", {}, number>;
      confectWithClock: FunctionReference<"query", "public", {}, number>;
      confectWithLog: FunctionReference<"query", "public", {}, number>;
      confectWithRawDateNow: FunctionReference<"query", "public", {}, number>;
      confectWithSpan: FunctionReference<"query", "public", {}, number>;
    };
    callbacks: {
      breach: FunctionReference<
        "mutation",
        "public",
        { id: string },
        "success" | "failure" | "defect"
      >;
      createMismatched: FunctionReference<
        "mutation",
        "public",
        {},
        { message: string; outcome: "success" | "failure" | "defect" }
      >;
      createRetired: FunctionReference<
        "mutation",
        "public",
        {},
        { message: string; outcome: "success" | "failure" | "defect" }
      >;
      events: FunctionReference<
        "query",
        "public",
        { run: string },
        Array<"queued" | "sent" | "delivered" | "bounced">
      >;
      get: FunctionReference<
        "query",
        "public",
        { id: string },
        { run: string; status: "queued" | "sent" | "delivered" | "bounced" }
      >;
      sameHandle: FunctionReference<
        "mutation",
        "public",
        { id: string },
        boolean
      >;
      send: FunctionReference<"mutation", "public", { run: string }, string>;
      setStatus: FunctionReference<
        "mutation",
        "public",
        { id: string; status: "queued" | "sent" | "delivered" | "bounced" },
        string | null
      >;
      storeMalformed: FunctionReference<
        "mutation",
        "public",
        { run: string },
        string
      >;
    };
    commitTs: {
      maxAfterPending: FunctionReference<
        "mutation",
        "public",
        { caseId: string },
        { stored: "placeholder" | "bigint"; value: string; written: number }
      >;
      newestFirst: FunctionReference<
        "query",
        "public",
        { caseId: string },
        Array<{
          at: bigint | import("convex/values").CommitTsPlaceholder;
          label: string;
        }>
      >;
      stamp: FunctionReference<
        "mutation",
        "public",
        { caseId: string; label: string },
        "placeholder" | "bigint"
      >;
    };
    componentAuthoring: {
      probe: FunctionReference<
        "query",
        "public",
        { value: string },
        { value: string }
      >;
      read: FunctionReference<
        "query",
        "public",
        { id: string },
        { scheduled: string; storage: string }
      >;
      render: FunctionReference<"query", "public", { value: string }, string>;
      save: FunctionReference<
        "mutation",
        "public",
        { scheduled: string; storage: string },
        string
      >;
    };
    components: {
      cancel: FunctionReference<"mutation", "public", { id: string }, null>;
      declaredError: FunctionReference<
        "mutation",
        "public",
        { run: string },
        {
          instance: boolean;
          remaining: Array<number>;
          run: string;
          tag: "Rejected";
        }
      >;
      deepCreate: FunctionReference<
        "mutation",
        "public",
        { count: number; installation: "left" | "right"; run: string },
        null
      >;
      deepRead: FunctionReference<
        "query",
        "public",
        { installation: "left" | "right"; run: string },
        { counts: Array<number>; path: string }
      >;
      environment: FunctionReference<
        "query",
        "public",
        {},
        {
          first: {
            directRequired: string;
            hostOnly: string;
            marker: string;
            optional: string;
            required: string;
            unbound: string;
          };
          host: { hostOnly: string; marker: string };
          second: {
            directRequired: string;
            hostOnly: string;
            marker: string;
            optional: string;
            required: string;
            unbound: string;
          };
        }
      >;
      exercise: FunctionReference<
        "mutation",
        "public",
        { run: string },
        {
          first: Array<number>;
          left: Array<number>;
          rejectedId: string;
          right: Array<number>;
          second: Array<number>;
        }
      >;
      hasAuth: FunctionReference<"query", "public", {}, boolean>;
      list: FunctionReference<
        "query",
        "public",
        { run: string },
        { first: Array<number>; second: Array<number> }
      >;
      page: FunctionReference<
        "query",
        "public",
        { cursor: string | null; numItems: number; run: string },
        { continueCursor: string; isDone: boolean; page: Array<number> }
      >;
      schedule: FunctionReference<
        "mutation",
        "public",
        { run: string },
        string
      >;
      scheduleAndCancel: FunctionReference<
        "mutation",
        "public",
        { run: string },
        { after: string; at: string; control: string }
      >;
      seed: FunctionReference<
        "mutation",
        "public",
        { counts: Array<number>; run: string },
        null
      >;
      storageUrl: FunctionReference<"query", "public", { id: string }, string>;
      ticks: FunctionReference<
        "query",
        "public",
        {},
        { first: number; second: number }
      >;
      uploadUrl: FunctionReference<"mutation", "public", {}, string>;
    };
    ioBans: {
      awaitedTimerInMutation: FunctionReference<
        "mutation",
        "public",
        { name: "setTimeout" | "setInterval" },
        string
      >;
      awaitedTimerInQuery: FunctionReference<
        "query",
        "public",
        { name: "setTimeout" | "setInterval" },
        string
      >;
      clearInQuery: FunctionReference<"query", "public", {}, string>;
      fetchInAction: FunctionReference<
        "action",
        "public",
        { url: string },
        string
      >;
      fetchInMutation: FunctionReference<
        "mutation",
        "public",
        { url: string },
        { message: string; name: string }
      >;
      fetchInQuery: FunctionReference<
        "query",
        "public",
        { url: string },
        { message: string; name: string }
      >;
      formDataInAction: FunctionReference<
        "action",
        "public",
        { body: "multipart" | "urlencoded" | "multipartWithoutBoundary" },
        { returned: string | null } | { message: string; name: string }
      >;
      formDataInMutation: FunctionReference<
        "mutation",
        "public",
        { body: "multipart" | "urlencoded" | "multipartWithoutBoundary" },
        { returned: string | null } | { message: string; name: string }
      >;
      formDataInQuery: FunctionReference<
        "query",
        "public",
        { body: "multipart" | "urlencoded" | "multipartWithoutBoundary" },
        { returned: string | null } | { message: string; name: string }
      >;
      surfaceInAction: FunctionReference<
        "action",
        "public",
        {},
        { queueMicrotask: string; setImmediate: string }
      >;
      surfaceInQuery: FunctionReference<
        "query",
        "public",
        {},
        { queueMicrotask: string; setImmediate: string }
      >;
      timerInMutation: FunctionReference<
        "mutation",
        "public",
        { name: "setTimeout" | "setInterval" },
        string
      >;
      timerInQuery: FunctionReference<
        "query",
        "public",
        { name: "setTimeout" | "setInterval" },
        string
      >;
      timersInAction: FunctionReference<"action", "public", {}, Array<string>>;
    };
    metadata: {
      actionMetadata: FunctionReference<
        "action",
        "public",
        {},
        {
          deploymentName: string;
          functionName: string;
          functionType: string;
          ip: string | null;
          requestId: string;
          scheduledFunctionId: string | null;
        }
      >;
      mutationMetadata: FunctionReference<
        "mutation",
        "public",
        {},
        {
          deploymentName: string;
          functionName: string;
          functionType: string;
          ip: string | null;
          remainingWrites: number;
          requestId: string;
          scheduledFunctionId: string | null;
        }
      >;
      queryMetadata: FunctionReference<
        "query",
        "public",
        {},
        {
          deploymentName: string;
          functionName: string;
          functionType: string;
          remainingReads: number;
        }
      >;
    };
    mounts: {
      counts: FunctionReference<
        "query",
        "public",
        { mount: "first" | "second"; run: string },
        Array<number>
      >;
      create: FunctionReference<
        "mutation",
        "public",
        { count: number; mount: "first" | "second"; run: string },
        null
      >;
      replaced: FunctionReference<
        "query",
        "public",
        { run: string },
        { inside: Array<number>; outside: Array<number> }
      >;
    };
    nativeComponents: {
      roundTrip: FunctionReference<"mutation", "public", { run: string }, any>;
    };
    pagination: {
      hook: FunctionReference<
        "mutation",
        "public",
        { run: string },
        Array<{ count: number; operation: string }>
      >;
      page: FunctionReference<
        "query",
        "public",
        { cursor: string | null; numItems: number; run: string },
        { continueCursor: string; isDone: boolean; page: Array<number> }
      >;
      searchPage: FunctionReference<
        "query",
        "public",
        { cursor: string | null; numItems: number; run: string },
        { continueCursor: string; isDone: boolean; page: Array<number> }
      >;
      streams: FunctionReference<
        "query",
        "public",
        { run: string },
        { budget: number; deferred: Array<number>; merged: Array<number> }
      >;
      twice: FunctionReference<
        "query",
        "public",
        { cursor: string | null; numItems: number; run: string },
        null
      >;
    };
    reserved: {
      chain: FunctionReference<
        "action",
        "public",
        { context?: any; run: string },
        {
          action: {
            args: { run: string };
            received: {
              deployment: string | null;
              requestId: string;
              value: any;
            };
          };
          hops: Record<string, string>;
          inline: {
            child: {
              args: { run: string };
              received: {
                deployment: string | null;
                requestId: string;
                value: any;
              };
            };
            hops: Record<string, string>;
            parent: {
              args: { run: string };
              received: {
                deployment: string | null;
                requestId: string;
                value: any;
              };
            };
            plain: string;
          };
          jobId: string;
          mutation: {
            args: { run: string };
            received: {
              deployment: string | null;
              requestId: string;
              value: any;
            };
          };
        }
      >;
      echo: FunctionReference<
        "mutation",
        "public",
        { context?: any; run: string },
        {
          args: { run: string };
          received: {
            deployment: string | null;
            requestId: string;
            value: any;
          };
        }
      >;
      echoAction: FunctionReference<
        "action",
        "public",
        { context?: any; run: string },
        {
          args: { run: string };
          received: {
            deployment: string | null;
            requestId: string;
            value: any;
          };
        }
      >;
      inline: FunctionReference<
        "mutation",
        "public",
        { context?: any; run: string },
        {
          child: {
            args: { run: string };
            received: {
              deployment: string | null;
              requestId: string;
              value: any;
            };
          };
          hops: Record<string, string>;
          parent: {
            args: { run: string };
            received: {
              deployment: string | null;
              requestId: string;
              value: any;
            };
          };
          plain: string;
        }
      >;
      read: FunctionReference<
        "query",
        "public",
        { run: string },
        {
          args: { run: string };
          received: {
            deployment: string | null;
            requestId: string;
            value: any;
          };
        } | null
      >;
      write: FunctionReference<
        "mutation",
        "public",
        { context?: any; run: string },
        null
      >;
    };
    scheduling: {
      manyOpsMutation: FunctionReference<"mutation", "public", {}, number>;
      manyOpsQuery: FunctionReference<"query", "public", {}, number>;
    };
    storage: {
      deleteBlob: FunctionReference<
        "mutation",
        "public",
        { storageId: Id<"_storage"> },
        null
      >;
      generateUploadUrl: FunctionReference<"mutation", "public", {}, string>;
      get: FunctionReference<
        "action",
        "public",
        { storageId: Id<"_storage"> },
        string
      >;
      getUrl: FunctionReference<
        "query",
        "public",
        { storageId: Id<"_storage"> },
        string
      >;
      store: FunctionReference<
        "action",
        "public",
        { text: string },
        Id<"_storage">
      >;
    };
    transactions: {
      insertedIntervals: FunctionReference<
        "mutation",
        "public",
        { caseId: string; count: number },
        { afterGet: number; afterInserts: number; afterScan: number }
      >;
      limitedRead: FunctionReference<
        "query",
        "public",
        { caseId: string; limit: number },
        Array<string>
      >;
      limitedReadFromMutation: FunctionReference<
        "mutation",
        "public",
        { caseId: string; limit: number },
        Array<string>
      >;
      limitedWrite: FunctionReference<
        "mutation",
        "public",
        { caseId: string; limit: number },
        null
      >;
      metrics: FunctionReference<
        "mutation",
        "public",
        { caseId: string },
        {
          end: Record<string, { remaining: number; used: number }>;
          start: Record<string, { remaining: number; used: number }>;
        }
      >;
      rollback: FunctionReference<
        "mutation",
        "public",
        { caseId: string },
        boolean
      >;
      seed: FunctionReference<
        "mutation",
        "public",
        { caseId: string; count: number },
        null
      >;
      staleMetrics: FunctionReference<
        "mutation",
        "public",
        {},
        Record<string, { remaining: number; used: number }>
      >;
      staleRead: FunctionReference<
        "mutation",
        "public",
        { caseId: string; stale: boolean },
        Array<string>
      >;
    };
  };
  ioBansNode: {
    surfaceNode: FunctionReference<
      "action",
      "public",
      {},
      { queueMicrotask: string; setImmediate: string }
    >;
  };
  metadataNode: {
    metadata: FunctionReference<
      "action",
      "public",
      {},
      {
        deploymentName: string;
        functionName: string;
        functionType: string;
        ip: string | null;
        requestId: string;
        scheduledFunctionId: string | null;
      }
    >;
  };
};

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: {
  groups: {
    callbacks: {
      onEvent: FunctionReference<
        "mutation",
        "internal",
        { run: string; status: "queued" | "sent" | "delivered" | "bounced" },
        null
      >;
    };
    transactions: {
      idle: FunctionReference<"mutation", "internal", {}, null>;
      read: FunctionReference<
        "query",
        "internal",
        { caseId: string },
        Array<string>
      >;
      readMetrics: FunctionReference<
        "query",
        "internal",
        {},
        Record<string, { remaining: number; used: number }>
      >;
      write: FunctionReference<
        "mutation",
        "internal",
        { caseId: string; fail: boolean; value: string },
        null
      >;
    };
  };
};

export declare const components: {
  first: import("../../components/counter/convex/_generated/component.js").ComponentApi<"first">;
  second: import("../../components/counter/convex/_generated/component.js").ComponentApi<"second">;
  left: import("../../components/parent/convex/_generated/component.js").ComponentApi<"left">;
  right: import("../../components/parent/convex/_generated/component.js").ComponentApi<"right">;
};
