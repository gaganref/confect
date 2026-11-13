import { describe, expect, it } from "@effect/vitest";
import { makeFunctionReference } from "convex/server";
import type { JSONValue } from "convex/values";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { KernelControls } from "../src/internal/ConvexTest";
import { mint } from "./fixtures/minted";
import { kernelApp, kernelTarget } from "./fixtures/syncApp";
import * as Legs from "./fixtures/syncLegs";

const secret = "canary-7f3a9c";

/**
 * A secret shorter than the string backstop searches for, so only its
 * argument's schema marks it.
 */
const short = "§¶";

// The tests that mint tokens run live, so this is the host's time, the time
// the kernel's wall-clock runtime verifies them at.
const nowSeconds = Clock.currentTimeMillis.pipe(
  Effect.map((millis) => Math.floor(millis / 1000)),
);

const tokens = Effect.gen(function* () {
  const { jwks, cases, signDeclared } = yield* mint(yield* nowSeconds);
  return {
    jwks,
    tokens: {
      person: cases.find((c) => c.name === "valid control")!.token,
      other: yield* signDeclared({ sub: "other", role: "teacher" }),
    },
  };
});

describe("the unmodified client on the kernel", () => {
  it.live(
    "leg 1: two clients see each step's values, outcomes and identities",
    () =>
      Effect.gen(function* () {
        const { jwks, tokens: minted } = yield* tokens;
        const t = kernelApp(jwks);
        const observed = yield* Effect.promise(() =>
          Legs.observable(kernelTarget(t), "leg1", minted, secret),
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
        expect(yield* Effect.promise(() => t.reference())).toEqual([]);
      }),
  );

  it.live(
    "leg 2: concurrent increments contend and none is lost or counted twice",
    () =>
      Effect.gen(function* () {
        const { jwks } = yield* tokens;
        const t = kernelApp(jwks);
        expect(
          yield* Effect.promise(() => Legs.occ(kernelTarget(t), "leg2")),
        ).toEqual({ contended: true, consistent: true });
      }),
  );

  it.live(
    "leg 3: the client accepts every message, through a lost response and a reconnect",
    () =>
      Effect.gen(function* () {
        const { jwks, tokens: minted } = yield* tokens;
        const t = kernelApp(jwks);
        expect(
          yield* Effect.promise(() =>
            Legs.acceptance(kernelTarget(t), "leg3", minted),
          ),
        ).toEqual(Legs.accepted);
      }),
  );
});

/**
 * A socket on `t`'s sync endpoint driven by hand, for messages the unmodified
 * client never sends. It waits on the socket's callbacks and a short host
 * timer, as a client of the WebSocket surface does.
 */
// oxlint-disable effecttsgo/new-promise, effecttsgo/global-timers, unicorn/prefer-add-event-listener -- The kernel socket has the `on*` surface the Convex client uses, whose callbacks these promises wrap.
const rawSocket = (t: KernelControls) => {
  const ws = new (t.sync().WebSocket)("ws://kernel.invalid");
  const received: Array<Record<string, any>> = [];
  const state: { closed: { code: number; reason: string } | undefined } = {
    closed: undefined,
  };
  const opened = new Promise<void>((resolve) => {
    ws.onopen = () => resolve();
  });
  ws.onmessage = (event) => {
    received.push(JSON.parse(event.data));
  };
  ws.onclose = (event) => {
    state.closed = { code: event.code, reason: event.reason };
  };
  const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 50));
  return {
    received,
    state,
    send: (message: object) =>
      opened.then(() => {
        ws.send(JSON.stringify(message));
        return settled();
      }),
  };
};

const connectMessage = (sessionId: string) => ({
  type: "Connect",
  sessionId,
  connectionCount: 0,
  lastCloseReason: "InitialConnect",
  clientTs: 0,
});

/**
 * `json` as text, with bigints as their digits.
 */
const text = (json: unknown) =>
  JSON.stringify(json, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );

describe("Sync's artifacts", () => {
  it.live(
    "a secret argument sent through Sync reaches no protocol artifact, while the client gets the raw values",
    () =>
      Effect.gen(function* () {
        const { jwks } = yield* tokens;
        const t = kernelApp(jwks);
        const client = Legs.connect(kernelTarget(t));
        client.watch("peek", "sync:peek", { secret });
        const remembered = yield* Effect.promise(() =>
          client.mutation("sync:remember", { name: "canary", secret }),
        );
        const revealed = yield* Effect.promise(() =>
          client.mutation("sync:reveal", { secret }),
        );
        const stashed = yield* Effect.promise(() =>
          client.mutation("sync:stash", { secret: short }),
        );
        yield* Effect.promise(() =>
          client.until(() => client.value("peek") !== undefined),
        );
        expect(remembered).toEqual({ value: `kept ${secret}` });
        expect(revealed).toEqual({
          failed: { data: { code: "revealed", secret } },
        });
        expect(client.value("peek")).toEqual({ value: `seen ${secret}` });
        expect(stashed).toEqual({ value: null });
        yield* Effect.promise(() => client.close());

        // A call the binary's worker refuses, whose report names its message.
        const socket = rawSocket(t);
        yield* Effect.promise(() => socket.send(connectMessage("canary")));
        yield* Effect.promise(() =>
          socket.send({
            type: "Mutation",
            requestId: 0,
            udfPath: "sync:stash",
            args: [{ secret: short }],
            componentPath: "child",
          }),
        );

        const endpoint = t.sync();
        const record = endpoint.redact({
          observations: client.sequences() as Record<string, Array<JSONValue>>,
          outcomes: [remembered, revealed],
        });
        const artifacts = {
          ledger: endpoint.ledger(),
          transcript: endpoint.transcript(),
          failures: endpoint.failures(),
          record,
        };
        for (const [name, artifact] of Object.entries(artifacts)) {
          expect(text(artifact), name).not.toContain(secret);
          expect(text(artifact), name).not.toContain(short);
          expect(text(artifact), name).toContain("[redacted]");
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
        const socket = rawSocket(t);
        const add = (requestId: number, note: string) => ({
          type: "Mutation",
          requestId,
          udfPath: "sync:add",
          args: [{ name: "ledger", text: note }],
        });
        yield* Effect.promise(() => socket.send(connectMessage("session")));
        yield* Effect.promise(() => socket.send(add(0, "once")));
        yield* Effect.promise(() => socket.send(add(0, "once")));
        const responses = socket.received.filter(
          (message) => message["type"] === "MutationResponse",
        );
        expect(responses).toHaveLength(2);
        expect(responses[1]).toEqual(responses[0]);
        expect(
          yield* Effect.promise(() =>
            t.query(makeFunctionReference("sync:notes"), { name: "ledger" }),
          ),
        ).toEqual(["once"]);
        const [entry, ...rest] = t.sync().ledger();
        expect(rest).toEqual([]);
        expect(entry).toMatchObject({
          sessionId: "session",
          requestId: 0,
          functionPath: { componentPath: "", udfPath: "sync:add" },
          attempts: 1,
          result: null,
        });
        expect(entry!.argsDigest).toMatch(/^[0-9a-f]{64}$/);
        expect(entry).not.toHaveProperty("args");

        yield* Effect.promise(() => socket.send(add(0, "other")));
        expect(socket.received.at(-1)).toMatchObject({ type: "FatalError" });
        expect(socket.state.closed).toBeDefined();
        expect(t.sync().failures().at(-1)?.error).toMatchObject({
          _tag: "SyncRequestReused",
          requestId: 0,
        });
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
          const socket = rawSocket(t);
          yield* Effect.promise(() => socket.send(connectMessage("refused")));
          yield* Effect.promise(() => socket.send(message));
          expect(socket.received.at(-1)).toMatchObject({ type: "FatalError" });
          expect(socket.state.closed).toMatchObject({ code: 1011 });
          expect(t.sync().failures().at(-1)?.error).toMatchObject(error);
        }
        expect(
          t
            .sync()
            .transcript()
            .filter(({ message }) => text(message).includes("Admin")),
        ).toEqual([
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
        const { jwks, cases } = yield* mint(yield* nowSeconds);
        const t = kernelApp(jwks);
        const socket = rawSocket(t);
        yield* Effect.promise(() => socket.send(connectMessage("auth")));
        yield* Effect.promise(() =>
          socket.send({
            type: "Authenticate",
            tokenType: "User",
            value: cases.find((c) => c.name === "expired")!.token,
            baseVersion: 0,
          }),
        );
        expect(socket.received).toEqual([
          expect.objectContaining({
            type: "AuthError",
            baseVersion: 0,
            authUpdateAttempted: true,
          }),
        ]);
        expect(socket.state.closed).toMatchObject({ code: 1000 });
        expect(t.sync().failures().at(-1)?.error).toMatchObject({
          _tag: "InvalidToken",
          code: "InvalidAuthHeader",
        });
      }),
  );

  it.live(
    "a commit from the test reaches a socket's client, a test's refresh never takes it, and the full rerun agrees",
    () =>
      Effect.gen(function* () {
        const t = kernelApp("");
        const client = Legs.connect(kernelTarget(t));
        client.watch("counter", "sync:counter", { name: "pushed" });
        yield* Effect.promise(() =>
          client.until(() => client.value("counter") !== undefined),
        );
        yield* Effect.promise(() =>
          t.mutation(makeFunctionReference("sync:increment"), {
            name: "pushed",
          }),
        );
        expect(yield* Effect.promise(() => t.refresh())).toEqual([]);
        expect(
          yield* Effect.promise(() =>
            client.until(() => text(client.value("counter")) === '{"value":1}'),
          ),
        ).toBe(true);
        expect(client.sequences()["counter"]).toEqual([
          { value: 0 },
          { value: 1 },
        ]);
        expect(yield* Effect.promise(() => t.reference())).toEqual([]);
        yield* Effect.promise(() => client.close());
      }),
  );
});
