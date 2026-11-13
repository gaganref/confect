// oxlint-disable-next-line effecttsgo/node-builtin-import -- The ledger's argument digest uses the same SHA-256 as the snapshot's.
import { createHash } from "node:crypto";
import { makeFunctionReference } from "convex/server";
import {
  Base64,
  convexToJson,
  jsonToConvex,
  type JSONValue,
  type Value,
} from "convex/values";
import * as Result from "effect/Result";
import * as Execution from "./Execution.js";
import * as KernelRefusal from "./KernelRefusal.js";
import type { FunctionPath } from "./KernelValues.js";
import type * as Subscriptions from "./Subscriptions.js";

// The Convex client sync protocol, as `convex` 1.49.0 speaks it
// (`src/browser/sync/protocol.ts`) and the binary's sync worker serves it
// (`crates/sync/src/worker.rs` at `cccbade4`). Messages are their wire JSON.

/**
 * A state version as the wire carries it: `ts` is a u64, little-endian, in
 * base64 (`protocol.ts`, `longToU64`).
 */
interface WireVersion {
  readonly querySet: number;
  readonly ts: string;
  readonly identity: number;
}

interface Version {
  readonly querySet: number;
  readonly ts: bigint;
  readonly identity: number;
}

type AddQuery = {
  readonly type: "Add";
  readonly queryId: number;
  readonly udfPath: string;
  readonly args: ReadonlyArray<JSONValue>;
  readonly journal?: string | null;
  readonly componentPath?: string;
};

type RemoveQuery = { readonly type: "Remove"; readonly queryId: number };

/**
 * A mutation or action request.
 */
interface Call<Type extends "Mutation" | "Action"> {
  readonly type: Type;
  readonly requestId: number;
  readonly udfPath: string;
  readonly args: ReadonlyArray<JSONValue>;
  readonly componentPath?: string;
}

/**
 * A message the client sends.
 */
export type ClientMessage =
  | {
      readonly type: "Connect";
      readonly sessionId: string;
      readonly connectionCount: number;
      readonly lastCloseReason: string | null;
      readonly maxObservedTimestamp?: string;
      readonly clientTs?: number;
    }
  | {
      readonly type: "ModifyQuerySet";
      readonly baseVersion: number;
      readonly newVersion: number;
      readonly modifications: ReadonlyArray<AddQuery | RemoveQuery>;
    }
  | Call<"Mutation">
  | Call<"Action">
  | {
      readonly type: "Authenticate";
      readonly tokenType: "User" | "Admin" | "None";
      readonly value?: string;
      readonly baseVersion: number;
    }
  | { readonly type: "Event" };

// The binary leaves `errorData` out of a failure that carries none, which the
// client reads as a plain error rather than a `ConvexError`.
type StateModification =
  | {
      readonly type: "QueryUpdated";
      readonly queryId: number;
      readonly value: JSONValue;
      readonly logLines: ReadonlyArray<string>;
      readonly journal: string | null;
    }
  | {
      readonly type: "QueryFailed";
      readonly queryId: number;
      readonly errorMessage: string;
      readonly logLines: ReadonlyArray<string>;
      readonly errorData?: JSONValue;
      readonly journal: string | null;
    }
  | { readonly type: "QueryRemoved"; readonly queryId: number };

/**
 * A message the kernel sends.
 */
export type ServerMessage =
  | {
      readonly type: "Transition";
      readonly startVersion: WireVersion;
      readonly endVersion: WireVersion;
      readonly modifications: ReadonlyArray<StateModification>;
    }
  | {
      readonly type: "MutationResponse";
      readonly requestId: number;
      readonly success: true;
      readonly result: JSONValue;
      readonly ts: string;
      readonly logLines: ReadonlyArray<string>;
    }
  | {
      readonly type: "MutationResponse" | "ActionResponse";
      readonly requestId: number;
      readonly success: false;
      readonly result: string;
      readonly logLines: ReadonlyArray<string>;
      readonly errorData?: JSONValue;
    }
  | {
      readonly type: "ActionResponse";
      readonly requestId: number;
      readonly success: true;
      readonly result: JSONValue;
      readonly logLines: ReadonlyArray<string>;
    }
  | {
      readonly type: "AuthError";
      readonly error: string;
      readonly baseVersion: number;
      readonly authUpdateAttempted: boolean;
    }
  | { readonly type: "FatalError"; readonly error: string };

// Pure rules.

/**
 * `ts` as the wire's u64: eight bytes, little-endian, in base64.
 */
export const encodeTs = (ts: bigint): string => {
  const bytes = new Uint8Array(8);
  let rest = BigInt.asUintN(64, ts);
  for (let i = 0; i < 8; i++) {
    bytes[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return Base64.fromByteArray(bytes);
};

export const decodeTs = (encoded: string): bigint =>
  Base64.toByteArray(encoded).reduceRight(
    (value, byte) => (value << 8n) | BigInt(byte),
    0n,
  );

const wire = (version: Version): WireVersion => ({
  querySet: version.querySet,
  ts: encodeTs(version.ts),
  identity: version.identity,
});

/**
 * A query-set modification's next version, or the binary's refusal: its base
 * must be the version last received, and its new version greater
 * (`crates/sync/src/state.rs:223-243`).
 */
export const nextQuerySet = (
  received: number,
  baseVersion: number,
  newVersion: number,
): Result.Result<number, KernelRefusal.SyncProtocolViolation> =>
  baseVersion !== received
    ? Result.fail(
        new KernelRefusal.SyncProtocolViolation({
          reason: "BaseVersionMismatch",
          message: `Base version ${baseVersion} passed up doesn't match the current version ${received}`,
        }),
      )
    : newVersion <= baseVersion
      ? Result.fail(
          new KernelRefusal.SyncProtocolViolation({
            reason: "QuerySetVersionNotIncreasing",
            message: `Query set version ${newVersion} is not after ${baseVersion}`,
          }),
        )
      : Result.succeed(newVersion);

/**
 * An Authenticate's next identity version, or the binary's refusal: its base
 * must be the version last received (`crates/sync/src/state.rs:257-268`).
 */
export const nextIdentity = (
  received: number,
  baseVersion: number,
): Result.Result<number, KernelRefusal.SyncProtocolViolation> =>
  baseVersion === received
    ? Result.succeed(received + 1)
    : Result.fail(
        new KernelRefusal.SyncProtocolViolation({
          reason: "IdentityVersionMismatch",
          message: `Identity base version ${baseVersion} passed up doesn't match the current version ${received}`,
        }),
      );

/**
 * `json` with object keys in order, so equal arguments digest the same however
 * a client ordered them.
 */
const canonical = (json: JSONValue): JSONValue =>
  Array.isArray(json)
    ? json.map(canonical)
    : json !== null && typeof json === "object"
      ? Object.fromEntries(
          Object.keys(json)
            .sort()
            .map((key) => [key, canonical(json[key]!)]),
        )
      : json;

/**
 * The SHA-256 of `json`, canonical.
 */
export const digest = (json: JSONValue): string =>
  createHash("sha256")
    .update(JSON.stringify(canonical(json)))
    .digest("hex");

/**
 * How an error reaches the client: a `ConvexError`'s data as `errorData`, and
 * its message as the binary's uncaught line.
 */
const failurePayload = (
  error: unknown,
): { readonly message: string; readonly errorData?: JSONValue } => {
  const data = (error as { readonly data?: unknown } | null)?.data;
  const name = error instanceof Error ? error.name : "Error";
  const message =
    error instanceof Error
      ? `Uncaught ${name}: ${error.message}`
      : String(error);
  if (name !== "ConvexError" || data === undefined) return { message };
  try {
    return { message, errorData: convexToJson(data as Value) };
  } catch {
    return { message };
  }
};

/**
 * What a run shows the client.
 */
const modification = (
  queryId: number,
  run: Pick<Execution.QueryRun, "outcome" | "journal">,
): StateModification => {
  if (run.outcome._tag === "returned") {
    return {
      type: "QueryUpdated",
      queryId,
      value: convexToJson(run.outcome.value),
      logLines: [],
      journal: run.journal,
    };
  }
  const { message, errorData } = failurePayload(run.outcome.error);
  return {
    type: "QueryFailed",
    queryId,
    errorMessage: message,
    logLines: [],
    ...(errorData === undefined ? {} : { errorData }),
    journal: run.journal,
  };
};

// Artifacts.

/**
 * One mutation a session's client sent, answered once. `Sync` is its only
 * writer: it records a successful mutation as it answers it, and answers a
 * resent request ID from here, as the binary's `_session_requests` does
 * (`crates/application/src/application_function_runner/mod.rs:2118-2178`).
 * Arguments are kept only as the digest of their artifact form, so no secret
 * argument is in the ledger.
 */
export interface LedgerEntry {
  readonly sessionId: string;
  readonly requestId: number;
  readonly functionPath: FunctionPath;
  readonly argsDigest: string;
  /**
   * The attempt that committed. More than one shows the mutation conflicted.
   */
  readonly attempts: number;
  readonly ts: bigint;
  readonly result: Value;
}

/**
 * A protocol message one socket sent or received, as an artifact writes it.
 */
export interface Recorded {
  readonly socket: number;
  readonly direction: "client" | "server";
  readonly message: JSONValue;
}

/**
 * A protocol failure `Sync` answered, as an artifact writes it, with the client
 * message that caused it when one did.
 */
export interface Failure {
  readonly socket: number;
  readonly error: unknown;
  readonly message: JSONValue;
}

interface Session {
  readonly ledger: Map<number, LedgerEntry>;
  /**
   * Mutations running now, by request ID, so a resend waits for the one already
   * running.
   */
  readonly running: Map<
    number,
    { readonly argsDigest: string; readonly answer: Promise<ServerMessage> }
  >;
}

/**
 * How one socket's client sees the server.
 */
interface Peer {
  readonly send: (message: string) => void;
  readonly close: (code: number, reason: string) => void;
}

const isRoot = (componentPath: string | undefined) =>
  componentPath === undefined || componentPath === "";

/**
 * The kernel's side of the sync protocol for one world: the sockets open on it,
 * each session's request ledger, and the protocol artifacts. Messages are
 * driven in process. `WebSocket` is a constructor the unmodified
 * `BaseConvexClient` takes as its `webSocketConstructor`.
 */
export class Server {
  private readonly sessions = new Map<string, Session>();
  private readonly connections = new Set<Connection>();
  private readonly recorded: Array<{
    readonly socket: number;
    readonly direction: "client" | "server";
    readonly mark: () => JSONValue;
  }> = [];
  private readonly failed: Array<{
    readonly socket: number;
    readonly error: unknown;
    readonly message: () => JSONValue;
  }> = [];
  private nextSocket = 1;
  private unwatch: (() => void) | undefined;
  readonly WebSocket: new (url: string) => KernelWebSocket;

  constructor(
    readonly world: Execution.World,
    readonly subscriptions: Subscriptions.Registry,
  ) {
    this.WebSocket = socketClass(this);
  }

  endpoint(): Endpoint {
    return {
      WebSocket: this.WebSocket,
      ledger: () => this.ledger(),
      transcript: () => this.transcript(),
      failures: () => this.failures(),
      redact: (json) => this.world.redactJson(json),
    };
  }

  /**
   * Open a socket for `peer`. A commit since its last transition that changed
   * what one of its queries read schedules its next transition.
   */
  connect(peer: Peer): Connection {
    this.unwatch ??= this.world.watch(() => {
      for (const connection of this.connections) connection.committed();
    });
    const connection = new Connection(this, this.nextSocket++, peer);
    this.connections.add(connection);
    return connection;
  }

  disconnected(connection: Connection) {
    this.connections.delete(connection);
    if (this.connections.size === 0) {
      this.unwatch?.();
      this.unwatch = undefined;
    }
  }

  session(sessionId: string): Session {
    const known = this.sessions.get(sessionId);
    if (known !== undefined) return known;
    const session: Session = { ledger: new Map(), running: new Map() };
    this.sessions.set(sessionId, session);
    return session;
  }

  record(
    socket: number,
    direction: "client" | "server",
    mark: () => JSONValue,
  ) {
    this.recorded.push({ socket, direction, mark });
  }

  fail(socket: number, error: unknown, message: () => JSONValue = () => null) {
    this.failed.push({ socket, error, message });
  }

  /**
   * Every session's ledger, oldest first, as an artifact writes it: each result
   * marked by its mutation's return shape.
   */
  ledger(): ReadonlyArray<LedgerEntry> {
    return Array.from(this.sessions.values()).flatMap((session) =>
      Array.from(session.ledger.values(), (entry) => {
        const outcome = this.world.redactOutcome(
          { _tag: "returned", value: entry.result },
          entry.functionPath,
        );
        return {
          ...entry,
          result: outcome._tag === "returned" ? outcome.value : null,
        };
      }),
    );
  }

  /**
   * Every message sent and received, in order, as an artifact writes it:
   * arguments marked by their function's argument shape, values by their
   * function's return shape, tokens replaced by the marker, and every string
   * holding a kept secret marked.
   */
  transcript(): ReadonlyArray<Recorded> {
    return this.recorded.map(({ socket, direction, mark }) => ({
      socket,
      direction,
      message: this.world.redactJson(mark()),
    }));
  }

  /**
   * The protocol failures `Sync` answered, as failure reports.
   */
  failures(): ReadonlyArray<Failure> {
    return this.failed.map(({ socket, error, message }) => ({
      socket,
      error: this.world.redactFailure(error),
      message: this.world.redactJson(message()),
    }));
  }
}

/**
 * What a test reaches of the sync protocol: the socket constructor for its
 * clients and the protocol's artifacts, each already marked.
 */
export interface Endpoint {
  readonly WebSocket: new (url: string) => KernelWebSocket;
  readonly ledger: () => ReadonlyArray<LedgerEntry>;
  readonly transcript: () => ReadonlyArray<Recorded>;
  readonly failures: () => ReadonlyArray<Failure>;
  /**
   * `json` as an artifact writes it, every string holding a kept secret marked.
   * A probe record leaves through here.
   */
  readonly redact: (json: JSONValue) => JSONValue;
}

/**
 * The marker a token's value becomes in an artifact.
 */
const tokenMarker = "[redacted]";

/**
 * One socket's sync worker, as the binary's: client messages run one at a time
 * in arrival order, mutations one at a time in their own order, actions at
 * once, and a transition whenever a modification, an identity change, a
 * finished request or an invalidating commit asks for one.
 */
export class Connection {
  private session: Session | undefined;
  private sessionId = "";
  private readonly subscriber: Subscriptions.Subscriber;
  /**
   * The socket's queries. A query that could not run at all, such as one whose
   * arguments its validator refused, has no subscription: the binary answers it
   * with `QueryFailed` and keeps it in the set until the client removes it.
   */
  private readonly queries = new Map<
    number,
    {
      readonly functionPath: FunctionPath;
      readonly subscription: Subscriptions.Subscription | undefined;
    }
  >();
  private readonly bySubscription = new Map<string, number>();
  private pending: Array<AddQuery | RemoveQuery> = [];
  private receivedQuerySet = 0;
  private receivedIdentity = 0;
  private current: Version = { querySet: 0, ts: 0n, identity: 0 };
  private token: string | null = null;
  private messages: Promise<void> = Promise.resolve();
  private mutations: Promise<void> = Promise.resolve();
  private updating = false;
  private updateScheduled = false;
  private closed = false;
  private readonly counted: { readonly close: () => void };

  constructor(
    private readonly server: Server,
    readonly id: number,
    private readonly peer: Peer,
  ) {
    this.subscriber = server.subscriptions.subscriber(
      Execution.anonymous,
      true,
    );
    this.counted = server.world.openSocket();
  }

  /**
   * A message from the client, run after every earlier one.
   */
  receive(text: string) {
    if (this.closed) return;
    const message = JSON.parse(text) as ClientMessage;
    this.server.record(this.id, "client", () => this.markClient(message));
    this.messages = this.messages
      .then(() => (this.closed ? undefined : this.handle(message)))
      .catch((error: unknown) =>
        this.fatal(error, () => this.markClient(message)),
      );
  }

  /**
   * The client closed the socket, or it dropped. Running mutations finish and
   * reach the session's ledger. The session outlives the socket, so a client
   * that reconnects under it is answered from there.
   */
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const { subscription } of this.queries.values()) {
      subscription?.unsubscribe();
    }
    this.queries.clear();
    this.counted.close();
    this.server.disconnected(this);
  }

  /**
   * A commit published. Schedule a transition if it invalidated a query.
   */
  committed() {
    if (!this.closed && this.server.subscriptions.stale(this.subscriber)) {
      this.scheduleUpdate();
    }
  }

  private send(
    message: ServerMessage,
    mark: () => JSONValue = () => message as unknown as JSONValue,
  ) {
    if (this.closed) return;
    this.server.record(this.id, "server", mark);
    this.peer.send(JSON.stringify(message));
  }

  private fatal(error: unknown, message?: () => JSONValue) {
    if (this.closed) return;
    this.server.fail(this.id, error, message);
    const text =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    this.send({ type: "FatalError", error: text }, () => ({
      type: "FatalError",
      error: this.server.world.redactJson(text),
    }));
    this.peer.close(1011, "FatalError");
    this.close();
  }

  private refuse<A>(result: Result.Result<A, unknown>): A {
    if (Result.isFailure(result)) throw result.failure;
    return result.success;
  }

  private handle(message: ClientMessage): Promise<void> | void {
    switch (message.type) {
      case "Connect": {
        this.sessionId = message.sessionId;
        this.session = this.server.session(message.sessionId);
        if (message.maxObservedTimestamp !== undefined) {
          const observed = decodeTs(message.maxObservedTimestamp);
          const latest = this.server.world.state.commitTs;
          if (observed > latest) {
            throw new KernelRefusal.SyncProtocolViolation({
              reason: "TimestampAhead",
              message: `Client has observed a timestamp ${observed} ahead of the backend latest known timestamp ${latest}`,
            });
          }
        }
        return;
      }
      case "ModifyQuerySet": {
        this.receivedQuerySet = this.refuse(
          nextQuerySet(
            this.receivedQuerySet,
            message.baseVersion,
            message.newVersion,
          ),
        );
        this.pending.push(...message.modifications);
        this.scheduleUpdate();
        return;
      }
      case "Authenticate":
        return this.authenticate(message);
      case "Mutation":
        this.checkRoot(message.componentPath);
        return this.callerNow().then(
          (caller) => caller && this.mutate(caller, message),
        );
      case "Action":
        this.checkRoot(message.componentPath);
        return this.callerNow().then(
          (caller) => caller && this.act(caller, message),
        );
      case "Event":
        return;
    }
  }

  private checkRoot(componentPath: string | undefined) {
    if (!isRoot(componentPath)) {
      throw new KernelRefusal.SyncProtocolViolation({
        reason: "ComponentPathNotAllowed",
        message:
          "Only admin or system users can call functions on non-root components directly",
      });
    }
  }

  /**
   * The identity a request runs under: the latest the client presented,
   * verified again at the kernel's time, as the binary revalidates a token
   * before each request (`crates/sync/src/worker.rs:903-912`). A token that no
   * longer verifies answers `AuthError` and closes the socket, and there is no
   * caller.
   */
  private callerNow(): Promise<Execution.Caller | undefined> {
    const caller = this.subscriber.caller;
    if (this.token === null) return Promise.resolve(caller);
    return this.server.world
      .authenticate(Execution.anonymous, this.token)
      .catch((error: unknown) =>
        this.authError(error, this.receivedIdentity, false),
      );
  }

  private authError(
    error: unknown,
    baseVersion: number,
    attempted: boolean,
  ): undefined {
    this.server.fail(this.id, error);
    const text = error instanceof Error ? error.message : String(error);
    this.send({
      type: "AuthError",
      error: text,
      baseVersion,
      authUpdateAttempted: attempted,
    });
    this.peer.close(1000, "AuthError");
    this.close();
    return undefined;
  }

  private authenticate(
    message: Extract<ClientMessage, { readonly type: "Authenticate" }>,
  ): Promise<void> | void {
    switch (message.tokenType) {
      case "None": {
        const identity = this.refuse(
          nextIdentity(this.receivedIdentity, message.baseVersion),
        );
        this.token = null;
        this.subscriber.authenticate(null);
        this.receivedIdentity = identity;
        this.scheduleUpdate();
        return;
      }
      case "Admin":
        throw KernelRefusal.requiresBinary("adminAuthentication");
      case "User": {
        const token = message.value ?? "";
        return this.subscriber.present(token).then(
          () => this.authenticated(token, message.baseVersion),
          (error: unknown) => this.authError(error, message.baseVersion, true),
        );
      }
    }
  }

  private authenticated(token: string, baseVersion: number) {
    this.receivedIdentity = this.refuse(
      nextIdentity(this.receivedIdentity, baseVersion),
    );
    this.token = token;
    this.scheduleUpdate();
  }

  private functionPath(udfPath: string): FunctionPath {
    return { componentPath: "", udfPath };
  }

  /**
   * Run a mutation after every earlier one this socket sent, or answer it from
   * the session's ledger.
   */
  private mutate(caller: Execution.Caller, message: Call<"Mutation">) {
    const session = this.session ?? this.server.session(this.sessionId);
    const functionPath = this.functionPath(message.udfPath);
    const args = jsonToConvex(message.args[0] ?? {});
    const argsDigest = digest(
      convexToJson(this.server.world.projectArguments(functionPath, args)),
    );
    this.mutations = this.mutations
      .then(() => {
        const recorded = session.ledger.get(message.requestId);
        const running = session.running.get(message.requestId);
        const known = recorded ?? running;
        if (known !== undefined && known.argsDigest !== argsDigest) {
          throw new KernelRefusal.SyncRequestReused({
            requestId: message.requestId,
            recorded: known.argsDigest,
            sent: argsDigest,
            message: `Request ${message.requestId} of this session was already sent with other arguments.`,
          });
        }
        const answer =
          recorded !== undefined
            ? Promise.resolve(this.success(recorded))
            : (running?.answer ??
              this.runMutation(
                session,
                caller,
                message,
                functionPath,
                args,
                argsDigest,
              ));
        return answer.then((response) => this.answered(response, functionPath));
      })
      .catch((error: unknown) => this.fatal(error));
  }

  private success(entry: LedgerEntry): ServerMessage {
    return {
      type: "MutationResponse",
      requestId: entry.requestId,
      success: true,
      result: convexToJson(entry.result),
      ts: encodeTs(entry.ts),
      logLines: [],
    };
  }

  /**
   * Prepare and apply attempts until one commits, as the binary retries a
   * mutation whose reads changed. The attempt that commits reaches the ledger
   * with the outcome, in the same turn as its commit.
   */
  private runMutation(
    session: Session,
    caller: Execution.Caller,
    message: Call<"Mutation">,
    functionPath: FunctionPath,
    args: Value,
    argsDigest: string,
  ): Promise<ServerMessage> {
    const world = this.server.world;
    const failure = (error: unknown): ServerMessage => {
      const { message: text, errorData } = failurePayload(error);
      return {
        type: "MutationResponse",
        requestId: message.requestId,
        success: false,
        result: text,
        logLines: [],
        ...(errorData === undefined ? {} : { errorData }),
      };
    };
    let attempts = 1;
    const apply = (id: string): Promise<ServerMessage> =>
      world.apply(id).then((applied) => {
        if (applied.kind === "conflict") {
          attempts = applied.next.number;
          return apply(applied.next.id);
        }
        if (applied.kind !== "applied") return failure(applied.error);
        const entry: LedgerEntry = {
          sessionId: this.sessionId,
          requestId: message.requestId,
          functionPath,
          argsDigest,
          attempts,
          ts: applied.commitTs,
          result: applied.result,
        };
        session.ledger.set(message.requestId, entry);
        return this.success(entry);
      });
    const answer = world
      .prepare(caller, makeFunctionReference(message.udfPath), args)
      .then((view) => apply(view.id), failure)
      .finally(() => {
        session.running.delete(message.requestId);
      });
    session.running.set(message.requestId, { argsDigest, answer });
    return answer;
  }

  private act(caller: Execution.Caller, message: Call<"Action">) {
    const functionPath = this.functionPath(message.udfPath);
    this.server.world
      .action(
        caller,
        makeFunctionReference(message.udfPath),
        jsonToConvex(message.args[0] ?? {}),
      )
      .then(
        (value: Value): ServerMessage => ({
          type: "ActionResponse",
          requestId: message.requestId,
          success: true,
          result: convexToJson(value),
          logLines: [],
        }),
        (error: unknown): ServerMessage => {
          const { message: text, errorData } = failurePayload(error);
          return {
            type: "ActionResponse",
            requestId: message.requestId,
            success: false,
            result: text,
            logLines: [],
            ...(errorData === undefined ? {} : { errorData }),
          };
        },
      )
      .then((response) => this.answered(response, functionPath))
      .catch((error: unknown) => this.fatal(error));
  }

  /**
   * Send a request's answer, then a transition, so a successful mutation's
   * client sees a state at or past its commit.
   */
  private answered(response: ServerMessage, functionPath: FunctionPath) {
    this.send(response, () => this.markServer(response, functionPath));
    this.scheduleUpdate();
  }

  private scheduleUpdate() {
    this.updateScheduled = true;
    if (this.updating || this.closed) return;
    this.updating = true;
    const loop = (): Promise<void> => {
      if (!this.updateScheduled || this.closed) {
        this.updating = false;
        return Promise.resolve();
      }
      this.updateScheduled = false;
      return this.update().then(loop);
    };
    // Updates start after the current turn, so messages that arrived together
    // share one transition, as the binary batches what it received.
    void Promise.resolve()
      .then(loop)
      .catch((error: unknown) => {
        this.updating = false;
        this.fatal(error);
      });
  }

  /**
   * One transition: apply the pending modifications, rerun the stale queries
   * until none is stale, then end at the latest commit's timestamp and the
   * identity received, read in the same turn as that last check
   * (`crates/sync/src/worker.rs:933-1061`, `:1253-1324`).
   */
  private update(): Promise<void> {
    const start = this.current;
    const taken = this.pending;
    this.pending = [];
    const querySet = this.receivedQuerySet;
    const modifications = new Map<number, StateModification>();
    const functionPaths = new Map<number, FunctionPath>();
    const apply = taken.reduce<Promise<void>>(
      (previous, change) =>
        previous.then(() => {
          if (change.type === "Remove") {
            const query = this.queries.get(change.queryId);
            if (query === undefined) {
              throw new KernelRefusal.SyncProtocolViolation({
                reason: "NonexistentQueryId",
                message: `Nonexistent query id: ${change.queryId}`,
              });
            }
            query.subscription?.unsubscribe();
            this.queries.delete(change.queryId);
            if (query.subscription !== undefined) {
              this.bySubscription.delete(query.subscription.id);
            }
            modifications.set(change.queryId, {
              type: "QueryRemoved",
              queryId: change.queryId,
            });
            return;
          }
          if (this.queries.has(change.queryId)) {
            throw new KernelRefusal.SyncProtocolViolation({
              reason: "DuplicateQueryId",
              message: `Duplicate query ID: ${change.queryId}`,
            });
          }
          this.checkRoot(change.componentPath);
          const functionPath = this.functionPath(change.udfPath);
          return this.subscriber
            .subscribe(
              makeFunctionReference(change.udfPath),
              jsonToConvex(change.args[0] ?? {}),
              change.journal ?? null,
            )
            .then(
              (subscription) =>
                this.added(change.queryId, functionPath, subscription),
              (error: unknown) =>
                this.unrunnable(change.queryId, functionPath, error),
            )
            .then((run) => {
              functionPaths.set(change.queryId, functionPath);
              modifications.set(
                change.queryId,
                modification(change.queryId, run),
              );
              return undefined;
            });
        }),
      Promise.resolve(),
    );
    const settle = (): Promise<Version> =>
      this.server.subscriptions.refresh(this.subscriber).then((transitions) => {
        for (const { subscription } of transitions) {
          const queryId = this.bySubscription.get(subscription);
          const query =
            queryId === undefined ? undefined : this.queries.get(queryId);
          if (queryId === undefined || query?.subscription === undefined) {
            continue;
          }
          functionPaths.set(queryId, query.functionPath);
          modifications.set(
            queryId,
            modification(queryId, query.subscription.current()),
          );
        }
        return this.server.subscriptions.stale(this.subscriber)
          ? settle()
          : {
              querySet,
              ts: this.server.world.state.commitTs,
              identity: this.receivedIdentity,
            };
      });
    return apply
      .then(settle)
      .then((end) =>
        this.transition(start, end, [...modifications.values()], functionPaths),
      );
  }

  private transition(
    start: Version,
    end: Version,
    modifications: ReadonlyArray<StateModification>,
    functionPaths: ReadonlyMap<number, FunctionPath>,
  ) {
    const transition: ServerMessage = {
      type: "Transition",
      startVersion: wire(start),
      endVersion: wire(end),
      modifications,
    };
    this.current = end;
    this.send(
      transition,
      () =>
        ({
          ...transition,
          modifications: modifications.map((change) =>
            this.markModification(change, functionPaths.get(change.queryId)),
          ),
        }) as unknown as JSONValue,
    );
  }

  private added(
    queryId: number,
    functionPath: FunctionPath,
    subscription: Subscriptions.Subscription,
  ): Execution.QueryRun {
    // A socket that closed while the query ran sends nothing more, so its
    // subscription must not outlive it.
    if (this.closed) {
      subscription.unsubscribe();
    } else {
      this.queries.set(queryId, { functionPath, subscription });
      this.bySubscription.set(subscription.id, queryId);
    }
    return subscription.current();
  }

  /**
   * A query that failed before it ran, such as one whose arguments its
   * validator refused or whose function does not exist. The binary answers it
   * with `QueryFailed`, not a fatal error.
   */
  private unrunnable(
    queryId: number,
    functionPath: FunctionPath,
    error: unknown,
  ): Pick<Execution.QueryRun, "outcome" | "journal"> {
    this.queries.set(queryId, { functionPath, subscription: undefined });
    return { outcome: { _tag: "failed", error }, journal: null };
  }

  // Artifact forms.

  private markArgs(udfPath: string, args: ReadonlyArray<JSONValue>) {
    const world = this.server.world;
    return args.map((arg) =>
      convexToJson(
        world.projectArguments(this.functionPath(udfPath), jsonToConvex(arg)),
      ),
    );
  }

  private markClient(message: ClientMessage): JSONValue {
    switch (message.type) {
      case "Mutation":
      case "Action":
        return {
          ...message,
          args: this.markArgs(message.udfPath, message.args),
        } as unknown as JSONValue;
      case "ModifyQuerySet":
        return {
          ...message,
          modifications: message.modifications.map((change) =>
            change.type === "Add"
              ? { ...change, args: this.markArgs(change.udfPath, change.args) }
              : change,
          ),
        } as unknown as JSONValue;
      case "Authenticate":
        return (message.value === undefined
          ? message
          : { ...message, value: tokenMarker }) as unknown as JSONValue;
      default:
        return message as unknown as JSONValue;
    }
  }

  private markOutcome(
    value: JSONValue,
    functionPath: FunctionPath | undefined,
  ): JSONValue {
    const outcome = this.server.world.redactOutcome(
      { _tag: "returned", value: jsonToConvex(value) },
      functionPath,
    );
    return outcome._tag === "returned" ? convexToJson(outcome.value) : null;
  }

  private markModification(
    change: StateModification,
    functionPath: FunctionPath | undefined,
  ): StateModification {
    return change.type === "QueryUpdated"
      ? { ...change, value: this.markOutcome(change.value, functionPath) }
      : change;
  }

  private markServer(
    message: ServerMessage,
    functionPath: FunctionPath,
  ): JSONValue {
    return (message.type === "MutationResponse" ||
    message.type === "ActionResponse"
      ? message.success
        ? { ...message, result: this.markOutcome(message.result, functionPath) }
        : message
      : message) as unknown as JSONValue;
  }
}

/**
 * `KernelWebSocket` bound to `server`, the constructor a client is given.
 */
const socketClass = (server: Server) =>
  class extends KernelWebSocket {
    constructor(url: string) {
      super(url, server);
    }
  };

/**
 * The client's side of an in-process socket, with the `WebSocket` surface
 * `BaseConvexClient` uses. Every event reaches the client in a later turn, in
 * order, as a network would deliver it.
 */
export class KernelWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: string }) => void) | null = null;
  onclose:
    | ((event: {
        readonly code: number;
        readonly reason: string;
        readonly wasClean: boolean;
      }) => void)
    | null = null;
  onerror: ((event: unknown) => void) | null = null;
  private readonly connection: Connection;
  private delivered: Promise<void> = Promise.resolve();

  constructor(
    readonly url: string,
    server: Server,
  ) {
    this.connection = server.connect({
      send: (message) =>
        this.deliver(() => this.onmessage?.({ data: message })),
      close: (code, reason) => this.closed(code, reason),
    });
    this.deliver(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.({ type: "open" });
    });
  }

  send(data: string) {
    if (this.readyState !== 1) {
      throw new Error("WebSocket is not open");
    }
    // The server reads it in a later turn, as a network would.
    void Promise.resolve().then(() => this.connection.receive(data));
  }

  close(code = 1000, reason = "") {
    if (this.readyState >= 2) return;
    this.connection.close();
    this.closed(code, reason);
  }

  /**
   * Drop the connection, as a network failure would: the client sees an
   * abnormal close and reconnects under its session.
   */
  drop() {
    this.close(1006, "");
  }

  private closed(code: number, reason: string) {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.deliver(() => {
      this.readyState = 3;
      this.onclose?.({ code, reason, wasClean: code === 1000 });
    });
  }

  private deliver(event: () => void) {
    // An event the client throws on fails the run as an uncaught error, as it
    // would in a browser's event loop.
    this.delivered = this.delivered.then(() => {
      try {
        return event();
      } catch (error) {
        return queueMicrotask(() => {
          throw error;
        });
      }
    });
  }
}
