import type * as DeploymentApi from "@convex-dev/platform/deploymentApi";
import type * as ManagementApi from "@convex-dev/platform/managementApi";
import type { ProviderMode } from "alchemy/ProviderMode";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Loopback from "./internal/Loopback.js";
import * as LogStream from "./internal/LogStream.js";
import * as String from "effect/String";
import { pipe } from "effect/Function";
import * as Array from "effect/Array";
import * as Rec from "effect/Record";
import * as Option from "effect/Option";
import { credentialsHint, ManagementToken } from "./internal/AuthProvider.js";
import * as Redaction from "./internal/Redaction.js";

export type Project = ManagementApi.ProjectResponse;
export type CreatedProject = ManagementApi.PlatformCreateProjectResponse;
export type Deployment = ManagementApi.PlatformDeploymentResponse;
export type DeployKey = Omit<
  ManagementApi.PlatformDeployKeyResponse,
  "allowedActions"
> & {
  readonly allowedActions: readonly string[];
};
/**
 * What `GET /token_details` says of the management login: a team token or a
 * project token. It shows the login's scope, not where the login came from: a
 * dashboard team access token and a team-scoped OAuth token both answer
 * `teamToken`.
 */
export type TokenDetails =
  | Pick<
      Extract<
        ManagementApi.PlatformTokenDetailsResponse,
        { type: "teamToken" }
      >,
      "type" | "teamId"
    >
  | Pick<
      Extract<
        ManagementApi.PlatformTokenDetailsResponse,
        { type: "projectToken" }
      >,
      "type" | "projectId"
    >;
export type CreateProjectInput = Pick<
  ManagementApi.PlatformCreateProjectArgs,
  "projectName"
>;
export type UpdateProjectInput = Pick<
  ManagementApi.PlatformUpdateProjectArgs,
  "name"
>;
export type CreateDeploymentInput = Pick<
  ManagementApi.PlatformCreateDeploymentArgs,
  "type" | "region" | "class" | "expiresAt"
> & { readonly reference: string };
export type UpdateDeploymentInput = Pick<
  ManagementApi.PlatformUpdateDeploymentArgs,
  "reference" | "expiresAt" | "sendLogsToClient" | "class"
>;
export type CreateDeployKeyInput = ManagementApi.PlatformCreateDeployKeyArgs;
export type CreatedDeployKey = {
  readonly deployKey: Redacted.Redacted<
    ManagementApi.PlatformCreateDeployKeyResponse["deployKey"]
  >;
};
export type EnvironmentVariableChange = Omit<
  DeploymentApi.UpdateEnvVarRequest,
  "value"
> & {
  readonly value?:
    | Exclude<DeploymentApi.UpdateEnvVarRequest["value"], undefined>
    | Redacted.Redacted<string>;
};
export type EnvironmentVariables = Readonly<
  Record<
    string,
    Redacted.Redacted<
      DeploymentApi.ListEnvVarsResponse["environmentVariables"][string]
    >
  >
>;

export type CustomDomain = ManagementApi.PlatformCustomDomainResponse;
export type CustomDomainInput = ManagementApi.PlatformDeleteCustomDomainArgs;
export type CanonicalUrls = DeploymentApi.GetCanonicalUrlsResponse;
export type UpdateCanonicalUrlInput = DeploymentApi.UpdateCanonicalUrlRequest;

const CustomDomainSchema = Schema.Struct({
  deploymentName: Schema.String,
  domain: Schema.String,
  requestDestination: Schema.Literals(["convexCloud", "convexSite"]),
  creationTime: Schema.Finite,
  verificationTime: Schema.Finite.pipe(Schema.NullOr, Schema.optionalKey),
}) satisfies Schema.Schema<CustomDomain>;

const CanonicalUrlsSchema = Schema.Struct({
  convexCloudUrl: Schema.String,
  convexSiteUrl: Schema.String,
}) satisfies Schema.Schema<CanonicalUrls>;
export type CreateLogStreamInput = LogStream.RedactInput<
  LogStream.ReadonlyDeep<DeploymentApi.CreateLogStreamArgs>
>;
export type UpdateLogStreamInput = LogStream.RedactInput<
  LogStream.ReadonlyDeep<DeploymentApi.UpdateLogStreamArgs>
>;
export type LogStreamConfig = Redacted.Redacted<typeof LogStream.Config.Type>;
export type CreatedLogStream = Redacted.Redacted<typeof LogStream.Created.Type>;

const logStreamBody = (input: Readonly<Record<string, unknown>>) =>
  Rec.map(input, (value) =>
    Redacted.isRedacted(value) ? Redacted.value(value) : value,
  );

export type UsageLimit = DeploymentApi.UsageLimitConfigResponse;
export type UsageLimitInput = DeploymentApi.UsageLimitConfigRequest;

const UsageLimitSchema = Schema.Struct({
  id: Schema.String,
  metric: Schema.Literals([
    "functionCalls",
    "databaseIoGb",
    "dataEgressGb",
    "searchQueryGb",
    "queryMutationComputeGbHours",
    "actionComputeConvexGbHours",
    "actionComputeNodeJsGbHours",
    "actionComputeCpuGbHours",
    "aiGatewayCostDollars",
  ]),
  window: Schema.Literals(["day", "month"]),
  limitType: Schema.Literals(["warning", "disable"]),
  limit: Schema.Finite,
  enabled: Schema.Boolean,
}) satisfies Schema.Schema<UsageLimit>;

const errorFields = {
  cause: Schema.optionalKey(Schema.Defect()),
  operation: Schema.String,
  status: Schema.optionalKey(Schema.Finite),
  serverCode: Schema.optionalKey(Schema.String),
  code: Schema.Literals([
    "HttpError",
    "TransportError",
    "InvalidResponse",
    "InvalidRequest",
    "InvalidPagination",
    "InvalidConfiguration",
  ]),
};

const errorMessage = (error: {
  readonly cause?: unknown;
  readonly operation: string;
  readonly status?: number;
  readonly code: string;
  readonly serverCode?: string;
}) => {
  if (error.operation === "configure" && error.code === "InvalidConfiguration")
    return credentialsHint(error.cause);
  const classification =
    error.status === undefined ? error.code : `${error.status}, ${error.code}`;
  const serverCode =
    error.serverCode === undefined ? "" : `, ${error.serverCode}`;
  return `${error.operation} failed (${classification}${serverCode})`;
};

export class ConvexApiError extends Schema.TaggedError<
  ConvexApiError,
  { readonly brand: unique symbol }
>()("ConvexApiError", errorFields) {
  override get message() {
    return errorMessage(this);
  }
}

export class ConvexNotFound extends Schema.TaggedError<
  ConvexNotFound,
  { readonly brand: unique symbol }
>()("ConvexNotFound", errorFields) {
  override get message() {
    return errorMessage(this);
  }
}

export class ConvexConflict extends Schema.TaggedError<
  ConvexConflict,
  { readonly brand: unique symbol }
>()("ConvexConflict", errorFields) {
  override get message() {
    return errorMessage(this);
  }
}

/**
 * A function the deployment ran failed, with the message Convex reports.
 */
export class ConvexFunctionError extends Schema.TaggedError<
  ConvexFunctionError,
  { readonly brand: unique symbol }
>()("ConvexFunctionError", {
  functionPath: Schema.String,
  errorMessage: Schema.String,
}) {}

const FunctionResponse = Schema.Union([
  Schema.Struct({ status: Schema.Literal("success"), value: Schema.Unknown }),
  Schema.Struct({
    status: Schema.Literal("error"),
    errorMessage: Schema.String,
  }),
]);

export type ConvexClientError =
  | ConvexApiError
  | ConvexNotFound
  | ConvexConflict;

const ProjectSchema = Schema.Struct({
  id: Schema.Finite,
  name: Schema.String,
  slug: Schema.String,
  teamId: Schema.Finite,
  teamSlug: Schema.String,
  createTime: Schema.Finite,
  prodDeploymentName: Schema.String.pipe(Schema.NullOr, Schema.optionalKey),
  devDeploymentName: Schema.String.pipe(Schema.NullOr, Schema.optionalKey),
}) satisfies Schema.Schema<Project>;

const CreatedProjectSchema = Schema.Struct({
  id: Schema.Finite,
  projectId: Schema.Finite,
  slug: Schema.String,
  deploymentName: Schema.String.pipe(Schema.NullOr, Schema.optionalKey),
  deploymentUrl: Schema.String.pipe(Schema.NullOr, Schema.optionalKey),
}) satisfies Schema.Schema<CreatedProject>;

const deploymentFields = {
  name: Schema.String,
  createTime: Schema.Finite,
  deploymentType: Schema.Literals(["dev", "prod", "preview", "custom"]),
  projectId: Schema.Finite,
  previewIdentifier: Schema.String.pipe(Schema.NullOr, Schema.optionalKey),
};

const DeploymentSchema = Schema.Union([
  Schema.Struct({
    ...deploymentFields,
    kind: Schema.Literal("cloud"),
    id: Schema.Finite,
    lastDeployTime: Schema.Finite.pipe(Schema.NullOr, Schema.optionalKey),
    creator: Schema.Finite.pipe(Schema.NullOr, Schema.optionalKey),
    region: Schema.Literals([
      "aws-us-east-1",
      "aws-eu-west-1",
      "aws-ap-southeast-2",
      "aws-ca-central-1",
    ]),
    isDefault: Schema.Boolean,
    reference: Schema.String,
    dashboardEditConfirmation: Schema.Boolean.pipe(
      Schema.NullOr,
      Schema.optionalKey,
    ),
    deploymentUrl: Schema.String,
    expiresAt: Schema.Finite.pipe(Schema.NullOr, Schema.optionalKey),
    class: Schema.String,
    sendLogsToClient: Schema.Boolean.pipe(Schema.NullOr, Schema.optionalKey),
  }),
  Schema.Struct({
    ...deploymentFields,
    kind: Schema.Literal("local"),
    creator: Schema.Finite,
    port: Schema.Finite,
    deviceName: Schema.String,
    isActive: Schema.Boolean,
  }),
]) satisfies Schema.Schema<Deployment>;

const DeployKeySchema = Schema.Struct({
  id: Schema.Finite,
  name: Schema.String,
  creationTime: Schema.Finite,
  lastUsedTime: Schema.Finite.pipe(Schema.NullOr, Schema.optionalKey),
  expiresAt: Schema.Finite.pipe(Schema.NullOr, Schema.optionalKey),
  creator: Schema.Finite.pipe(Schema.NullOr, Schema.optionalKey),
  managedBy: Schema.Union([
    Schema.Literal("vercel"),
    Schema.Struct({ oauthApp: Schema.String }),
  ]).pipe(Schema.NullOr, Schema.optionalKey),
  allowedActions: Schema.Array(Schema.String),
}) satisfies Schema.Schema<DeployKey>;

const TokenDetailsSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("teamToken"), teamId: Schema.Finite }),
  Schema.Struct({
    type: Schema.Literal("projectToken"),
    projectId: Schema.Finite,
  }),
]) satisfies Schema.Schema<TokenDetails>;

const ProjectsPageSchema = Schema.Struct({
  items: Schema.Array(ProjectSchema),
  pagination: Schema.Struct({
    hasMore: Schema.Boolean,
    nextCursor: Schema.String.pipe(Schema.NullOr, Schema.optionalKey),
  }),
});

// Retain at most 8 KiB before parsing an error body. Stop the stream on overflow.
const maxErrorBodyBytes = 8 * 1024;
const httpFailure = Effect.fn("ConvexClient.httpFailure")(function* (
  operation: string,
  response: HttpClientResponse.HttpClientResponse,
  redact: (text: string) => string,
) {
  const fallback = ConvexApiError.make({
    operation,
    status: response.status,
    code: "HttpError",
  });
  const serverCode = yield* response.stream.pipe(
    Stream.mapAccum(
      () => 0,
      (size, bytes) => {
        const total = size + bytes.byteLength;
        return [total, [{ size: total, bytes }]] as const;
      },
    ),
    Stream.mapEffect(({ size, bytes }) =>
      size > maxErrorBodyBytes ? Effect.fail(fallback) : Effect.succeed(bytes),
    ),
    Stream.mkArrayBuffer,
    Effect.timeout("5 seconds"),
    Effect.map((bytes) => new TextDecoder().decode(bytes)),
    Effect.flatMap(
      Schema.decodeEffect(
        Schema.fromJsonString(Schema.Struct({ code: Schema.String })),
      ),
    ),
    Effect.map(({ code }) =>
      /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(code) && redact(code) === code
        ? code
        : undefined,
    ),
    Effect.orElseSucceed(() => undefined),
  );
  const fields = {
    operation,
    status: response.status,
    code: "HttpError" as const,
    ...(serverCode === undefined ? {} : { serverCode }),
  };
  if (response.status === 404) return yield* ConvexNotFound.make(fields);
  if (response.status === 409) return yield* ConvexConflict.make(fields);
  return yield* ConvexApiError.make(fields);
});

const make = Effect.fn("ConvexClient.make")(function* (options?: {
  readonly token?: Redacted.Redacted<string>;
  readonly mode?: ProviderMode;
}) {
  const http = yield* HttpClient.HttpClient;
  // Server text is redacted against every credential the run handled before
  // an error is built from it, so no failure exit or span can carry one.
  const credentials = yield* Redaction.credentials;
  const profileToken = yield* Effect.serviceOption(ManagementToken);
  const configuredToken = Effect.gen(function* () {
    if (Option.isSome(profileToken)) return yield* profileToken.value;
    return yield* Config.Redacted("CONVEX_ACCESS_TOKEN");
  });
  const managementAuthorization = Effect.gen(function* () {
    const token =
      options?.token ??
      (yield* configuredToken.pipe(
        Effect.mapError((cause) =>
          ConvexApiError.make({
            cause,
            operation: "configure",
            code: "InvalidConfiguration",
          }),
        ),
      ));
    yield* credentials.add(token);
    return Redacted.make(`Bearer ${Redacted.value(token)}`);
  });
  const deploymentAuthorization = managementAuthorization.pipe(
    Effect.map((authorization) =>
      pipe(
        authorization,
        Redacted.value,
        String.replace(/^Bearer /, "Convex "),
        Redacted.make,
      ),
    ),
  );
  // A deployment request sends its key, or without one the management login.
  const deploymentCredential = (key: Redacted.Redacted<string> | undefined) =>
    key === undefined
      ? deploymentAuthorization
      : Effect.succeed(Redacted.make(`Convex ${Redacted.value(key)}`));
  const baseUrl = "https://api.convex.dev/v1";

  const send = Effect.fn("ConvexClient.request")(function* (
    operation: string,
    method: "GET" | "POST" | "PATCH",
    url: string,
    authorization: Redacted.Redacted<string>,
    body?: unknown,
  ) {
    yield* credentials.add(authorization);
    let request = HttpClientRequest.make(method)(url).pipe(
      HttpClientRequest.setHeader(
        "authorization",
        Redacted.value(authorization),
      ),
      HttpClientRequest.acceptJson,
    );
    if (body !== undefined) {
      request = yield* HttpClientRequest.bodyJson(request, body).pipe(
        Effect.mapError(() =>
          ConvexApiError.make({ operation, code: "InvalidRequest" }),
        ),
      );
    }
    const response = yield* http.execute(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "manual",
      }),
      Effect.mapError(() =>
        ConvexApiError.make({ operation, code: "TransportError" }),
      ),
    );
    if (response.status < 200 || response.status >= 300)
      return yield* httpFailure(operation, response, credentials.redact);
    return response;
  });

  // Untraced, like `management` and `managementVoid`: a span ends with its
  // value, and a decoded body may hold a credential or a secret.
  const decode = Effect.fnUntraced(function* <A>(
    operation: string,
    response: HttpClientResponse.HttpClientResponse,
    schema: Schema.Decoder<A>,
  ) {
    const invalidResponse = () =>
      ConvexApiError.make({
        operation,
        status: response.status,
        code: "InvalidResponse",
      });
    const body = yield* response.json.pipe(Effect.mapError(invalidResponse));
    return yield* Schema.decodeEffect(schema)(body).pipe(
      Effect.mapError(invalidResponse),
    );
  });

  const management = Effect.fnUntraced(function* <A>(
    operation: string,
    method: "GET" | "POST" | "PATCH",
    path: string,
    schema: Schema.Decoder<A>,
    body?: unknown,
  ) {
    const managementAuthorizationValue = yield* managementAuthorization;
    const response = yield* send(
      operation,
      method,
      `${baseUrl}${path}`,
      managementAuthorizationValue,
      body,
    );
    return yield* decode(operation, response, schema);
  });

  const managementVoid = Effect.fnUntraced(function* (
    operation: string,
    method: "POST" | "PATCH",
    path: string,
    body?: unknown,
  ) {
    const managementAuthorizationValue = yield* managementAuthorization;
    yield* send(
      operation,
      method,
      `${baseUrl}${path}`,
      managementAuthorizationValue,
      body,
    );
  });

  const deploymentUrl = Effect.fn("ConvexClient.deploymentUrl")(function* (
    operation: string,
    url: string,
  ) {
    const invalidUrl = () =>
      ConvexApiError.make({ operation, code: "InvalidRequest" });
    if (options?.mode === "local") {
      if (!Loopback.isOrigin(url)) return yield* invalidUrl();
      return `${url}/api/v1`;
    }
    const parsed = yield* Effect.try({
      try: () => new URL(url),
      catch: invalidUrl,
    });
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.port !== "" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.pathname !== "/" ||
      !/^[a-z0-9-]+(?:\.(?:eu-west-1|ap-southeast-2|ca-central-1))?\.convex\.cloud$/.test(
        parsed.hostname,
      ) ||
      pipe(url, String.replace(/\/$/, "")) !== parsed.origin
    ) {
      return yield* invalidUrl();
    }
    return `${parsed.origin}/api/v1`;
  });

  // The answer stays redacted until the span ends, since a deployment's
  // answer may echo a credential.
  const runFunction = Effect.fn("ConvexClient.runFunction")(function* (
    url: string,
    key: Redacted.Redacted<string>,
    functionPath: string,
    args: unknown,
    componentPath?: string,
  ) {
    const operation = "runFunction";
    yield* credentials.add(key);
    const deploymentUrlResult = yield* deploymentUrl(operation, url);
    const origin = pipe(deploymentUrlResult, String.replace(/\/api\/v1$/, ""));
    const request = yield* HttpClientRequest.post(
      `${origin}/api/function`,
    ).pipe(
      HttpClientRequest.setHeader(
        "authorization",
        `Convex ${Redacted.value(key)}`,
      ),
      HttpClientRequest.acceptJson,
      HttpClientRequest.bodyJson({
        path: functionPath,
        args,
        format: "json",
        ...(componentPath === undefined ? {} : { componentPath }),
      }),
      Effect.mapError(() =>
        ConvexApiError.make({ operation, code: "InvalidRequest" }),
      ),
    );
    const response = yield* http.execute(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "manual",
      }),
      Effect.mapError(() =>
        ConvexApiError.make({ operation, code: "TransportError" }),
      ),
    );
    // Convex answers a function that threw with 560 and its message.
    if (response.status !== 200 && response.status !== 560)
      return yield* httpFailure(operation, response, credentials.redact);
    const result = yield* decode(operation, response, FunctionResponse);
    if (result.status === "error")
      return yield* ConvexFunctionError.make({
        functionPath,
        errorMessage: credentials.redact(result.errorMessage),
      });
    return Redacted.make(result.value);
  });

  return {
    /**
     * Run a deployment function with admin authority, internal ones and ones
     * inside a component included.
     */
    runFunction: (
      url: string,
      key: Redacted.Redacted<string>,
      functionPath: string,
      args: unknown,
      componentPath?: string,
    ) =>
      runFunction(url, key, functionPath, args, componentPath).pipe(
        Effect.map(Redacted.value),
      ),
    listCustomDomains: Effect.fn("ConvexClient.listCustomDomains")(function* (
      name: string,
    ) {
      const result = yield* management(
        "listCustomDomains",
        "GET",
        `/deployments/${encodeURIComponent(name)}/custom_domains`,
        Schema.Struct({ domains: Schema.Array(CustomDomainSchema) }),
      );
      return result.domains;
    }),
    createCustomDomain: Effect.fn("ConvexClient.createCustomDomain")(
      (name: string, input: CustomDomainInput) =>
        managementVoid(
          "createCustomDomain",
          "POST",
          `/deployments/${encodeURIComponent(name)}/create_custom_domain`,
          input,
        ),
    ),
    deleteCustomDomain: Effect.fn("ConvexClient.deleteCustomDomain")(
      (name: string, input: CustomDomainInput) =>
        managementVoid(
          "deleteCustomDomain",
          "POST",
          `/deployments/${encodeURIComponent(name)}/delete_custom_domain`,
          input,
        ),
    ),
    getCanonicalUrls: Effect.fn("ConvexClient.getCanonicalUrls")(function* (
      url: string,
    ) {
      const origin = yield* deploymentUrl("getCanonicalUrls", url);
      const authorization = yield* deploymentAuthorization;
      const response = yield* send(
        "getCanonicalUrls",
        "GET",
        `${origin}/get_canonical_urls`,
        authorization,
      );
      return yield* decode("getCanonicalUrls", response, CanonicalUrlsSchema);
    }),
    updateCanonicalUrl: Effect.fn("ConvexClient.updateCanonicalUrl")(function* (
      url: string,
      input: UpdateCanonicalUrlInput,
    ) {
      const origin = yield* deploymentUrl("updateCanonicalUrl", url);
      const authorization = yield* deploymentAuthorization;
      yield* send(
        "updateCanonicalUrl",
        "POST",
        `${origin}/update_canonical_url`,
        authorization,
        input,
      );
    }),
    listUsageLimits: Effect.fn("ConvexClient.listUsageLimits")(function* (
      url: string,
    ) {
      const origin = yield* deploymentUrl("listUsageLimits", url);
      const authorization = yield* deploymentAuthorization;
      const response = yield* send(
        "listUsageLimits",
        "GET",
        `${origin}/list_usage_limits`,
        authorization,
      );
      const result = yield* decode(
        "listUsageLimits",
        response,
        Schema.Struct({ usageLimits: Schema.Array(UsageLimitSchema) }),
      );
      return result.usageLimits;
    }),
    createUsageLimit: Effect.fn("ConvexClient.createUsageLimit")(function* (
      url: string,
      input: UsageLimitInput,
    ) {
      const origin = yield* deploymentUrl("createUsageLimit", url);
      const authorization = yield* deploymentAuthorization;
      const response = yield* send(
        "createUsageLimit",
        "POST",
        `${origin}/create_usage_limit`,
        authorization,
        input,
      );
      const result = yield* decode(
        "createUsageLimit",
        response,
        Schema.Struct({ usageLimit: UsageLimitSchema }),
      );
      return result.usageLimit;
    }),
    updateUsageLimit: Effect.fn("ConvexClient.updateUsageLimit")(function* (
      url: string,
      id: string,
      input: UsageLimitInput,
    ) {
      const origin = yield* deploymentUrl("updateUsageLimit", url);
      const authorization = yield* deploymentAuthorization;
      const response = yield* send(
        "updateUsageLimit",
        "POST",
        `${origin}/update_usage_limit/${encodeURIComponent(id)}`,
        authorization,
        input,
      );
      const result = yield* decode(
        "updateUsageLimit",
        response,
        Schema.Struct({ usageLimit: UsageLimitSchema }),
      );
      return result.usageLimit;
    }),
    deleteUsageLimit: Effect.fn("ConvexClient.deleteUsageLimit")(function* (
      url: string,
      id: string,
    ) {
      const origin = yield* deploymentUrl("deleteUsageLimit", url);
      const authorization = yield* deploymentAuthorization;
      yield* send(
        "deleteUsageLimit",
        "POST",
        `${origin}/delete_usage_limit/${encodeURIComponent(id)}`,
        authorization,
      );
    }),
    listProjects: Effect.fn("ConvexClient.listProjects")(function* (
      teamId: number,
    ) {
      const projects: Project[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      while (true) {
        const page = yield* management(
          "listProjects",
          "GET",
          `/teams/${teamId}/projects${cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`}`,
          ProjectsPageSchema,
        );
        projects.push(...page.items);
        if (!page.pagination.hasMore) return projects;
        const nextCursor = page.pagination.nextCursor;
        if (
          nextCursor === undefined ||
          nextCursor === null ||
          nextCursor === "" ||
          seenCursors.has(nextCursor)
        ) {
          return yield* ConvexApiError.make({
            operation: "listProjects",
            code: "InvalidPagination",
          });
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
    }),
    getTokenDetails: Effect.fn("ConvexClient.getTokenDetails")(() =>
      management(
        "getTokenDetails",
        "GET",
        "/token_details",
        TokenDetailsSchema,
      ),
    ),
    getProject: Effect.fn("ConvexClient.getProject")((projectId: number) =>
      management("getProject", "GET", `/projects/${projectId}`, ProjectSchema),
    ),
    createProject: Effect.fn("ConvexClient.createProject")(
      (teamId: number, input: CreateProjectInput) =>
        management(
          "createProject",
          "POST",
          `/teams/${teamId}/create_project`,
          CreatedProjectSchema,
          input,
        ),
    ),
    updateProject: Effect.fn("ConvexClient.updateProject")(
      (projectId: number, input: UpdateProjectInput) =>
        management(
          "updateProject",
          "PATCH",
          `/projects/${projectId}`,
          ProjectSchema,
          input,
        ),
    ),
    deleteProject: Effect.fn("ConvexClient.deleteProject")(
      (projectId: number) =>
        managementVoid(
          "deleteProject",
          "POST",
          `/projects/${projectId}/delete`,
        ),
    ),
    listDeployments: Effect.fn("ConvexClient.listDeployments")(
      (projectId: number) =>
        management(
          "listDeployments",
          "GET",
          `/projects/${projectId}/list_deployments`,
          Schema.Array(DeploymentSchema),
        ),
    ),
    getDeployment: Effect.fn("ConvexClient.getDeployment")((name: string) =>
      management(
        "getDeployment",
        "GET",
        `/deployments/${encodeURIComponent(name)}`,
        DeploymentSchema,
      ),
    ),
    createDeployment: Effect.fn("ConvexClient.createDeployment")(
      (projectId: number, input: CreateDeploymentInput) =>
        management(
          "createDeployment",
          "POST",
          `/projects/${projectId}/create_deployment`,
          DeploymentSchema,
          input,
        ),
    ),
    updateDeployment: Effect.fn("ConvexClient.updateDeployment")(
      (name: string, input: UpdateDeploymentInput) =>
        managementVoid(
          "updateDeployment",
          "PATCH",
          `/deployments/${encodeURIComponent(name)}`,
          input,
        ),
    ),
    deleteDeployment: Effect.fn("ConvexClient.deleteDeployment")(
      (name: string) =>
        managementVoid(
          "deleteDeployment",
          "POST",
          `/deployments/${encodeURIComponent(name)}/delete`,
        ),
    ),
    createDeployKey: Effect.fn("ConvexClient.createDeployKey")(function* (
      name: string,
      input: CreateDeployKeyInput,
    ): Effect.fn.Return<CreatedDeployKey, ConvexClientError> {
      const response = yield* management(
        "createDeployKey",
        "POST",
        `/deployments/${encodeURIComponent(name)}/create_deploy_key`,
        Schema.Struct({ deployKey: Schema.String }),
        input,
      );
      const deployKey = Redacted.make(response.deployKey);
      yield* credentials.add(deployKey);
      return { deployKey };
    }),
    listDeployKeys: Effect.fn("ConvexClient.listDeployKeys")((name: string) =>
      management(
        "listDeployKeys",
        "GET",
        `/deployments/${encodeURIComponent(name)}/list_deploy_keys`,
        Schema.Array(DeployKeySchema),
      ),
    ),
    /**
     * Delete a deploy key by the unique name `listDeployKeys` reports. Convex
     * also accepts a key's secret here; this client never sends one.
     */
    deleteDeployKey: Effect.fn("ConvexClient.deleteDeployKey")(
      (name: string, keyName: string) =>
        managementVoid(
          "deleteDeployKey",
          "POST",
          `/deployments/${encodeURIComponent(name)}/delete_deploy_key`,
          { id: keyName } satisfies ManagementApi.PlatformDeleteDeployKeyArgs,
        ),
    ),
    createLogStream: Effect.fn("ConvexClient.createLogStream")(function* (
      url: string,
      key: Redacted.Redacted<string> | undefined,
      input: CreateLogStreamInput,
    ) {
      const operation = "createLogStream";
      const authorization = yield* deploymentCredential(key);
      const response = yield* send(
        operation,
        "POST",
        `${yield* deploymentUrl(operation, url)}/create_log_stream`,
        authorization,
        logStreamBody(input),
      );
      const created = yield* decode(operation, response, LogStream.Created);
      return Redacted.make(created);
    }),
    getLogStream: Effect.fn("ConvexClient.getLogStream")(function* (
      url: string,
      key: Redacted.Redacted<string> | undefined,
      id: string,
    ): Effect.fn.Return<LogStreamConfig, ConvexClientError> {
      const operation = "getLogStream";
      const authorization = yield* deploymentCredential(key);
      const response = yield* send(
        operation,
        "GET",
        `${yield* deploymentUrl(operation, url)}/get_log_stream/${encodeURIComponent(id)}`,
        authorization,
      );
      const config = yield* decode(operation, response, LogStream.Config);
      return Redacted.make(config);
    }),
    listLogStreams: Effect.fn("ConvexClient.listLogStreams")(function* (
      url: string,
      key: Redacted.Redacted<string> | undefined,
    ): Effect.fn.Return<LogStreamConfig[], ConvexClientError> {
      const operation = "listLogStreams";
      const authorization = yield* deploymentCredential(key);
      const response = yield* send(
        operation,
        "GET",
        `${yield* deploymentUrl(operation, url)}/list_log_streams`,
        authorization,
      );
      const streams = yield* decode(
        operation,
        response,
        Schema.Array(LogStream.Config),
      );
      return Array.map(streams, (stream) => Redacted.make(stream));
    }),
    updateLogStream: Effect.fn("ConvexClient.updateLogStream")(function* (
      url: string,
      key: Redacted.Redacted<string> | undefined,
      id: string,
      input: UpdateLogStreamInput,
    ) {
      const operation = "updateLogStream";
      const authorization = yield* deploymentCredential(key);
      yield* send(
        operation,
        "POST",
        `${yield* deploymentUrl(operation, url)}/update_log_stream/${encodeURIComponent(id)}`,
        authorization,
        logStreamBody(input),
      );
    }),
    deleteLogStream: Effect.fn("ConvexClient.deleteLogStream")(function* (
      url: string,
      key: Redacted.Redacted<string> | undefined,
      id: string,
    ) {
      const operation = "deleteLogStream";
      const authorization = yield* deploymentCredential(key);
      yield* send(
        operation,
        "POST",
        `${yield* deploymentUrl(operation, url)}/delete_log_stream/${encodeURIComponent(id)}`,
        authorization,
      );
    }),
    listEnvironmentVariables: Effect.fn(
      "ConvexClient.listEnvironmentVariables",
    )(function* (
      url: string,
      key: Redacted.Redacted<string> | undefined,
    ): Effect.fn.Return<EnvironmentVariables, ConvexClientError> {
      const authorization = yield* deploymentCredential(key);
      const response = yield* send(
        "listEnvironmentVariables",
        "GET",
        `${yield* deploymentUrl("listEnvironmentVariables", url)}/list_environment_variables`,
        authorization,
      );
      const result = yield* decode(
        "listEnvironmentVariables",
        response,
        Schema.Struct({
          environmentVariables: Schema.Record(Schema.String, Schema.String),
        }),
      );
      return Rec.fromEntries(
        Array.map(
          Rec.toEntries(result.environmentVariables),
          ([name, value]) => [name, Redacted.make(value)],
        ),
      );
    }),
    updateEnvironmentVariables: Effect.fn(
      "ConvexClient.updateEnvironmentVariables",
    )(function* (
      url: string,
      key: Redacted.Redacted<string> | undefined,
      changes: readonly EnvironmentVariableChange[],
    ) {
      const authorization = yield* deploymentCredential(key);
      yield* send(
        "updateEnvironmentVariables",
        "POST",
        `${yield* deploymentUrl("updateEnvironmentVariables", url)}/update_environment_variables`,
        authorization,
        {
          changes: Array.map(changes, ({ name, value }) => ({
            name,
            ...(value === undefined
              ? {}
              : {
                  value: Redacted.isRedacted(value)
                    ? Redacted.value(value)
                    : value,
                }),
          })),
        } satisfies {
          readonly changes: Readonly<
            DeploymentApi.UpdateEnvVarsRequest["changes"]
          >;
        },
      );
    }),
  };
});

export class ConvexClient extends Context.Service<
  ConvexClient,
  Effect.Success<ReturnType<typeof make>>
>()("@confect/alchemy/ConvexClient") {}

/**
 * `mode: "local"` sends deployment requests only to a loopback backend over
 * HTTP; the default accepts only Convex cloud HTTPS origins.
 *
 * @stability unstable
 */
export const layer = (options?: {
  readonly token?: Redacted.Redacted<string>;
  readonly mode?: ProviderMode;
}) =>
  Layer.effect(ConvexClient, make(options).pipe(Effect.map(ConvexClient.of)));
