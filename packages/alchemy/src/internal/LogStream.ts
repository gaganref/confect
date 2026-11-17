import type * as DeploymentApi from "@convex-dev/platform/deploymentApi";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export type SecretField =
  | "apiKey"
  | "ddApiKey"
  | "dsn"
  | "accessKeyId"
  | "secretAccessKey";
export type RedactInput<A> = A extends unknown
  ? {
      readonly [K in keyof A]: K extends SecretField
        ? Redacted.Redacted<string> | Exclude<A[K], string>
        : A[K];
    }
  : never;
export type ReadonlyDeep<A> = A extends object
  ? { readonly [K in keyof A]: ReadonlyDeep<A[K]> }
  : A;

const Status = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["pending", "restarting", "active", "deleting"]),
  }),
  Schema.Struct({ type: Schema.Literal("failed"), reason: Schema.String }),
]);
const Topics = Schema.Array(
  Schema.Literals([
    "verification",
    "console",
    "function_execution",
    "exception",
    "audit_log",
    "scheduler_stats",
    "scheduled_job_lag",
    "current_storage_usage",
    "concurrency_stats",
    "storage_api_bandwidth",
    "ai_gateway_usage",
    "log_stream_egress",
    "custom_audit",
  ]),
).pipe(Schema.NullOr, Schema.optionalKey);
const optionalString = Schema.String.pipe(Schema.NullOr, Schema.optionalKey);
const Tags = Schema.Record(Schema.String, Schema.String).pipe(
  Schema.NullOr,
  Schema.optionalKey,
);
// IDs enter recovery errors, so reject response text outside this bounded alphabet.
const Id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_+/-]{1,128}$/));
const base = { id: Id, status: Status };
const Inclusion = Schema.Literals(["included", "excluded"]);
const TableSelection = Schema.Union([
  Schema.Literal("excluded"),
  Schema.StructWithRest(Schema.Struct({ _other: Inclusion }), [
    Schema.Record(Schema.String, Inclusion),
  ]),
]);
const ComponentSelection = Schema.Union([
  Schema.Literal("excluded"),
  Schema.StructWithRest(Schema.Struct({ _other: Inclusion }), [
    Schema.Record(Schema.String, TableSelection),
  ]),
]);
const Selection = Schema.StructWithRest(Schema.Struct({ _other: Inclusion }), [
  Schema.Record(Schema.String, ComponentSelection),
]);

export const Config = Schema.Union([
  Schema.Struct({
    ...base,
    logStreamType: Schema.Literal("datadog"),
    siteLocation: Schema.Literals([
      "US1",
      "US3",
      "US5",
      "EU",
      "US1_FED",
      "AP1",
    ]),
    ddTags: Schema.Array(Schema.String),
    service: optionalString,
    topics: Topics,
  }),
  Schema.Struct({
    ...base,
    logStreamType: Schema.Literal("webhook"),
    url: Schema.String,
    format: Schema.Literals(["json", "jsonl"]),
    hmacSecret: Schema.String,
    topics: Topics,
  }),
  Schema.Struct({
    ...base,
    logStreamType: Schema.Literal("axiom"),
    datasetName: Schema.String,
    attributes: Schema.Array(
      Schema.Struct({ key: Schema.String, value: Schema.String }),
    ),
    ingestUrl: optionalString,
    topics: Topics,
  }),
  Schema.Struct({
    ...base,
    logStreamType: Schema.Literal("sentry"),
    tags: Tags,
  }),
  Schema.Struct({
    ...base,
    logStreamType: Schema.Literal("postHogLogs"),
    host: optionalString,
    serviceName: optionalString,
    topics: Topics,
  }),
  Schema.Struct({
    ...base,
    logStreamType: Schema.Literal("postHogErrorTracking"),
    host: optionalString,
  }),
  Schema.Struct({
    ...base,
    logStreamType: Schema.Literal("s3Export"),
    bucket: Schema.String,
    region: Schema.String,
    prefix: optionalString,
    accessKeyId: Schema.String,
    period: Schema.Literals(["continuous", "hourly", "daily"]),
    selection: Selection,
  }),
]) satisfies Schema.Schema<ReadonlyDeep<DeploymentApi.LogStreamConfig>>;

export const Created = Schema.Union([
  Schema.Struct({
    logStreamType: Schema.Literal("webhook"),
    id: Id,
    hmacSecret: Schema.String,
  }),
  Schema.Struct({
    logStreamType: Schema.Literals([
      "datadog",
      "axiom",
      "sentry",
      "postHogLogs",
      "postHogErrorTracking",
      "s3Export",
    ]),
    id: Id,
  }),
]) satisfies Schema.Schema<ReadonlyDeep<DeploymentApi.CreateLogStreamResponse>>;
