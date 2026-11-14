import { describe, expect, it } from "@effect/vitest";
import { makeFunctionReference } from "convex/server";
import type { JSONValue } from "convex/values";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { mint } from "../../../tools/local-backend/fixtures/minted";
import type { KernelControls } from "../src/internal/ConvexTest";
import * as Json from "../src/internal/Json";
import * as Redaction from "../src/internal/Redaction";
import { kernelApp, kernelTarget } from "./fixtures/syncApp";
import * as Legs from "./fixtures/syncLegs";
import { assertIs } from "./internal/assertIs";

const secret = "canary-7f3a9c";

/**
 * A secret shorter than the string backstop searches for, so only its
 * argument's schema marks it.
 */
const short = "§¶";

/**
 * The kernel's query cache age in these tests: short, so leg 1 waits it out
 * quickly, and long against the in-process steps it must outlast.
 */
const cacheAge = 1_000;

/**
 * JSON text of any value, as the kernel's frames and artifacts are written.
 */
const UnknownJson = Schema.fromJsonString(Schema.Unknown);

/**
 * `json` with bigints as their digits, so it encodes.
 */
const plain = (json: unknown): unknown =>
  typeof json === "bigint"
    ? json.toString()
    : Arr.isArray(json)
      ? Arr.map(json, plain)
      : json !== null && typeof json === "object"
        ? Rec.map(json as Record<string, unknown>, plain)
        : json;

/**
 * `json` as text, with bigints as their digits.
 */
const text = (json: unknown) =>
  Schema.encodeEffect(UnknownJson)(plain(json)).pipe(Effect.orDie);

// The tests that mint tokens run live, so this is the host's time, the time
// the kernel's wall-clock runtime verifies them at.
const nowSeconds = Clock.currentTimeMillis.pipe(
  Effect.map((millis) => Math.floor(millis / 1000)),
);

const tokens = Effect.gen(function* () {
  const now = yield* nowSeconds;
  const { jwks, cases, signDeclared } = yield* mint(now);
  const other = yield* signDeclared({ sub: "other", role: "teacher" });
  const person = Option.getOrThrow(
    Arr.findFirst(cases, (c) => c.name === "valid control"),
  ).token;
  return { jwks, tokens: { person, other } };
});

/**
 * A policy with the probe app's `notes.text` secret.
 */
const notesSecret = Redaction.policy({
  tables: {
    "": {
      notes: () =>
        Schema.Struct({
          name: Schema.String,
          text: Schema.Redacted(Schema.String),
        }),
    },
  },
  functions: {},
});

describe("the unmodified client on the kernel", () => {
  it.live(
    "leg 1: two clients see each step's values, outcomes and identities, an identity change reruns a time query only once its cached value has expired, and reruns a failing one every time",
    () =>
      Effect.gen(function* () {
        const { jwks, tokens: minted } = yield* tokens;
        const t = kernelApp(jwks, { queryCacheAge: cacheAge });
        const observed = yield* Legs.observable(
          kernelTarget(t),
          "leg1",
          minted,
          secret,
          { cacheAge },
        );
        expect(observed.rejections).toEqual([]);
        expect(observed.sockets.a["whoami"]).toEqual([
          { value: null },
          { value: { subject: "person", role: "student" } },
          { value: { subject: "other", role: "teacher" } },
          { value: null },
        ]);
        expect(observed.sockets.a["counter"]).toEqual([
          { value: 0 },
          { value: 1 },
        ]);
        expect(observed.terminal.a["notes"]).toEqual({
          value: ["first", "second", "remembered"],
        });
        expect(observed.outcomes).toContainEqual({
          failed: { data: { code: "nope" } },
        });
        // The sign-in within the cache age is answered from the cache; the
        // identity change after it has expired answers a new time.
        expect(observed.sockets.c.clock).toEqual([0, 1]);
        // A failure is never cached, so the sign-in within the cache age
        // reruns it too, and its error changes both times.
        expect(observed.sockets.c.failing).toEqual({
          withinWindow: true,
          afterExpiry: true,
        });
        const disagreements = yield* Effect.promise(() => t.reference());
        expect(disagreements).toEqual([]);
      }),
    // A rerun that never comes is waited for until the step deadline, once
    // for each sign-in, so that it fails on `failing` rather than on time.
    { timeout: Duration.toMillis(Legs.stepDeadline) * 3 },
  );

  it.live(
    "leg 2: concurrent increments contend and none is lost or counted twice",
    () =>
      Effect.gen(function* () {
        const { jwks } = yield* tokens;
        const t = kernelApp(jwks);
        const observed = yield* Legs.occ(kernelTarget(t), "leg2");
        expect(observed).toEqual({ contended: true, consistent: true });
      }),
  );

  it.live(
    "leg 3: the client accepts every message, through a lost response and a reconnect",
    () =>
      Effect.gen(function* () {
        const { jwks, tokens: minted } = yield* tokens;
        const t = kernelApp(jwks);
        const observed = yield* Legs.acceptance(
          kernelTarget(t),
          "leg3",
          minted,
        );
        expect(observed).toEqual(Legs.accepted);
      }),
  );
});

/**
 * A socket on `t`'s sync endpoint driven by hand, for messages the unmodified
 * client never sends, opened before it answers. Each send waits a moment for
 * the kernel's answers, which reach `received` in later turns.
 */
const rawSocket = (t: KernelControls) =>
  Effect.gen(function* () {
    const ws = new (t.sync().WebSocket)("ws://kernel.invalid");
    const received: Array<Record<string, any>> = [];
    const state: { closed: { code: number; reason: string } | undefined } = {
      closed: undefined,
    };
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- The kernel's socket has only the `on*` handlers the Convex client uses.
    ws.onmessage = (event) => {
      // A frame arrives in the socket's callback, which cannot run an Effect.
      received.push(Json.parse(event.data) as Record<string, any>);
    };
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- See above.
    ws.onclose = (event) => {
      state.closed = { code: event.code, reason: event.reason };
    };
    yield* Effect.callback<void>((resume) => {
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- See above.
      ws.onopen = () => resume(Effect.void);
    });
    return {
      ws,
      received,
      state,
      send: (message: object) =>
        Schema.encodeEffect(UnknownJson)(message).pipe(
          Effect.orDie,
          Effect.flatMap((frame) => Effect.sync(() => ws.send(frame))),
          Effect.andThen(Effect.sleep(Duration.millis(50))),
        ),
    };
  });

const connectMessage = (sessionId: string) => ({
  type: "Connect",
  sessionId,
  connectionCount: 0,
  lastCloseReason: "InitialConnect",
  clientTs: 0,
});

const ofType = (received: ReadonlyArray<Record<string, any>>, type: string) =>
  Arr.filter(received, (message) => message["type"] === type);

const lastError = (t: KernelControls) =>
  Option.map(Arr.last(t.sync().failures()), (failure) => failure.error);

describe("Sync's artifacts", () => {
  it.live(
    "a secret argument sent through Sync reaches no protocol artifact, while the client gets the raw values",
    () =>
      Effect.gen(function* () {
        const { jwks } = yield* tokens;
        const t = kernelApp(jwks);
        const { remembered, revealed, sequences } = yield* Effect.gen(
          function* () {
            const client = yield* Legs.connect(kernelTarget(t));
            client.watch("peek", "sync:peek", { secret });
            const kept = yield* client.mutation("sync:remember", {
              name: "canary",
              secret,
            });
            const failed = yield* client.mutation("sync:reveal", { secret });
            const stashed = yield* client.mutation("sync:stash", {
              secret: short,
            });
            yield* client.until(() => client.value("peek") !== undefined);
            expect(kept).toEqual({ value: `kept ${secret}` });
            expect(failed).toEqual({
              failed: { data: { code: "revealed", secret } },
            });
            expect(client.value("peek")).toEqual({ value: `seen ${secret}` });
            expect(stashed).toEqual({ value: null });
            return {
              remembered: kept,
              revealed: failed,
              sequences: client.sequences(),
            };
          },
        ).pipe(Effect.scoped);

        // A call the binary's worker refuses, whose report names its message.
        const socket = yield* rawSocket(t);
        yield* socket.send(connectMessage("canary"));
        yield* socket.send({
          type: "Mutation",
          requestId: 0,
          udfPath: "sync:stash",
          args: [{ secret: short }],
          componentPath: "child",
        });

        const endpoint = t.sync();
        const record = endpoint.redact({
          observations: sequences as Record<string, Array<JSONValue>>,
          outcomes: [remembered, revealed],
        });
        const artifacts = {
          ledger: endpoint.ledger(),
          transcript: endpoint.transcript(),
          failures: endpoint.failures(),
          record,
        };
        for (const [name, artifact] of Rec.toEntries(artifacts)) {
          const written = yield* text(artifact);
          expect(written, name).not.toContain(secret);
          expect(written, name).not.toContain(short);
          expect(written, name).toContain("[redacted]");
        }
        expect(endpoint.failures()).toEqual([
          expect.objectContaining({
            error: expect.objectContaining({
              _tag: "SyncProtocolViolation",
              reason: "ComponentPathNotAllowed",
            }),
            message: expect.objectContaining({
              args: [{ secret: "[redacted]" }],
            }),
          }),
        ]);
      }),
  );

  it.live(
    "a successful mutation enters its session's ledger with its arguments' digest, and a resend under its request ID is answered from there",
    () =>
      Effect.gen(function* () {
        const t = kernelApp("");
        const socket = yield* rawSocket(t);
        const add = (requestId: number, note: string) => ({
          type: "Mutation",
          requestId,
          udfPath: "sync:add",
          args: [{ name: "ledger", text: note }],
        });
        yield* socket.send(connectMessage("session"));
        yield* socket.send(add(0, "once"));
        yield* socket.send(add(0, "once"));
        const responses = ofType(socket.received, "MutationResponse");
        expect(responses).toHaveLength(2);
        expect(responses[1]).toEqual(responses[0]);
        const notes = yield* Effect.promise(() =>
          t.query(makeFunctionReference("sync:notes"), { name: "ledger" }),
        );
        expect(notes).toEqual(["once"]);
        const [entry, ...rest] = t.sync().ledger();
        expect(rest).toEqual([]);
        assertIs(entry, Predicate.isNotUndefined);
        expect(entry).toMatchObject({
          sessionId: "session",
          requestId: 0,
          functionPath: { componentPath: "", udfPath: "sync:add" },
          attempts: 1,
          result: null,
        });
        expect(entry.argsDigest).toMatch(/^[0-9a-f]{64}$/);
        expect(entry).not.toHaveProperty("args");
        expect(entry).not.toHaveProperty("argsKey");

        yield* socket.send(add(0, "other"));
        expect(Arr.last(socket.received)).toMatchObject(
          Option.some({ type: "FatalError" }),
        );
        expect(socket.state.closed).toBeDefined();
        expect(lastError(t)).toMatchObject(
          Option.some({ _tag: "SyncRequestReused", requestId: 0 }),
        );
      }),
  );

  it.live(
    "a mutation whose call registers a secret is answered from the ledger when its client resends it after a lost response, though the resend's marked arguments differ",
    () =>
      Effect.gen(function* () {
        // The note's text is secret in its table, so the first call keeps it
        // as it writes the row, after its arguments were first digested.
        const note = "ledger-note-secret-91c4";
        const t = kernelApp("", { redaction: notesSecret });
        const client = yield* Legs.connect(kernelTarget(t));
        client.loseNextMutationResponse();
        const outcome = yield* client.mutation("sync:add", {
          name: "resent",
          text: note,
        });
        expect(outcome).toEqual({ value: null });
        expect(client.rejections).toEqual([]);
        expect(client.sockets.length).toBeGreaterThan(1);
        const notes = yield* Effect.promise(() =>
          t.query(makeFunctionReference("sync:notes"), { name: "resent" }),
        );
        expect(notes).toEqual([note]);
        expect(t.sync().failures()).toEqual([]);
        const ledger = t.sync().ledger();
        expect(ledger).toHaveLength(1);
        const written = yield* text(ledger);
        expect(written).not.toContain(note);
      }).pipe(Effect.scoped),
  );

  it.live(
    "a token that expires between two updates answers AuthError before the next update or request runs anything, at the identity version the socket last sent",
    () =>
      Effect.gen(function* () {
        const start = 1_800_000_000_000;
        const clock = { now: start };
        const { jwks, cases } = yield* mint(start / 1000);
        const valid = Option.getOrThrow(
          Arr.findFirst(cases, (c) => c.name === "valid control"),
        ).token;
        const t = kernelApp(jwks, {
          runtime: { now: () => clock.now, commitTs: (v) => BigInt(v) },
        });
        const authenticate = {
          type: "Authenticate",
          tokenType: "User",
          value: valid,
          baseVersion: 0,
        };
        const watching = yield* rawSocket(t);
        yield* watching.send(connectMessage("watching"));
        yield* watching.send(authenticate);
        yield* watching.send({
          type: "ModifyQuerySet",
          baseVersion: 0,
          newVersion: 1,
          modifications: [
            {
              type: "Add",
              queryId: 0,
              udfPath: "sync:counter",
              args: [{ name: "expiring" }],
            },
          ],
        });
        const calling = yield* rawSocket(t);
        yield* calling.send(connectMessage("calling"));
        yield* calling.send(authenticate);
        const sentBefore = watching.received.length;

        // The tokens expire an hour after they were minted, and the binary
        // treats the token as expired once the time reaches its `exp`.
        clock.now = start + 3_600_000;
        yield* Effect.promise(() =>
          t.mutation(makeFunctionReference("sync:increment"), {
            name: "expiring",
          }),
        );
        yield* Effect.sleep(Duration.millis(50));
        expect(Arr.drop(watching.received, sentBefore)).toEqual([
          expect.objectContaining({
            type: "AuthError",
            baseVersion: 1,
            authUpdateAttempted: false,
          }),
        ]);
        expect(watching.state.closed).toMatchObject({ code: 1000 });

        yield* calling.send({
          type: "Mutation",
          requestId: 0,
          udfPath: "sync:add",
          args: [{ name: "expiring", text: "too late" }],
        });
        expect(Arr.last(calling.received)).toMatchObject(
          Option.some({ type: "AuthError", authUpdateAttempted: false }),
        );
        expect(ofType(calling.received, "MutationResponse")).toEqual([]);
        const notes = yield* Effect.promise(() =>
          t.query(makeFunctionReference("sync:notes"), { name: "expiring" }),
        );
        expect(notes).toEqual([]);
        expect(
          Arr.map(t.sync().failures(), (failure) => failure.error),
        ).toMatchObject([
          { _tag: "TokenExpired", code: "TokenExpired" },
          { _tag: "TokenExpired", code: "TokenExpired" },
        ]);
      }),
  );

  it.live(
    "a message the binary's worker refuses answers FatalError, closes the socket and leaves a failure report",
    () =>
      Effect.gen(function* () {
        const t = kernelApp("");
        const refusals = [
          [
            {
              type: "ModifyQuerySet",
              baseVersion: 1,
              newVersion: 2,
              modifications: [],
            },
            { _tag: "SyncProtocolViolation", reason: "BaseVersionMismatch" },
          ],
          [
            { type: "Authenticate", tokenType: "None", baseVersion: 3 },
            {
              _tag: "SyncProtocolViolation",
              reason: "IdentityVersionMismatch",
            },
          ],
          [
            {
              type: "Authenticate",
              tokenType: "Admin",
              value: "key",
              baseVersion: 0,
            },
            { _tag: "RequiresBinary", operation: "adminAuthentication" },
          ],
        ] as const;
        for (const [message, error] of refusals) {
          const socket = yield* rawSocket(t);
          yield* socket.send(connectMessage("refused"));
          yield* socket.send(message);
          expect(Arr.last(socket.received)).toMatchObject(
            Option.some({ type: "FatalError" }),
          );
          expect(socket.state.closed).toMatchObject({ code: 1011 });
          expect(lastError(t)).toMatchObject(Option.some(error));
        }
        const admin = yield* Effect.filter(
          t.sync().transcript(),
          ({ message }) =>
            text(message).pipe(Effect.map(Str.includes("Admin"))),
        );
        expect(admin).toEqual([
          expect.objectContaining({
            direction: "client",
            message: expect.objectContaining({ value: "[redacted]" }),
          }),
        ]);
      }),
  );

  it.live(
    "a token that fails to verify answers AuthError for its identity version and closes the socket",
    () =>
      Effect.gen(function* () {
        const now = yield* nowSeconds;
        const { jwks, cases } = yield* mint(now);
        const t = kernelApp(jwks);
        const socket = yield* rawSocket(t);
        yield* socket.send(connectMessage("auth"));
        yield* socket.send({
          type: "Authenticate",
          tokenType: "User",
          value: Option.getOrThrow(
            Arr.findFirst(cases, (c) => c.name === "expired"),
          ).token,
          baseVersion: 0,
        });
        expect(socket.received).toEqual([
          expect.objectContaining({
            type: "AuthError",
            baseVersion: 0,
            authUpdateAttempted: true,
          }),
        ]);
        expect(socket.state.closed).toMatchObject({ code: 1000 });
        expect(lastError(t)).toMatchObject(
          Option.some({ _tag: "InvalidToken", code: "InvalidAuthHeader" }),
        );
      }),
  );

  it.live(
    "a query whose arguments its validator refuses fails for its client, which keeps its socket and its other queries, and removing it answers QueryRemoved",
    () =>
      Effect.gen(function* () {
        const t = kernelApp("");
        const socket = yield* rawSocket(t);
        yield* socket.send(connectMessage("invalid"));
        yield* socket.send({
          type: "ModifyQuerySet",
          baseVersion: 0,
          newVersion: 1,
          modifications: [
            {
              type: "Add",
              queryId: 0,
              udfPath: "sync:counter",
              args: [{ name: 5 }],
            },
            {
              type: "Add",
              queryId: 1,
              udfPath: "sync:counter",
              args: [{ name: "fine" }],
            },
          ],
        });
        yield* socket.send({
          type: "ModifyQuerySet",
          baseVersion: 1,
          newVersion: 2,
          modifications: [{ type: "Remove", queryId: 0 }],
        });
        const [first, second] = ofType(socket.received, "Transition");
        assertIs(first, Predicate.isNotUndefined);
        assertIs(second, Predicate.isNotUndefined);
        expect(first["modifications"]).toEqual([
          expect.objectContaining({ type: "QueryFailed", queryId: 0 }),
          expect.objectContaining({
            type: "QueryUpdated",
            queryId: 1,
            value: 0,
          }),
        ]);
        expect(first["modifications"][0]).not.toHaveProperty("errorData");
        expect(second["modifications"]).toEqual([
          { type: "QueryRemoved", queryId: 0 },
        ]);
        expect(socket.state.closed).toBeUndefined();
        expect(t.sync().failures()).toEqual([]);
      }),
  );

  it.live(
    "a query a socket added just before it closed leaves no subscription behind, so a later commit leaves the full rerun in agreement",
    () =>
      Effect.gen(function* () {
        const { promise: loaded, resolve: release } =
          Promise.withResolvers<void>();
        const t = kernelApp("", { loaded });
        const socket = yield* rawSocket(t);
        yield* socket.send(connectMessage("closing"));
        // The update starts, and the query's first run waits for the app's
        // modules, which load only once the socket has closed.
        yield* socket.send({
          type: "ModifyQuerySet",
          baseVersion: 0,
          newVersion: 1,
          modifications: [
            {
              type: "Add",
              queryId: 0,
              udfPath: "sync:counter",
              args: [{ name: "late" }],
            },
          ],
        });
        socket.ws.close();
        release();
        yield* Effect.sleep(Duration.millis(100));
        yield* Effect.promise(() =>
          t.mutation(makeFunctionReference("sync:increment"), { name: "late" }),
        );
        const disagreements = yield* Effect.promise(() => t.reference());
        expect(disagreements).toEqual([]);
      }),
  );

  it.live(
    "a commit from the test reaches a socket's client, a test's refresh never takes it, and the full rerun agrees",
    () =>
      Effect.gen(function* () {
        const t = kernelApp("");
        const client = yield* Legs.connect(kernelTarget(t));
        client.watch("counter", "sync:counter", { name: "pushed" });
        yield* client.until(() => client.value("counter") !== undefined);
        yield* Effect.promise(() =>
          t.mutation(makeFunctionReference("sync:increment"), {
            name: "pushed",
          }),
        );
        const refreshed = yield* Effect.promise(() => t.refresh());
        expect(refreshed).toEqual([]);
        const reached = yield* client.until(
          () =>
            (
              client.value("counter") as
                | { readonly value?: unknown }
                | undefined
            )?.value === 1,
        );
        expect(reached).toBe(true);
        expect(client.sequences()["counter"]).toEqual([
          { value: 0 },
          { value: 1 },
        ]);
        const disagreements = yield* Effect.promise(() => t.reference());
        expect(disagreements).toEqual([]);
      }).pipe(Effect.scoped),
  );
});
