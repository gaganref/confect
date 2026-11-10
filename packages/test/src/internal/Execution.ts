import { AsyncLocalStorage } from "node:async_hooks";
import {
  actionGeneric,
  getFunctionAddress,
  mutationGeneric,
  queryGeneric,
  type FunctionReference,
  type GenericSchema,
  type SchemaDefinition,
  type UserIdentity,
} from "convex/server";
import { convexToJson, jsonToConvex, type Value } from "convex/values";
import { KernelAttempt } from "./Attempt.js";
import * as Kernel from "./Kernel.js";
import * as KernelQuery from "./KernelQuery.js";
import * as KernelRefusal from "./KernelRefusal.js";
import type {
  DocumentId,
  FunctionPath,
  StoredDocument,
  ValidatorJSON,
} from "./KernelValues.js";
import {
  createFunctionHandle,
  createTestJwt,
  deserializeConvexErrorData,
  evaluateValue,
  hasPendingValues,
  parseArgs,
  parseFunctionHandle,
  resolveCommittedValues,
  simpleHash,
  tableNameFromId,
  validateFunctionArgs,
  validateReturnValue,
} from "./KernelValues.js";

const ROOT = "";
const TYPICAL_CONVEX_ID_LENGTH = 32;

type Modules = Record<string, () => Promise<any>>;

/**
 * One registered component: its schema and its function modules, each loaded
 * once when the world opens.
 */
interface Component {
  readonly path: string;
  readonly schema: KernelQuery.KernelSchema | null;
  readonly loaders: ReadonlyMap<string, () => Promise<any>>;
  readonly loaded: Map<string, any>;
}

/**
 * Who is calling: the identity and the request attributes a test accessor set.
 */
export interface Caller {
  readonly identity: UserIdentity | null;
  readonly token: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export const anonymous: Caller = {
  identity: null,
  token: null,
  ip: null,
  userAgent: null,
};

export const withIdentity = (
  caller: Caller,
  identity: Partial<UserIdentity>,
): Caller => {
  const subject = identity.subject ?? "" + simpleHash(JSON.stringify(identity));
  const issuer = identity.issuer ?? "https://convex.test";
  const tokenIdentifier = identity.tokenIdentifier ?? `${issuer}|${subject}`;
  const full = { ...identity, subject, issuer, tokenIdentifier };
  return { ...caller, identity: full, token: createTestJwt(full) };
};

interface Request {
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string;
  readonly scheduledFunctionId: string | null;
  readonly authToken: string | null;
}

type UdfType = "query" | "mutation" | "action";

/**
 * One running function. Queries and mutations read and write through their
 * attempt. Calls nested in a query or a mutation take turns on `turn`.
 */
interface Execution {
  readonly world: World;
  readonly componentPath: string;
  readonly udfPath: string;
  readonly udfType: UdfType;
  readonly attempt: KernelAttempt | undefined;
  readonly identity: UserIdentity | null;
  readonly request: Request;
  readonly pagination: { calls: number } | undefined;
  readonly turn: Turn;
}

/**
 * A queue that runs one task at a time.
 */
class Turn {
  private tail: Promise<unknown> = Promise.resolve();

  take<A>(task: () => Promise<A>): Promise<A> {
    const result = this.tail.then(task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const executions = new AsyncLocalStorage<Execution>();
const kernelBrand = Symbol.for("@confect/test/Kernel");

const current = (): Execution => {
  const execution = executions.getStore();
  if (execution === undefined) {
    throw new Error(
      "A Convex syscall ran outside any function the test kernel started.",
    );
  }
  return execution;
};

let nextRequestId = 0;
const newRequest = (caller: Caller): Request => ({
  ip: caller.ip,
  userAgent: caller.userAgent,
  requestId: `kernel-request-${nextRequestId++}`,
  scheduledFunctionId: null,
  authToken: caller.token,
});

const findModulesRoot = (paths: ReadonlyArray<string>): string => {
  const generated = paths.find((path) => path.includes("_generated"));
  if (generated === undefined) {
    throw new Error(
      'Could not find the "_generated" directory, make sure to run ' +
        "`npx convex dev` or `npx convex codegen`. Make sure your " +
        '`import.meta.glob` includes the files in the "_generated" directory',
    );
  }
  return generated.split("_generated", 2)[0]!;
};

const makeComponent = (
  path: string,
  schema: SchemaDefinition<GenericSchema, boolean> | null | undefined,
  modules: Modules,
): Component => {
  const root = findModulesRoot(Object.keys(modules));
  const relative = Object.entries(modules)
    .filter(([key]) => key.startsWith(root))
    .map(([key, load]) => [key.slice(root.length), load] as const);
  const nested = relative
    .map(([file]) => file)
    .filter((file) => file.endsWith("/convex.config.ts"))
    .map((file) => file.slice(0, -"convex.config.ts".length));
  return {
    path,
    schema: KernelQuery.exportSchema(schema),
    loaders: new Map(
      relative
        .filter(
          ([file]) =>
            isFunctionModule(file) &&
            !nested.some((dir) => file.startsWith(dir)),
        )
        .map(([file, load]) => [file.replace(/\.[^.]+$/, ""), load]),
    ),
    loaded: new Map(),
  };
};

const entryExtensions = [
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".jsx",
];

/**
 * Whether Convex's bundler deploys this file as a function module, by the rule
 * `entryPoints` applies in `convex/src/bundler/index.ts` (1.49). A test file, a
 * schema, a config and `_generated` never reach the binary, so the kernel
 * neither loads them nor resolves a function in them.
 */
const isFunctionModule = (file: string): boolean => {
  const base = file.split("/").pop()!;
  return (
    entryExtensions.some((extension) => file.endsWith(extension)) &&
    !file.startsWith("_generated/") &&
    !base.startsWith(".") &&
    !base.startsWith("#") &&
    base !== "schema.ts" &&
    base !== "schema.js" &&
    (base.match(/\./g) ?? []).length <= 1 &&
    !file.includes(" ")
  );
};

const unregistered = (world: World, componentPath: string) => {
  const registered = [...world.components.keys()].filter((p) => p !== ROOT);
  return new Error(
    `Component "${componentPath}" is not registered on this test backend. ` +
      (registered.length === 0
        ? "No components have been registered."
        : `Registered components: ${registered.map((p) => `"${p}"`).join(", ")}.`),
  );
};

type FunctionAddress = {
  readonly name?: string | undefined;
  readonly reference?: string | undefined;
  readonly functionHandle?: string | undefined;
};

/**
 * Where an address points, read from the calling component.
 */
const functionPathOf = (
  address: FunctionAddress,
  from: string,
): FunctionPath => {
  if (address.functionHandle !== undefined) {
    return parseFunctionHandle(address.functionHandle) as FunctionPath;
  }
  if (address.name !== undefined) {
    return { udfPath: address.name, componentPath: from };
  }
  if (address.reference !== undefined) {
    // "_reference/childComponent/<child>/path/to/file/fn"
    const parts = address.reference.split("/");
    const child = parts[2]!;
    const rest = parts.slice(3);
    return {
      componentPath: from.length > 0 ? `${from}/${child}` : child,
      udfPath: `${rest.slice(0, -1).join("/")}:${rest[rest.length - 1]}`,
    };
  }
  throw new Error("Function address not supported");
};

const pathOfReference = (
  reference: FunctionReference<any, any, any, any> | string,
  from: string,
) =>
  functionPathOf(getFunctionAddress(reference as any) as FunctionAddress, from);

interface Resolved {
  readonly func: any;
  readonly handler: (ctx: any, args: any) => any;
  readonly args: ValidatorJSON;
  readonly returns: ValidatorJSON | null;
}

const kindCheck = {
  query: "isQuery",
  mutation: "isMutation",
  action: "isAction",
} as const;

/**
 * A test backend: its registered components and the kernel state they share.
 */
export class World {
  readonly components = new Map<string, Component>();
  state: Kernel.State = Kernel.empty;
  private opened: Promise<void> | undefined;
  private nextDocId = 10000;
  private lastCreationTime = 0;
  private nextQueryId = 1;
  private readonly queries = new Map<number, Iterator<any>>();
  // Row 2 publishes one top-level mutation at a time. Row 3 replaces this
  // with read-set validation and held attempts.
  private readonly commits = new Turn();

  constructor(
    schema: SchemaDefinition<GenericSchema, boolean> | null | undefined,
    modules: Modules,
  ) {
    installConvexGlobal();
    this.components.set(ROOT, makeComponent(ROOT, schema, modules));
  }

  register(
    componentPath: string,
    schema: SchemaDefinition<GenericSchema, boolean>,
    modules: Modules,
  ) {
    if (this.opened !== undefined) {
      throw new KernelRefusal.RegisteredAfterOpen({
        componentPath,
        message: `Component "${componentPath}" was registered after the test backend opened. Register every component before the first call.`,
      });
    }
    this.components.set(
      componentPath,
      makeComponent(componentPath, schema, modules),
    );
  }

  /**
   * Load every registered module of every component, once, before any function
   * runs.
   */
  open(): Promise<void> {
    this.opened ??= Promise.all(
      Array.from(this.components.values(), (component) =>
        Promise.all(
          Array.from(component.loaders, ([path, load]) =>
            load().then((module) => component.loaded.set(path, module)),
          ),
        ),
      ),
    ).then(() => undefined);
    return this.opened;
  }

  private component(componentPath: string): Component {
    const component = this.components.get(componentPath);
    if (component === undefined) throw unregistered(this, componentPath);
    return component;
  }

  private resolve(functionPath: FunctionPath, kind: UdfType | "any"): Resolved {
    const [modulePath, maybeExport] = functionPath.udfPath.split(":") as [
      string,
      string | undefined,
    ];
    const exportName = maybeExport ?? "default";
    const component = this.component(functionPath.componentPath);
    const module = component.loaded.get(modulePath);
    if (module === undefined) {
      throw new Error(`Could not find module for: "${modulePath}"`);
    }
    const func = module[exportName];
    if (func === undefined) {
      throw new Error(
        `Expected a Convex function exported from module "${modulePath}" as \`${exportName}\`, but there is no such export.`,
      );
    }
    const handler = "_handler" in func ? func._handler : func;
    if (typeof handler !== "function") {
      throw new Error(
        `Expected a Convex function exported from module "${modulePath}" as \`${exportName}\`, but got: ${func}`,
      );
    }
    if (kind !== "any" && !func[kindCheck[kind]]) {
      throw new Error(
        `Expected a ${kind} function, but the function exported from module "${modulePath}" as \`${exportName}\` is not a ${kind}.`,
      );
    }
    const args = JSON.parse(func.exportArgs()) as ValidatorJSON;
    if (args.type !== "object" && args.type !== "any") {
      throw new Error(
        `Invalid JSON returned from ${modulePath}.js:${exportName}.exportArgs(): ` +
          `Args validator must be an object or any`,
      );
    }
    return { func, handler, args, returns: JSON.parse(func.exportReturns()) };
  }

  // Calls from the test.

  query(caller: Caller, reference: any, args: any): Promise<any> {
    return this.open().then(() => {
      const from = { caller, request: newRequest(caller) };
      return typeof reference === "function"
        ? this.runQuery(
            { componentPath: ROOT, udfPath: "inline" },
            { handler: reference, args: { type: "any" }, returns: null },
            args ?? {},
            from,
          )
        : this.queryAt(pathOfReference(reference, ROOT), args, from);
    });
  }

  mutation(caller: Caller, reference: any, args: any): Promise<any> {
    return this.open().then(() => {
      const from = { caller, request: newRequest(caller) };
      return typeof reference === "function"
        ? this.runMutation(
            { componentPath: ROOT, udfPath: "inline" },
            { handler: reference, args: { type: "any" }, returns: null },
            args ?? {},
            from,
          )
        : this.mutationAt(pathOfReference(reference, ROOT), args, from);
    });
  }

  action(caller: Caller, reference: any, args: any): Promise<any> {
    return this.open().then(() => {
      const from = { caller, request: newRequest(caller) };
      return typeof reference === "function"
        ? this.runAction(
            { componentPath: ROOT, udfPath: "inline" },
            { handler: reference, args: { type: "any" }, returns: null },
            args ?? {},
            from,
          )
        : this.actionAt(pathOfReference(reference, ROOT), args, from);
    });
  }

  run(
    caller: Caller,
    componentPath: string,
    handler: (ctx: any) => any,
  ): Promise<any> {
    return this.open().then(() => {
      this.component(componentPath);
      return this.runMutation(
        { componentPath, udfPath: "custom" },
        { handler, args: { type: "any" }, returns: null },
        {},
        { caller, request: newRequest(caller) },
      );
    });
  }

  // Calls by address, from the test or from a running function.

  private queryAt(
    functionPath: FunctionPath,
    args: any,
    from: From,
    snapshotOnly = false,
  ) {
    const resolved = this.resolve(functionPath, "query");
    validateFunctionArgs(
      resolved.args,
      args ?? {},
      functionPath as any,
      from.parent?.attempt !== undefined,
    );
    return this.runQuery(functionPath, resolved, args, from, snapshotOnly);
  }

  private mutationAt(functionPath: FunctionPath, args: any, from: From) {
    const resolved = this.resolve(functionPath, "mutation");
    validateFunctionArgs(
      resolved.args,
      args ?? {},
      functionPath as any,
      from.parent?.attempt !== undefined,
    );
    return this.runMutation(functionPath, resolved, args, from);
  }

  private actionAt(functionPath: FunctionPath, args: any, from: From) {
    const resolved = this.resolve(functionPath, "action");
    validateFunctionArgs(resolved.args, args ?? {}, functionPath as any, false);
    return this.runAction(functionPath, resolved, args, from);
  }

  // Runners.

  private execution(
    functionPath: FunctionPath,
    udfType: UdfType,
    attempt: KernelAttempt | undefined,
    from: From,
    pagination: { calls: number } | undefined,
  ): Execution {
    const parent = from.parent;
    // A component call carries no identity, as Convex gives a component no
    // `ctx.auth` of the caller's.
    const identity =
      parent !== undefined &&
      parent.componentPath !== functionPath.componentPath
        ? null
        : (parent?.identity ?? from.caller.identity);
    return {
      world: this,
      componentPath: functionPath.componentPath,
      udfPath: functionPath.udfPath,
      udfType,
      attempt,
      identity,
      request: from.request,
      pagination,
      turn: new Turn(),
    };
  }

  // Calls nested in one query or mutation run one at a time, as in convex-test.
  private nested<A>(from: From, task: () => Promise<A>): Promise<A> {
    return from.parent?.attempt === undefined
      ? task()
      : from.parent.turn.take(task);
  }

  private runQuery(
    functionPath: FunctionPath,
    resolved: Pick<Resolved, "handler" | "args" | "returns">,
    args: any,
    from: From,
    snapshotOnly = false,
  ): Promise<any> {
    return this.nested(from, () => {
      const parentAttempt = from.parent?.attempt;
      const isNested = parentAttempt !== undefined;
      const attempt =
        parentAttempt === undefined
          ? new KernelAttempt(this.state)
          : snapshotOnly
            ? new KernelAttempt(parentAttempt.snapshot)
            : parentAttempt;
      const execution = this.execution(
        functionPath,
        "query",
        attempt,
        from,
        (isNested && from.parent?.pagination) || { calls: 0 },
      );
      const q = queryGeneric({
        handler: (ctx: any, a: any) =>
          resolved.handler({ ...ctx, auth: queryAuth(execution) }, a),
      }) as unknown as { invokeQuery: (args: string) => Promise<string> };
      return executions
        .run(execution, () =>
          q.invokeQuery(JSON.stringify(convexToJson([parseArgs(args)]))),
        )
        .then((raw) => {
          const result = jsonToConvex(JSON.parse(raw));
          if (!isNested && hasPendingValues(result)) {
            throw new Error(
              `Function ${functionPath.udfPath} return value invalid: queries ` +
                `cannot return an unresolved placeholder value.`,
            );
          }
          validateReturnValue(
            resolved.returns,
            result,
            "query",
            functionPath as any,
          );
          return result;
        })
        .catch((error: unknown) => {
          throw deserializeConvexErrorData(error);
        });
    });
  }

  private runMutation(
    functionPath: FunctionPath,
    resolved: Pick<Resolved, "handler" | "args" | "returns">,
    args: any,
    from: From,
  ): Promise<any> {
    const parentAttempt = from.parent?.attempt;
    const invoke = (attempt: KernelAttempt): Promise<Value> => {
      const execution = this.execution(
        functionPath,
        "mutation",
        attempt,
        from,
        undefined,
      );
      const m = mutationGeneric({
        handler: (ctx: any, a: any) =>
          resolved.handler({ ...ctx, auth: mutationAuth(execution) }, a),
      }) as unknown as { invokeMutation: (args: string) => Promise<string> };
      return executions
        .run(execution, () =>
          m.invokeMutation(JSON.stringify(convexToJson([parseArgs(args)]))),
        )
        .then((raw) => {
          const result = jsonToConvex(JSON.parse(raw));
          validateReturnValue(
            resolved.returns,
            result,
            "mutation",
            functionPath as any,
          );
          return result;
        });
    };
    if (parentAttempt !== undefined) {
      return this.nested(from, () => {
        parentAttempt.push();
        return invoke(parentAttempt).then(
          (result) => {
            parentAttempt.merge();
            return result;
          },
          (error: unknown) => {
            parentAttempt.drop();
            throw deserializeConvexErrorData(error);
          },
        );
      });
    }
    return this.commits.take(() => {
      const attempt = new KernelAttempt(this.state);
      return invoke(attempt).then(
        (result) => {
          // oxlint-disable-next-line effecttsgo/global-date -- The controlled clock is a later kernel row. Until then a commit reads the wall clock, as convex-test does.
          const now = Date.now();
          this.state = Kernel.apply(this.state, attempt.writes(), now);
          return resolveCommittedValues(
            result,
            Kernel.commitTsAt(this.state, attempt.snapshot, now),
          );
        },
        (error: unknown) => {
          throw deserializeConvexErrorData(error);
        },
      );
    });
  }

  private runAction(
    functionPath: FunctionPath,
    resolved: Pick<Resolved, "handler" | "args" | "returns">,
    args: any,
    from: From,
  ): Promise<any> {
    const execution = this.execution(
      functionPath,
      "action",
      undefined,
      from,
      undefined,
    );
    const inner: From = {
      caller: from.caller,
      request: from.request,
      parent: execution,
    };
    const a = actionGeneric({
      handler: (ctx: any, innerArgs: any) =>
        resolved.handler(
          {
            ...ctx,
            runQuery: (reference: any, queryArgs: any) =>
              this.queryAt(
                pathOfReference(reference, functionPath.componentPath),
                queryArgs,
                inner,
              ),
            runMutation: (reference: any, mutationArgs: any) =>
              this.mutationAt(
                pathOfReference(reference, functionPath.componentPath),
                mutationArgs,
                inner,
              ),
            runAction: (reference: any, actionArgs: any) =>
              this.actionAt(
                pathOfReference(reference, functionPath.componentPath),
                actionArgs,
                inner,
              ),
            auth: queryAuth(execution),
          },
          innerArgs,
        ),
    }) as unknown as {
      invokeAction: (requestId: string, args: string) => Promise<string>;
    };
    return executions
      .run(execution, () =>
        a.invokeAction(
          from.request.requestId,
          JSON.stringify(convexToJson([parseArgs(args)])),
        ),
      )
      .then((raw) => {
        const result = jsonToConvex(JSON.parse(raw));
        validateReturnValue(
          resolved.returns,
          result,
          "action",
          functionPath as any,
        );
        return result;
      })
      .catch((error: unknown) => {
        throw deserializeConvexErrorData(error);
      });
  }

  // Syscalls.

  private schema(componentPath: string) {
    return this.component(componentPath).schema;
  }

  private view(execution: Execution): KernelQuery.TableView {
    const attempt = transaction(execution);
    return {
      schema: this.schema(execution.componentPath),
      scan: (tableName) => attempt.scan(execution.componentPath, tableName),
    };
  }

  private generateId(table: string): DocumentId {
    const counter = String(this.nextDocId++).padStart(
      TYPICAL_CONVEX_ID_LENGTH - table.length,
      "0",
    );
    return (counter + table) as DocumentId;
  }

  syscall(op: string, jsonArgs: string): string {
    const args = JSON.parse(jsonArgs);
    const execution = current();
    switch (op) {
      case "1.0/getSnapshotTs":
        return JSON.stringify(
          convexToJson(transaction(execution).snapshot.commitTs),
        );
      case "1.0/queryStream": {
        const queryId = this.nextQueryId++;
        this.queries.set(
          queryId,
          KernelQuery.stream(this.view(execution), args.query),
        );
        return JSON.stringify({ queryId });
      }
      case "1.0/queryCleanup":
        this.queries.delete(args.queryId);
        return JSON.stringify({});
      case "1.0/db/normalizeId": {
        const tableName = tableNameFromId(args.idString);
        return JSON.stringify({
          id: tableName === args.table ? args.idString : null,
        });
      }
      default:
        throw new Error(`The test kernel does not support syscall: "${op}"`);
    }
  }

  asyncSyscall(op: string, jsonArgs: string): Promise<string> {
    return Promise.resolve().then(() =>
      this.dispatchAsync(op, JSON.parse(jsonArgs), current()),
    );
  }

  private dispatchAsync(
    op: string,
    args: any,
    execution: Execution,
  ): string | Promise<string> {
    switch (op) {
      case "1.0/get": {
        const { table, id } = args;
        return JSON.stringify(convexToJson(this.get(execution, table, id)));
      }
      case "1.0/queryStreamNext": {
        const results = this.queries.get(args.queryId);
        if (results === undefined) throw new Error("Bad queryId");
        const { value, done } = results.next();
        return JSON.stringify(
          convexToJson(
            done ? { value: null, done: true } : { value, done: false },
          ),
        );
      }
      case "1.0/queryPage": {
        const pagination = execution.pagination;
        if (pagination) {
          pagination.calls += 1;
          if (pagination.calls > 1) {
            throw new Error(
              "Only a single paginated query (`.paginate()`) is allowed per " +
                "query, including nested query calls and component calls. " +
                "This is a Convex limit: https://docs.convex.dev/database/pagination",
            );
          }
        }
        return JSON.stringify(
          convexToJson(KernelQuery.paginate(this.view(execution), args) as any),
        );
      }
      case "1.0/insert":
        return JSON.stringify({
          _id: this.insert(execution, args.table, jsonToConvex(args.value)),
        });
      case "1.0/shallowMerge":
        this.patch(execution, args.table, args.id, args.value);
        return JSON.stringify({});
      case "1.0/replace":
        this.replace(execution, args.table, args.id, args.value);
        return JSON.stringify({});
      case "1.0/remove":
        this.remove(execution, args.table, args.id);
        return JSON.stringify({});
      case "1.0/count":
        return JSON.stringify(
          transaction(execution).scan(execution.componentPath, args.table)
            .length,
        );
      case "1.0/getFunctionMetadata":
        return JSON.stringify(
          convexToJson({
            name: execution.udfPath,
            componentPath: execution.componentPath,
          }),
        );
      case "1.0/getRequestMetadata":
        if (execution.udfType === "query") {
          throw new Error(
            "getRequestMetadata() can only be called from a mutation, action " +
              "or HTTP action. It is not available in queries.",
          );
        }
        return JSON.stringify(convexToJson(execution.request as any));
      case "1.0/getDeploymentMetadata":
        return JSON.stringify(
          convexToJson({ name: "test", region: null, class: "s16" }),
        );
      case "1.0/actions/query":
      case "1.0/actions/mutation":
      case "1.0/actions/action": {
        const from: From = {
          caller: anonymousWith(execution),
          request: execution.request,
          parent: execution,
        };
        const functionPath = functionPathOf(args, execution.componentPath);
        const run =
          op === "1.0/actions/query"
            ? this.queryAt(functionPath, args.args, from)
            : op === "1.0/actions/mutation"
              ? this.mutationAt(functionPath, args.args, from)
              : this.actionAt(functionPath, args.args, from);
        return run.then((value) => JSON.stringify(convexToJson(value)));
      }
      case "1.0/runUdf": {
        const { udfType, args: udfArgs } = args;
        const from: From = {
          caller: anonymousWith(execution),
          request: execution.request,
          parent: execution,
        };
        const functionPath = functionPathOf(args, execution.componentPath);
        const value = jsonToConvex(udfArgs);
        const run =
          udfType === "query"
            ? this.queryAt(functionPath, value, from)
            : udfType === "snapshotQuery"
              ? this.queryAt(functionPath, value, from, true)
              : udfType === "mutation"
                ? this.mutationAt(functionPath, value, from)
                : Promise.reject(
                    new Error(
                      `The test kernel does not support udf type: "${udfType}"`,
                    ),
                  );
        return run.then((result) => JSON.stringify(convexToJson(result)));
      }
      case "1.0/createFunctionHandle": {
        const functionPath = functionPathOf(args, execution.componentPath);
        this.component(functionPath.componentPath);
        return JSON.stringify(createFunctionHandle(functionPath as any));
      }
      case "1.0/auditLog":
        return JSON.stringify(null);
      case "1.0/schedule":
      case "1.0/actions/schedule":
      case "1.0/cancel_job":
      case "1.0/actions/cancel_job":
        throw KernelRefusal.rowPending("the scheduler", 5);
      case "1.0/storageDelete":
      case "1.0/storageGetUrl":
      case "1.0/storageGenerateUploadUrl":
        throw KernelRefusal.rowPending("storage", 6);
      case "1.0/getTransactionMetrics":
        throw KernelRefusal.rowPending("transaction limits", 6);
      case "1.0/actions/vectorSearch":
        throw KernelRefusal.requiresBinary("vectorSearch");
      default:
        throw new Error(
          `The test kernel does not support async syscall: "${op}"`,
        );
    }
  }

  jsSyscall(op: string): Promise<never> {
    return Promise.reject(
      op.startsWith("storage/")
        ? KernelRefusal.rowPending("storage", 6)
        : new Error(`The test kernel does not support js syscall: "${op}"`),
    );
  }

  // Documents. The checks and messages are convex-test's.

  private get(execution: Execution, tableName: unknown, id: unknown) {
    validateId(tableName, id);
    return transaction(execution).get(execution.componentPath, id);
  }

  private insert(execution: Execution, table: string, value: any): DocumentId {
    const attempt = transaction(execution);
    KernelQuery.validateDocument(
      this.schema(execution.componentPath),
      table,
      value,
    );
    const _id = this.generateId(table);
    // oxlint-disable-next-line effecttsgo/global-date -- The controlled clock is a later kernel row. Until then creation times read the wall clock, as convex-test does.
    const now = Date.now();
    const _creationTime =
      now <= this.lastCreationTime ? this.lastCreationTime + 0.001 : now;
    this.lastCreationTime = _creationTime;
    attempt.write(execution.componentPath, _id, {
      ...value,
      _id,
      _creationTime,
    });
    return _id;
  }

  private existing(
    execution: Execution,
    tableName: unknown,
    id: unknown,
    write: string,
    value: unknown,
  ): StoredDocument {
    validateId(tableName, id);
    if (value !== undefined && typeof value !== "object") {
      throw new Error(
        `Invalid argument \`value\` in \`db.${write}\`, expected object but got '${typeof value}': ${value as any}`,
      );
    }
    const document = transaction(execution).get(execution.componentPath, id);
    if (document === null) {
      throw new Error(
        write === "delete"
          ? "Delete on non-existent doc"
          : `${write === "patch" ? "Patch" : "Replace"} on non-existent document with ID "${id}"`,
      );
    }
    return document;
  }

  private fields(document: StoredDocument, value: Record<string, any>) {
    if (value._id !== undefined && value._id !== document._id) {
      throw new Error(
        `Provided \`_id\` field value "${value._id}" ` +
          `does not match the document ID "${document._id}"`,
      );
    }
    if (
      value._creationTime !== undefined &&
      value._creationTime !== document._creationTime
    ) {
      throw new Error(
        `Provided \`_creationTime\` field value ${value._creationTime} ` +
          `does not match the document's creation time ${document._creationTime}`,
      );
    }
    const convexValue: Record<string, Value | undefined> = {};
    for (const [key, v] of Object.entries(value)) {
      if (key !== "_id" && key !== "_creationTime") {
        convexValue[key] = evaluateValue(v);
      }
    }
    return convexValue;
  }

  private patch(
    execution: Execution,
    tableName: unknown,
    id: unknown,
    value: Record<string, any>,
  ) {
    const document = this.existing(execution, tableName, id, "patch", value);
    const { _id, _creationTime, ...fields } = document;
    const merged = { ...fields, ...this.fields(document, value) };
    KernelQuery.validateDocument(
      this.schema(execution.componentPath),
      tableNameFromId(_id)!,
      merged,
    );
    transaction(execution).write(execution.componentPath, _id, {
      _id,
      _creationTime,
      ...merged,
    } as StoredDocument);
  }

  private replace(
    execution: Execution,
    tableName: unknown,
    id: unknown,
    value: Record<string, any>,
  ) {
    const document = this.existing(execution, tableName, id, "replace", value);
    const fields = this.fields(document, value);
    KernelQuery.validateDocument(
      this.schema(execution.componentPath),
      tableNameFromId(document._id)!,
      fields,
    );
    transaction(execution).write(execution.componentPath, document._id, {
      ...fields,
      _id: document._id,
      _creationTime: document._creationTime,
    } as StoredDocument);
  }

  private remove(execution: Execution, tableName: unknown, id: unknown) {
    const document = this.existing(
      execution,
      tableName,
      id,
      "delete",
      undefined,
    );
    transaction(execution).write(execution.componentPath, document._id, null);
  }
}

interface From {
  readonly caller: Caller;
  readonly request: Request;
  readonly parent?: Execution;
}

const anonymousWith = (execution: Execution): Caller => ({
  ...anonymous,
  identity: execution.identity,
});

const transaction = (execution: Execution): KernelAttempt => {
  if (execution.attempt === undefined) {
    throw new Error(
      "The database is only available in queries and mutations. An action reads and writes through `ctx.runQuery` and `ctx.runMutation`.",
    );
  }
  return execution.attempt;
};

const queryAuth = (execution: Execution) => ({
  getUserIdentity: () => Promise.resolve(execution.identity),
});

const mutationAuth = (execution: Execution) => ({
  ...queryAuth(execution),
  signJwt: () => Promise.reject(KernelRefusal.rowPending("JWT signing", 6)),
});

function validateId(
  expectedTableName: unknown,
  id: unknown,
): asserts id is DocumentId {
  if (typeof id !== "string") {
    throw new Error(
      `Invalid argument \`id\`, expected string but got '${typeof id}': ${id as any}`,
    );
  }
  if (expectedTableName === undefined) return;
  if (typeof expectedTableName !== "string") {
    throw new Error(
      `Invalid argument \`tableName\`, expected string but got '${typeof expectedTableName}': ${expectedTableName as any}`,
    );
  }
  const actualTableName = tableNameFromId(id);
  if (actualTableName === null) {
    throw new Error(
      `Invalid argument \`id\`, expected ID value but got '${id}'`,
    );
  }
  if (actualTableName !== expectedTableName) {
    throw new Error(
      `Invalid argument \`id\`, expected ID in table '${expectedTableName}' but got ID in table '${actualTableName}'`,
    );
  }
}

/**
 * Convex's server library reaches the backend through `globalThis.Convex`. The
 * kernel answers each syscall for the function that made it.
 */
const installConvexGlobal = () => {
  const global = globalThis as { Convex?: { [kernelBrand]?: true } };
  if (global.Convex?.[kernelBrand] === true) return;
  global.Convex = {
    [kernelBrand]: true,
    syscall: (op: string, args: string) => current().world.syscall(op, args),
    asyncSyscall: (op: string, args: string) =>
      current().world.asyncSyscall(op, args),
    jsSyscall: (op: string) => current().world.jsSyscall(op),
  } as any;
};

/**
 * Whether `globalThis.Convex` is the kernel's, so no other backend answered.
 */
export const ownsConvexGlobal = (): boolean =>
  (globalThis as { Convex?: { [kernelBrand]?: true } }).Convex?.[
    kernelBrand
  ] === true;
