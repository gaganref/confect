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
  clients: {
    echoAction: FunctionReference<
      "action",
      "public",
      { failure?: "typed" | "unknown"; value?: string },
      any
    >;
    echoMutation: FunctionReference<
      "mutation",
      "public",
      { failure?: "typed" | "unknown"; value?: string },
      any
    >;
    echoQuery: FunctionReference<
      "query",
      "public",
      { failure?: "typed" | "unknown"; value?: string },
      any
    >;
    read: FunctionReference<"query", "public", { caseId: string }, any>;
    write: FunctionReference<
      "mutation",
      "public",
      { caseId: string; value: string | null },
      any
    >;
  };
  groups: {
    authentication: {
      sign: FunctionReference<
        "mutation",
        "public",
        {
          aud: string | Array<string>;
          expiresInSeconds: number;
          extraClaims?: Record<
            string,
            | string
            | number
            | boolean
            | null
            | Array<string>
            | { count: number; enabled: boolean; optional: null }
          >;
        },
        string
      >;
      signInMiddleware: FunctionReference<"mutation", "public", {}, string>;
    };
    cacheControl: {
      control: FunctionReference<"query", "public", {}, any>;
      snapshot: FunctionReference<"query", "public", {}, any>;
    };
    cacheStubbed: {
      confectNoTime: FunctionReference<"query", "public", {}, number>;
      confectWithClock: FunctionReference<"query", "public", {}, number>;
      confectWithLog: FunctionReference<"query", "public", {}, number>;
      confectWithRawDateNow: FunctionReference<"query", "public", {}, number>;
      confectWithSnapshot: FunctionReference<"query", "public", {}, bigint>;
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
    componentIdentity: {
      fromAction: FunctionReference<"action", "public", {}, any>;
      fromMutation: FunctionReference<"mutation", "public", {}, any>;
      fromQuery: FunctionReference<"query", "public", {}, any>;
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
            app: string;
            chain: string;
            directRequired: string;
            drawn: number;
            hostOnly: string;
            loaded: string;
            marker: string;
            optional: string;
            outside: string;
            outsideDrawn: number;
            required: string;
            unbound: string;
          };
          host: { hostOnly: string; marker: string };
          second: {
            app: string;
            chain: string;
            directRequired: string;
            drawn: number;
            hostOnly: string;
            loaded: string;
            marker: string;
            optional: string;
            outside: string;
            outsideDrawn: number;
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
      identity: FunctionReference<"query", "public", {}, any>;
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
    contextReuse: {
      read: FunctionReference<
        "query",
        "public",
        { caseId: string; nonce: number },
        {
          functionType: string;
          previousInvocation: { nonce: number; subject: string | null } | null;
          subject: string | null;
          values: Array<string>;
        }
      >;
      write: FunctionReference<
        "mutation",
        "public",
        { caseId: string; nonce: number; value: string },
        {
          functionType: string;
          previousInvocation: { nonce: number; subject: string | null } | null;
          previousValues: Array<string>;
          subject: string | null;
          values: Array<string>;
        }
      >;
    };
    documentIds: {
      createAndDelete: FunctionReference<
        "mutation",
        "public",
        {},
        Id<"transactionNotes">
      >;
      inspect: FunctionReference<
        "query",
        "public",
        {
          input: string;
          table: "transactionNotes" | "_storage" | "_scheduled_functions";
        },
        {
          identified: { id: string; table: string } | null;
          parsed: string | null;
        }
      >;
      inspectFromMutation: FunctionReference<
        "mutation",
        "public",
        {
          input: string;
          table: "transactionNotes" | "_storage" | "_scheduled_functions";
        },
        {
          identified: { id: string; table: string } | null;
          parsed: string | null;
        }
      >;
      nativeSampleId: FunctionReference<
        "query",
        "public",
        {
          input: string;
          table: "transactionNotes" | "_storage" | "_scheduled_functions";
        },
        string | null
      >;
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
          nestedMutationAfterWriteTs: bigint;
          nestedMutationTs: bigint;
          nestedQueryTs: bigint;
          remainingWrites: number;
          repeatedSnapshotTs: bigint;
          requestId: string;
          scheduledFunctionId: string | null;
          snapshotTs: bigint;
          staleQueryTs: bigint;
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
          repeatedSnapshotTs: bigint;
          snapshotTs: bigint;
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
    randomness: {
      action: FunctionReference<
        "action",
        "public",
        {},
        {
          detachedFill: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          digest: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          floatFill: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          generateKey: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          getRandomValues: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          largestFill: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          loadGenerateKey: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          loadGetRandomValues: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          loadMathRandom: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          loadRandomUUID: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          mathRandom: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          oversizedFill: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          randomUUID: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
        }
      >;
      mutation: FunctionReference<
        "mutation",
        "public",
        {},
        {
          detachedFill: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          digest: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          floatFill: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          generateKey: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          getRandomValues: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          largestFill: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          loadGenerateKey: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          loadGetRandomValues: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          loadMathRandom: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          loadRandomUUID: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          mathRandom: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          oversizedFill: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          randomUUID: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
        }
      >;
      query: FunctionReference<
        "query",
        "public",
        {},
        {
          detachedFill: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          digest: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          floatFill: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          generateKey: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          getRandomValues: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          largestFill: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          loadGenerateKey: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          loadGetRandomValues: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          loadMathRandom: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          loadRandomUUID: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          mathRandom: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          oversizedFill: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
          randomUUID: {
            message: string | null;
            name: string | null;
            permitted: boolean;
            value: Array<number>;
          };
        }
      >;
    };
    requests: {
      action: FunctionReference<
        "action",
        "public",
        {},
        {
          action: {
            authToken: string | null;
            ip: string | null;
            requestId: string;
            scheduledFunctionId: string | null;
            subject: string | null;
            userAgent: string | null;
          };
          mutation: {
            authToken: string | null;
            ip: string | null;
            requestId: string;
            scheduledFunctionId: string | null;
            subject: string | null;
            userAgent: string | null;
          };
          own: {
            authToken: string | null;
            ip: string | null;
            requestId: string;
            scheduledFunctionId: string | null;
            subject: string | null;
            userAgent: string | null;
          };
        }
      >;
      mutation: FunctionReference<
        "mutation",
        "public",
        {},
        {
          nested: {
            authToken: string | null;
            ip: string | null;
            requestId: string;
            scheduledFunctionId: string | null;
            subject: string | null;
            userAgent: string | null;
          };
          own: {
            authToken: string | null;
            ip: string | null;
            requestId: string;
            scheduledFunctionId: string | null;
            subject: string | null;
            userAgent: string | null;
          };
        }
      >;
      recorded: FunctionReference<
        "query",
        "public",
        { caseId: string },
        Array<string>
      >;
      schedule: FunctionReference<
        "mutation",
        "public",
        { caseId: string },
        {
          actionJob: string;
          mutationJob: string;
          own: {
            authToken: string | null;
            ip: string | null;
            requestId: string;
            scheduledFunctionId: string | null;
            subject: string | null;
            userAgent: string | null;
          };
        }
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
      deleteAndGet: FunctionReference<
        "mutation",
        "public",
        { storageId: Id<"_storage"> },
        { id: string; tag: "BlobNotFoundError" }
      >;
      deleteBlob: FunctionReference<
        "mutation",
        "public",
        { storageId: Id<"_storage"> },
        null
      >;
      deleteRaw: FunctionReference<
        "mutation",
        "public",
        { storageId: Id<"_storage"> },
        null
      >;
      describe: FunctionReference<
        "query",
        "public",
        { storageId: Id<"_storage"> },
        string
      >;
      fileProbe: FunctionReference<
        "mutation",
        "public",
        {
          count: number;
          fileReadBytes: number;
          fileWriteBytes: number;
          filesRead: number;
          filesWritten: number;
          ids: Array<Id<"_storage">>;
          nested: boolean;
          size: number;
        },
        string
      >;
      generateUploadUrl: FunctionReference<"mutation", "public", {}, string>;
      get: FunctionReference<
        "action",
        "public",
        { storageId: Id<"_storage"> },
        string
      >;
      getMutation: FunctionReference<
        "mutation",
        "public",
        { storageId: Id<"_storage"> },
        { size: number; storageId: Id<"_storage">; text: string; type: string }
      >;
      getUrl: FunctionReference<
        "query",
        "public",
        { storageId: Id<"_storage"> },
        string
      >;
      limitedFiles: FunctionReference<
        "mutation",
        "public",
        {
          limits: {
            fileReadBytes: number;
            fileWriteBytes: number;
            filesRead: number;
            filesWritten: number;
          };
          sizes: Array<number>;
          storageIds: Array<Id<"_storage">>;
        },
        {
          failures: Array<string>;
          metrics: {
            fileReadBytes: number;
            fileWriteBytes: number;
            filesRead: number;
            filesWritten: number;
          };
          storageIds: Array<Id<"_storage">>;
        }
      >;
      rollback: FunctionReference<
        "mutation",
        "public",
        { readId: Id<"_storage"> },
        {
          metrics: {
            fileReadBytes: number;
            fileWriteBytes: number;
            filesRead: number;
            filesWritten: number;
          };
          parentId: Id<"_storage">;
          rolledBackId: Id<"_storage">;
        }
      >;
      staleRead: FunctionReference<
        "mutation",
        "public",
        { stale: boolean },
        { storageId: Id<"_storage">; text: string; url: string | null }
      >;
      store: FunctionReference<
        "action",
        "public",
        { text: string },
        Id<"_storage">
      >;
      storeInMutation: FunctionReference<
        "mutation",
        "public",
        { contentType: string; text: string },
        string
      >;
      storeMutation: FunctionReference<
        "mutation",
        "public",
        { sha256?: string; text: string; type: string },
        { size: number; storageId: Id<"_storage">; text: string; type: string }
      >;
      storeWith: FunctionReference<
        "action",
        "public",
        { contentType: string; sha256: string; text: string },
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
    metadata: {
      snapshotMutation: FunctionReference<
        "mutation",
        "internal",
        {},
        { after: bigint; before: bigint }
      >;
    };
    requests: {
      read: FunctionReference<
        "mutation",
        "internal",
        {},
        {
          authToken: string | null;
          ip: string | null;
          requestId: string;
          scheduledFunctionId: string | null;
          subject: string | null;
          userAgent: string | null;
        }
      >;
      readAction: FunctionReference<
        "action",
        "internal",
        {},
        {
          authToken: string | null;
          ip: string | null;
          requestId: string;
          scheduledFunctionId: string | null;
          subject: string | null;
          userAgent: string | null;
        }
      >;
      record: FunctionReference<
        "mutation",
        "internal",
        { caseId: string; value: string },
        null
      >;
      scheduledAction: FunctionReference<
        "action",
        "internal",
        { caseId: string },
        null
      >;
      scheduledMutation: FunctionReference<
        "mutation",
        "internal",
        { caseId: string },
        null
      >;
    };
    storage: {
      exerciseFiles: FunctionReference<
        "mutation",
        "internal",
        { sizes: Array<number>; storageIds: Array<Id<"_storage">> },
        {
          failures: Array<string>;
          metrics: {
            fileReadBytes: number;
            fileWriteBytes: number;
            filesRead: number;
            filesWritten: number;
          };
          storageIds: Array<Id<"_storage">>;
        }
      >;
      pendingUrl: FunctionReference<
        "query",
        "internal",
        { storageId: Id<"_storage"> },
        string | null
      >;
      replaceThenFail: FunctionReference<
        "mutation",
        "internal",
        { parentId: Id<"_storage">; readId: Id<"_storage"> },
        Id<"_storage">
      >;
      storeAndRead: FunctionReference<
        "mutation",
        "internal",
        { count: number; ids: Array<Id<"_storage">>; size: number },
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
