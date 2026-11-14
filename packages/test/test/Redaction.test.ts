// oxlint-disable effecttsgo/async-function -- The fixtures are plain Convex functions, which are async as product code is.
// oxlint-disable-next-line effecttsgo/node-builtin-import -- A hand-marked snapshot needs the SHA-256 its header names.
import { createHash } from "node:crypto";
import * as Table from "@confect/core/Table";
import * as DatabaseSchema from "@confect/server/DatabaseSchema";
import { describe, expect, it } from "@effect/vitest";
import {
  actionGeneric,
  cronJobs,
  defineSchema,
  defineTable,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
  type GenericMutationCtx,
} from "convex/server";
import { convexToJson, v, type Value } from "convex/values";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { convexTest, type KernelControls } from "../src/internal/ConvexTest";
import * as Execution from "../src/internal/Execution";
import * as Invocation from "../src/internal/Invocation";
import * as Redaction from "../src/internal/Redaction";
import type * as Subscriptions from "../src/internal/Subscriptions";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe } from "effect/Function";

const UnknownJson = Schema.fromJsonString(Schema.Unknown);
import * as Json from "../src/internal/Json";

// Each canary reaches the kernel by one route: a handler argument it never
// stores, a stored row, a test provider's answer.
const argumentCanary = "canary-argument-7f3a9c2e";
const openedCanary = "canary-opened-0d4be771";
const rowCanary = "canary-row-51e0b2aa";
const providerCanary = "canary-provider-c48d1190";
const canaries = [argumentCanary, openedCanary, rowCanary, providerCanary];

// Each later canary reaches an artifact by one of the routes a review found.
const bareCanary = "canary-bare-3e81d0c2";
const frozenCanary = "canary-frozen-a5b7f913";
const failingCanary = "canary-failing-6c02e4d8";
const compoundCanary = "canary-compound-90ab1f37";
const reusedCanary = "canary-reused-41d8e2b6";
const deepCanary = "canary-deep-7e3c5a01";
const unionCanary = "canary-union-b2f6d48e";
const indexCanary = "canary-index-c9e04a75";
const cycleCanary = "canary-cycle-2f9b61e4";
const deepIndexCanary = "canary-deep-index-8a3c07d5";

const Token = Schema.RedactedFromValue(Schema.String);

// A secret whose value is an object, so its canary sits beneath it.
const Credential = Schema.RedactedFromValue(
  Schema.Struct({ user: Schema.String, key: Schema.String }),
);

// One suspended schema reused at two fields, and a recursive one.
const Inner = Schema.suspend(() => Schema.Struct({ key: Token }));
interface Tree {
  readonly secret: string;
  readonly children: ReadonlyArray<Tree>;
}
const Tree: Schema.Codec<any, Tree> = Schema.Struct({
  secret: Token,
  children: Schema.Array(Schema.suspend(() => Tree)),
});

// A tree whose token sits under a suspension reused down an index path.
const Node: Schema.Codec<any, any> = Schema.Struct({
  token: Token,
  child: Schema.optional(Schema.suspend(() => Node)),
});

// Two union members that share a secret field.
const Either = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("a"), token: Token }),
  Schema.Struct({
    kind: Schema.Literal("b"),
    token: Token,
    note: Schema.String,
  }),
]);

// The app's Confect schema marks each account's token secret. The kernel reads
// the secret node from it, not from the Convex validators.
const databaseSchema = DatabaseSchema.make({
  accounts: Table.make(() =>
    Schema.Struct({ name: Schema.String, token: Token }),
  )("accounts"),
  notes: Table.make(() => Schema.Struct({ text: Schema.String }))("notes"),
  trees: Table.make(() => Schema.Struct({ data: Node }))("trees"),
  links: Table.make(() => Schema.Struct({ target: Token }))("links"),
  vault: Table.make(() =>
    Schema.Struct({
      label: Schema.String,
      credential: Credential,
      either: Either,
    }),
  )("vault"),
});

const functions = {
  "app:open": {
    args: () => Schema.Struct({ name: Schema.String, token: Token }),
  },
  "app:refuse": { args: () => Schema.Struct({ token: Token }) },
  "app:rotate": { args: () => Schema.Struct({ token: Token }) },
  "app:accounts": {
    returns: () =>
      Schema.Array(Schema.Struct({ name: Schema.String, token: Token })),
  },
  "app:throwBare": { args: () => Schema.Struct({ token: Token }) },
  "app:throwFrozen": { args: () => Schema.Struct({ token: Token }) },
  "app:store": {
    args: () => Schema.Struct({ credential: Credential, either: Either }),
  },
  "app:credentials": {
    returns: () =>
      Schema.Array(
        Schema.Struct({ label: Schema.String, credential: Credential }),
      ),
  },
  "app:throwCycle": { args: () => Schema.Struct({ token: Token }) },
  "app:issue": { returns: () => Schema.Struct({ token: Token }) },
  "app:nested": {
    args: () => Schema.Struct({ a: Inner, b: Inner, tree: Tree }),
  },
};

const app = {
  open: makeFunctionReference<"mutation", { name: string; token: string }>(
    "app:open",
  ),
  refuse: makeFunctionReference<"mutation", { token: string }>("app:refuse"),
  rotate: makeFunctionReference<"mutation", { token: string }>("app:rotate"),
  copy: makeFunctionReference<"mutation">("app:copy"),
  connect: makeFunctionReference<"action">("app:connect"),
  accounts: makeFunctionReference<
    "query",
    {},
    Array<{ name: string; token: string }>
  >("app:accounts"),
  notes: makeFunctionReference<"query", {}, Array<string>>("app:notes"),
  throwBare: makeFunctionReference<"mutation", { token: string }>(
    "app:throwBare",
  ),
  throwFrozen: makeFunctionReference<"mutation", { token: string }>(
    "app:throwFrozen",
  ),
  failing: makeFunctionReference<"query">("app:failing"),
  store: makeFunctionReference<"mutation", { credential: any; either: any }>(
    "app:store",
  ),
  credentials: makeFunctionReference<"query">("app:credentials"),
  nested: makeFunctionReference<"mutation", { a: any; b: any; tree: any }>(
    "app:nested",
  ),
  findByToken: makeFunctionReference<"mutation", { token: string }>(
    "app:findByToken",
  ),
  byToken: makeFunctionReference<"query", { token: string }>("app:byToken"),
  throwCycle: makeFunctionReference<"mutation", { token: string }>(
    "app:throwCycle",
  ),
  issue: makeFunctionReference<"mutation", {}, { token: string }>("app:issue"),
  findDeep: makeFunctionReference<"mutation", { token: string }>(
    "app:findDeep",
  ),
};

class Provider extends Context.Service<
  Provider,
  { readonly token: () => string }
>()("@confect/test/test/Redaction.test/Provider") {}

const modules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "app.ts": () =>
    Promise.resolve({
      open: mutationGeneric({
        args: { name: v.string(), token: v.string() },
        handler: async (ctx, { name, token }) => {
          await ctx.db.insert("accounts", { name, token });
          await ctx.scheduler.runAfter(1000, app.rotate, { token });
          return null;
        },
      }),
      refuse: mutationGeneric({
        args: { token: v.string() },
        handler: (_ctx, { token }) => {
          throw new Error(`the token ${token} is refused`);
        },
      }),
      rotate: mutationGeneric({
        args: { token: v.string() },
        handler: (ctx, { token }) =>
          ctx.db.insert("notes", {
            text: `rotated ${canaries.includes(token) ? "raw" : "marked"}`,
          }),
      }),
      copy: mutationGeneric({
        args: {},
        handler: async (ctx) => {
          const account = await ctx.db.query("accounts").first();
          return ctx.db.insert("notes", { text: `copied ${account!.token}` });
        },
      }),
      connect: actionGeneric({
        args: {},
        handler: async (ctx) => {
          const provider = Context.get(
            Invocation.current()!.services as Context.Context<Provider>,
            Provider,
          );
          const token = provider.token();
          await ctx.runMutation(app.open, { name: "provider", token });
          throw new Error(`the provider answered ${token}`);
        },
      }),
      accounts: queryGeneric({
        args: {},
        handler: (ctx) =>
          ctx.db
            .query("accounts")
            .collect()
            .then((accounts) =>
              Arr.map(accounts, ({ name, token }) => ({ name, token })),
            ),
      }),
      throwBare: mutationGeneric({
        args: { token: v.string() },
        handler: (_ctx, { token }) => {
          throw `bare ${token}`;
        },
      }),
      throwFrozen: mutationGeneric({
        args: { token: v.string() },
        handler: (_ctx, { token }) => {
          throw Object.freeze(new Error(`frozen ${token}`));
        },
      }),
      failing: queryGeneric({
        args: {},
        handler: async (ctx) => {
          const accounts = await ctx.db.query("accounts").collect();
          const failing = Option.getOrUndefined(
            Arr.findFirst(accounts, ({ name }) => name === "fail"),
          );
          if (failing !== undefined)
            throw new Error(`failing on ${failing.token}`);
          return accounts.length;
        },
      }),
      store: mutationGeneric({
        args: { credential: v.any(), either: v.any() },
        handler: (ctx, { credential, either }) =>
          ctx.db.insert("vault", { label: "stored", credential, either }),
      }),
      credentials: queryGeneric({
        args: {},
        handler: (ctx) =>
          ctx.db
            .query("vault")
            .collect()
            .then((rows) =>
              Arr.map(rows, ({ label, credential }) => ({ label, credential })),
            ),
      }),
      nested: mutationGeneric({
        args: { a: v.any(), b: v.any(), tree: v.any() },
        handler: (_ctx, { a, b, tree }) => {
          throw new Error(
            `nested ${a.key} ${b.key} ${tree.children[0].secret}`,
          );
        },
      }),
      findByToken: mutationGeneric({
        args: { token: v.string() },
        handler: async (ctx, { token }) => {
          await ctx.db
            .query("accounts")
            .withIndex("by_token", (q) => q.eq("token", token))
            .first();
          return null;
        },
      }),
      throwCycle: mutationGeneric({
        args: { token: v.string() },
        handler: (_ctx, { token }) => {
          const error = new Error(`cyclic ${token}`) as Error & {
            cause?: unknown;
          };
          error.cause = error;
          throw error;
        },
      }),
      issue: mutationGeneric({
        args: {},
        // "ab" is too short for the string backstop, so only the declared
        // return shape marks it.
        handler: () => Promise.resolve({ token: "ab" }),
      }),
      findDeep: mutationGeneric({
        args: { token: v.string() },
        handler: async (ctx, { token }) => {
          await ctx.db
            .query("trees")
            .withIndex("by_deep", (q) => q.eq("data.child.child.token", token))
            .first();
          return null;
        },
      }),
      byToken: queryGeneric({
        args: { token: v.string() },
        handler: (ctx, { token }) =>
          ctx.db
            .query("accounts")
            .withIndex("by_token", (q) => q.eq("token", token))
            .first(),
      }),
      notes: queryGeneric({
        args: {},
        handler: (ctx) =>
          ctx.db
            .query("notes")
            .collect()
            .then((notes) => Arr.map(notes, ({ text }) => text)),
      }),
    }),
};

const convexSchema = defineSchema({
  accounts: defineTable({ name: v.string(), token: v.string() }).index(
    "by_token",
    ["token"],
  ),
  notes: defineTable({ text: v.string() }),
  links: defineTable({ target: v.string() }),
  trees: defineTable({ data: v.any() }).index("by_deep", [
    "data.child.child.token",
  ]),
  vault: defineTable({
    label: v.string(),
    credential: v.any(),
    either: v.any(),
  }),
});

const runtime = {
  now: () => 1_767_225_600_000,
  commitTs: (version: number) => 1_000n + BigInt(version),
};

/**
 * The shim's controls with convex-test's `run`, which writes as a mutation
 * does.
 */
type Backend = KernelControls & {
  readonly run: <A>(
    handler: (ctx: GenericMutationCtx<any>) => Promise<A>,
  ) => Promise<A>;
};

const policy = () =>
  Redaction.policy({
    tables: { "": Redaction.tablesOf(databaseSchema) },
    functions: { "": functions },
  });

const backend = (): Backend =>
  convexTest({ schema: convexSchema, modules, runtime, redaction: policy() });

const provider: Invocation.World = {
  name: "provider",
  services: Context.make(Provider, { token: () => providerCanary }),
  clock: () => runtime.now(),
  random: () => 0.5,
};

const call = <A>(thunk: () => Promise<A>) => Effect.promise(thunk);
const failure = (thunk: () => Promise<unknown>) =>
  call(() =>
    thunk().then(
      () => null,
      (error: unknown) => error,
    ),
  );

/**
 * A failure report as a test runner prints it: the message, the stack and the
 * error's data.
 */
const report = (error: unknown): string => {
  const { message, stack, data } = error as {
    message: string;
    stack?: string;
    data?: Value;
  };
  return `${message}\n${stack ?? ""}\n${Json.stringify(convexToJson(data ?? null))}`;
};

/**
 * A report of anything thrown, as a runner prints it.
 */
const thrownText = (thrown: unknown): string =>
  typeof thrown === "object" && thrown !== null
    ? report(thrown)
    : String(thrown);

const causeText = (because: Subscriptions.Invalidation): string =>
  because.kind === "commit"
    ? Json.stringify(
        convexToJson({
          ...because.change,
          before: because.change.before as Value,
          after: because.change.after as Value,
        } as unknown as Value),
      )
    : Json.stringify(because);

const outcomeText = (outcome: Execution.Outcome): string =>
  outcome._tag === "returned"
    ? Json.stringify(convexToJson(outcome.value))
    : report(outcome.error);

/**
 * Plant every canary, then gather each artifact the kernel writes: the snapshot
 * export, the failure reports and the subscription diff.
 */
const plant = (t: Backend) =>
  Effect.gen(function* () {
    const subscription = yield* call(() =>
      t.subscriber().subscribe(app.accounts, {}),
    );
    yield* call(() =>
      t.mutation(app.open, { name: "opened", token: openedCanary }),
    );
    const refused = yield* failure(() =>
      t.mutation(app.refuse, { token: argumentCanary }),
    );
    yield* call(() =>
      t.run((ctx) =>
        ctx.db.insert("accounts", { name: "row", token: rowCanary }),
      ),
    );
    const readBack = yield* failure(() =>
      t.run(async (ctx) => {
        const rows = await ctx.db.query("accounts").collect();
        throw new Error(
          `stored ${pipe(
            rows,
            Arr.map((row: any) => row.token),
            Arr.join(", "),
          )}`,
        );
      }),
    );
    const connected = yield* failure(() =>
      Invocation.bind(
        Invocation.fresh(provider, "", {
          ip: null,
          userAgent: null,
          requestId: "provider-request",
          scheduledFunctionId: null,
        }),
        () => t.action(app.connect, {}),
      ),
    );
    yield* call(() => t.mutation(app.copy, {}));
    const transitions = yield* call(() => t.refresh());
    return {
      subscription,
      snapshot: new TextDecoder().decode(t.exportSnapshot()),
      failures: Arr.map([refused, readBack, connected], report),
      diff: pipe(
        transitions,
        Arr.map(
          ({ from, to, because }) =>
            `${outcomeText(from)}\n${outcomeText(to)}\n${causeText(because)}`,
        ),
        Arr.join("\n"),
      ),
    };
  });

describe("redaction", () => {
  it.effect(
    "no canary planted through a handler argument, a stored row or a provider answer reaches the snapshot, a failure report or a diff, each of which carries a marker in its place",
    () =>
      Effect.gen(function* () {
        const { snapshot, failures, diff } = yield* plant(backend());
        const artifacts: Record<string, string> = {
          snapshot,
          diff,
          ...Rec.fromEntries(
            Arr.map(failures, (text, i) => [`failure report ${i + 1}`, text]),
          ),
        };
        for (const [name, text] of Rec.toEntries(artifacts)) {
          for (const canary of canaries) {
            expect(
              pipe(text, Str.includes(canary)),
              `${canary} in ${name}`,
            ).toBe(false);
          }
        }
        expect(snapshot).toContain(`"${Redaction.markerKey}"`);
        expect(diff).toContain(Redaction.marker);
        for (const text of failures) expect(text).toContain(Redaction.marker);
      }),
  );

  it.effect(
    "the replay state keeps the raw values: a subscription reads them, and a restore given the kept secrets runs the job with them and exports the same bytes",
    () =>
      Effect.gen(function* () {
        const t = backend();
        const { subscription, snapshot } = yield* plant(t);
        const current = subscription.current().outcome;
        if (current._tag !== "returned") throw current.error;
        expect(
          Arr.map(
            current.value as Array<{ token: string }>,
            ({ token }) => token,
          ),
        ).toEqual([openedCanary, rowCanary, providerCanary]);

        const restored = backend();
        yield* call(() =>
          restored.restoreSnapshot(new TextEncoder().encode(snapshot), {
            worlds: [provider],
            secrets: t.secrets(),
          }),
        );
        expect(new TextDecoder().decode(restored.exportSnapshot())).toBe(
          snapshot,
        );
        expect(
          (yield* call(() => restored.query(app.accounts, {}))).map(
            ({ token }: { token: string }) => token,
          ),
        ).toEqual([openedCanary, rowCanary, providerCanary]);
        yield* call(() => restored.advance(1000));
        const callResult = yield* call(() => restored.query(app.notes, {}));
        expect(callResult).toEqual([
          `copied ${openedCanary}`,
          "rotated raw",
          "rotated raw",
        ]);
      }),
  );

  it.effect(
    "a snapshot that marks secrets refuses to restore without them",
    () =>
      Effect.gen(function* () {
        const { snapshot } = yield* plant(backend());
        const restored = backend();
        const failureResult = yield* failure(() =>
          restored.restoreSnapshot(new TextEncoder().encode(snapshot), {
            worlds: [provider],
          }),
        );
        expect(failureResult).toMatchObject({ _tag: "SnapshotSecretMissing" });
        const callResult = yield* call(() => restored.query(app.accounts, {}));
        expect(callResult).toEqual([]);
      }),
  );

  it.effect(
    "a value under a secret node is marked through structs, optional fields, arrays, records, unions, tuples, a suspension reused at two fields and a recursive value, and nowhere else",
    () =>
      Effect.sync(() => {
        const secrets = new Redaction.Secrets();
        const shape = Schema.Struct({
          plain: Schema.String,
          token: Token,
          maybe: Schema.optional(Token),
          list: Schema.Array(Schema.Struct({ key: Token })),
          byName: Schema.Record(Schema.String, Token),
          either: Schema.Union([Schema.Finite, Token]),
          pair: Schema.Tuple([Schema.String, Token]),
          wrapped: Schema.Redacted(Schema.String),
          a: Inner,
          b: Inner,
          tree: Tree,
          overlap: Either,
        }).ast;
        const value = {
          plain: "plain",
          token: "t",
          maybe: "m",
          list: [{ key: "k1" }, { key: "k2" }],
          byName: { x: "r" },
          either: 7,
          pair: ["first", "second"],
          wrapped: "w",
          a: { key: "a" },
          b: { key: "b" },
          tree: {
            secret: "root",
            children: [{ secret: "child", children: [] }],
          },
          overlap: { kind: "b", token: "o", note: "n" },
        };
        const at = (raw: string) => ({
          [Redaction.markerKey]: secrets.keep(raw),
        });
        expect(Redaction.mark(value, [{ at: [], shape }], secrets)).toEqual({
          plain: "plain",
          token: at("t"),
          maybe: at("m"),
          list: [{ key: at("k1") }, { key: at("k2") }],
          byName: { x: at("r") },
          either: 7,
          pair: ["first", at("second")],
          wrapped: at("w"),
          a: { key: at("a") },
          b: { key: at("b") },
          tree: {
            secret: at("root"),
            children: [{ secret: at("child"), children: [] }],
          },
          overlap: { kind: "b", token: at("o"), note: "n" },
        });
      }),
  );
});

describe("redaction routes", () => {
  it.effect(
    "a bare throw and a frozen error reach their failure reports marked, and the frozen error keeps its class",
    () =>
      Effect.gen(function* () {
        const t = backend();
        const bare = yield* failure(() =>
          t.mutation(app.throwBare, { token: bareCanary }),
        );
        const frozen = yield* failure(() =>
          t.mutation(app.throwFrozen, { token: frozenCanary }),
        );
        expect(thrownText(bare)).not.toContain(bareCanary);
        expect(thrownText(bare)).toContain(Redaction.marker);
        expect(thrownText(frozen)).not.toContain(frozenCanary);
        expect(thrownText(frozen)).toContain(Redaction.marker);
        expect(frozen).toBeInstanceOf(Error);
      }),
  );

  it.effect(
    "a failing subscription's report is marked, while its cached error stays raw, so a full rerun finds no disagreement",
    () =>
      Effect.gen(function* () {
        const t = backend();
        const subscription = yield* call(() =>
          t.subscriber().subscribe(app.failing, {}),
        );
        yield* call(() =>
          t.mutation(app.open, { name: "fail", token: failingCanary }),
        );
        const transitions = yield* call(() => t.refresh());
        const diff = pipe(
          transitions,
          Arr.map(
            ({ from, to, because }) =>
              `${outcomeText(from)}\n${outcomeText(to)}\n${causeText(because)}`,
          ),
          Arr.join("\n"),
        );
        expect(diff).not.toContain(failingCanary);
        expect(diff).toContain(Redaction.marker);
        const cached = subscription.current().outcome;
        if (cached._tag !== "failed") throw new Error("expected a failure");
        expect((cached.error as Error).message).toContain(failingCanary);
        const callResult = yield* call(() => t.reference());
        expect(callResult).toEqual([]);
      }),
  );

  it.effect(
    "a compound secret's nested canary reaches neither a failure report nor a diff, and two union members sharing a secret field restore it once",
    () =>
      Effect.gen(function* () {
        const t = backend();
        const subscription = yield* call(() =>
          t.subscriber().subscribe(app.credentials, {}),
        );
        yield* call(() =>
          t.mutation(app.store, {
            // "zq" is too short for the string backstop, so only the schema
            // marks it.
            credential: { user: "zq", key: compoundCanary },
            either: { kind: "b", token: unionCanary, note: "note" },
          }),
        );
        const transitions = yield* call(() => t.refresh());
        const diff = pipe(
          transitions,
          Arr.map(
            ({ from, to, because }) =>
              `${outcomeText(from)}\n${outcomeText(to)}\n${causeText(because)}`,
          ),
          Arr.join("\n"),
        );
        const reported = yield* failure(() =>
          t.run(async (ctx) => {
            const row = await ctx.db.query("vault").first();
            throw new Error(`stored key ${row!.credential.key}`);
          }),
        );
        const snapshot = t.exportSnapshot();
        for (const text of [
          diff,
          report(reported),
          new TextDecoder().decode(snapshot),
        ]) {
          expect(text).not.toContain(compoundCanary);
          expect(text).not.toContain(unionCanary);
        }
        expect(diff).not.toContain('"zq"');
        expect(subscription.current().outcome).toMatchObject({
          value: [{ credential: { key: compoundCanary } }],
        });
        const restored = backend();
        yield* call(() =>
          restored.restoreSnapshot(snapshot, { secrets: t.secrets() }),
        );
        const callResult = yield* call(() =>
          restored.run((ctx) => ctx.db.query("vault").first()),
        );
        expect(callResult).toMatchObject({
          credential: { key: compoundCanary },
          either: { token: unionCanary },
        });
      }),
  );

  it.effect(
    "a secret under a suspended schema reused at a second field, and one deep in a recursive value, never reach a failure report",
    () =>
      Effect.gen(function* () {
        const reported = yield* failure(() =>
          backend().mutation(app.nested, {
            a: { key: "canary-first-field" },
            b: { key: reusedCanary },
            tree: {
              secret: "canary-tree-root",
              children: [{ secret: deepCanary, children: [] }],
            },
          }),
        );
        expect(report(reported)).not.toContain(reusedCanary);
        expect(report(reported)).not.toContain(deepCanary);
      }),
  );

  it.effect(
    "a read record's key on a secret index field is the marker in a held attempt and a subscription, though no call ever kept that value",
    () =>
      Effect.gen(function* () {
        const t = backend();
        const prepared = yield* call(() =>
          t.prepare(app.findByToken, { token: indexCanary }),
        );
        const subscription = yield* call(() =>
          t.subscriber().subscribe(app.byToken, { token: indexCanary }),
        );
        const records = yield* Schema.encodeEffect(UnknownJson)([
          prepared.reads,
          Arr.map(t.held(), ({ reads }) => reads),
          subscription.current().reads,
        ]);
        expect(records).not.toContain(indexCanary);
        expect(records).toContain(Redaction.marker);
      }),
  );

  it.effect(
    "a provider command log marks its input by the shape of the function's arguments",
    () =>
      Effect.sync(() => {
        const world = new Execution.World(
          convexSchema,
          modules,
          runtime,
          policy(),
        );
        expect(
          world.projectArguments(
            { componentPath: "", udfPath: "app:open" },
            { name: "provider", token: providerCanary },
          ),
        ).toEqual({ name: "provider", token: Redaction.marker });
      }),
  );

  it.effect(
    "a failure whose cause is itself, or a two-error cycle, reports marked copies that cycle to each other, and the raw errors stay as they were",
    () =>
      Effect.sync(() => {
        const secrets = new Redaction.Secrets();
        secrets.keep(cycleCanary);
        const self = new Error(`self ${cycleCanary}`) as Error & {
          cause?: unknown;
        };
        self.cause = self;
        const reported = Redaction.failure(self, secrets) as typeof self;
        expect(reported).not.toBe(self);
        expect(reported.message).toBe(`self ${Redaction.marker}`);
        expect(reported.cause).toBe(reported);
        expect(self.message).toContain(cycleCanary);

        const outer = new Error("outer") as Error & { cause?: unknown };
        const inner = new Error(`inner ${cycleCanary}`) as Error & {
          cause?: unknown;
        };
        outer.cause = inner;
        inner.cause = outer;
        const copy = Redaction.failure(outer, secrets) as typeof outer;
        const copiedInner = copy.cause as typeof inner;
        expect(copiedInner).not.toBe(inner);
        expect(copiedInner.message).toBe(`inner ${Redaction.marker}`);
        expect(copiedInner.cause).toBe(copy);
        expect(inner.message).toContain(cycleCanary);
      }),
  );

  it.effect(
    "a failure through the kernel whose cause is itself reaches its report marked, cause included",
    () =>
      Effect.gen(function* () {
        const reported = (yield* failure(() =>
          backend().mutation(app.throwCycle, { token: cycleCanary }),
        )) as Error & { cause?: Error };
        expect(reported.message).not.toContain(cycleCanary);
        expect(reported.cause?.message).not.toContain(cycleCanary);
        expect(reported.cause).toBe(reported);
      }),
  );

  it.effect(
    "a read record's key on a secret field reached through a reused suspension down the index path is the marker, on an empty table",
    () =>
      Effect.gen(function* () {
        expect(
          Redaction.sensitiveAt(Schema.Struct({ data: Node }).ast, [
            "data",
            "child",
            "child",
            "token",
          ]),
        ).toBe(true);
        const t = backend();
        const prepared = yield* call(() =>
          t.prepare(app.findDeep, { token: deepIndexCanary }),
        );
        const records = yield* Schema.encodeEffect(UnknownJson)(prepared.reads);
        expect(records).not.toContain(deepIndexCanary);
        expect(records).toContain(Redaction.marker);
      }),
  );

  it.effect(
    "a held attempt's outcome and its applied result are marked by the mutation's return shape, while a normal call returns the raw value to its caller",
    () =>
      Effect.gen(function* () {
        const t = backend();
        const prepared = yield* call(() => t.prepare(app.issue, {}));
        expect(prepared.outcome).toEqual({
          _tag: "returned",
          value: { token: Redaction.marker },
        });
        expect(Arr.map(t.held(), ({ outcome }) => outcome)).toEqual([
          prepared.outcome,
        ]);
        const callResult = yield* call(() => t.apply(prepared.id));
        expect(callResult).toMatchObject({
          kind: "applied",
          result: { token: Redaction.marker },
        });
        const callResult2 = yield* call(() => t.mutation(app.issue, {}));
        expect(callResult2).toEqual({
          token: "ab",
        });
      }),
  );

  it.effect(
    "a secret field holding a document ID round-trips: the export marks the field but never the document's own ID",
    () =>
      Effect.gen(function* () {
        const t = backend();
        const id = yield* call(() =>
          t.run((ctx) => ctx.db.insert("notes", { text: "target" })),
        );
        yield* call(() =>
          t.run((ctx) => ctx.db.insert("links", { target: id })),
        );
        const snapshot = t.exportSnapshot();
        const text = new TextDecoder().decode(snapshot);
        expect(text).toContain(`"_id":"${id}"`);
        expect(text).not.toContain(`"target":"${id}"`);
        const restored = backend();
        yield* call(() =>
          restored.restoreSnapshot(snapshot, { secrets: t.secrets() }),
        );
        const callResult = yield* call(() =>
          restored.run(async (ctx) => {
            const link = await ctx.db.query("links").first();
            const note = await ctx.db.get(link!.target);
            return { target: link!.target, note: note?.text };
          }),
        );
        expect(callResult).toEqual({ target: id, note: "target" });
      }),
  );

  it.effect(
    "a snapshot whose document ID is marked restores once its secrets are back, since restore puts them back before it checks system fields",
    () =>
      Effect.gen(function* () {
        const t = backend();
        const id = yield* call(() =>
          t.run((ctx) => ctx.db.insert("notes", { text: "marked" })),
        );
        const secrets = t.secrets();
        const ref = secrets.keep(id);
        const marker = { [Redaction.markerKey]: ref };
        const snapshot = new TextDecoder().decode(t.exportSnapshot());
        const bodyStart =
          pipe(
            snapshot,
            Str.indexOf("\n"),
            Option.getOrElse(() => -1),
          ) + 1;
        const body = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Any),
        )(pipe(snapshot, Str.slice(bodyStart)));
        for (const entry of body.tables)
          for (const row of entry.rows)
            if (row.doc._id === id) row.doc._id = marker;
        for (const commit of body.log)
          for (const change of commit.changes)
            if (change.after?._id === id) change.after._id = marker;
        const edited = yield* Schema.encodeEffect(UnknownJson)(body);
        const marked = new TextEncoder().encode(
          `confect-kernel-snapshot 4 sha256:${createHash("sha256")
            .update(edited)
            .digest("hex")}\n${edited}`,
        );
        const restored = backend();
        yield* call(() => restored.restoreSnapshot(marked, { secrets }));
        const callResult = yield* call(() =>
          restored.run((ctx) => ctx.db.get(id)),
        );
        expect(callResult).toMatchObject({ _id: id, text: "marked" });
      }),
  );

  it.effect(
    "a failure copy keeps an array's own properties beside its entries",
    () =>
      Effect.sync(() => {
        const secrets = new Redaction.Secrets();
        secrets.keep(cycleCanary);
        const details = Object.assign(["first", `second ${cycleCanary}`], {
          code: "E42",
          attempt: 3,
        });
        const error = Object.assign(new Error("failed"), { details });
        const reported = Redaction.failure(error, secrets) as typeof error;
        expect(reported.details).not.toBe(details);
        expect([...reported.details]).toEqual([
          "first",
          `second ${Redaction.marker}`,
        ]);
        expect(reported.details.code).toBe("E42");
        expect(reported.details.attempt).toBe(3);
        expect(details[1]).toContain(cycleCanary);
      }),
  );
});

// A cron job whose function throws its own secret argument.
const cronCanary = "canary-cron-1b7e4d93";
const failWith = makeFunctionReference<"mutation", { token: string }>(
  "cronFail:failWith",
);
const cronBackend = (): KernelControls => {
  const crons = cronJobs();
  crons.interval("leaky", { minutes: 1 }, failWith, { token: cronCanary });
  return convexTest({
    schema: defineSchema({}),
    modules: {
      "_generated/server.ts": () => Promise.resolve({}),
      "cronFail.ts": () =>
        Promise.resolve({
          failWith: mutationGeneric({
            args: { token: v.string() },
            handler: (_ctx, { token }) =>
              Promise.reject(new Error(`failed with ${token}`)),
          }),
        }),
      "crons.ts": () => Promise.resolve({ default: crons }),
    },
    runtime,
    redaction: Redaction.policy({
      functions: {
        "": {
          "cronFail:failWith": { args: () => Schema.Struct({ token: Token }) },
        },
      },
    }),
  });
};

describe("cron outcomes", () => {
  it.effect(
    "a cron run's failure text reaches crons() and a snapshot only marked, and a restore puts the raw text back for the next export",
    () =>
      Effect.gen(function* () {
        const t = cronBackend();
        yield* call(() => t.advance(0));
        const [leaky] = t.crons();
        expect(leaky!.last).toEqual({
          kind: "failed",
          error: expect.stringContaining(`failed with ${Redaction.marker}`),
        });
        const cronsText = yield* Schema.encodeEffect(UnknownJson)(t.crons());
        expect(cronsText).not.toContain(cronCanary);
        const bytes = t.exportSnapshot();
        const exported = new TextDecoder().decode(bytes);
        expect(exported).not.toContain(cronCanary);
        expect(exported).toContain('"error":{"$redacted":');
        const after = t.crons();
        const afterText = yield* Schema.encodeEffect(UnknownJson)(after);
        expect(afterText).not.toContain(cronCanary);

        const restored = cronBackend();
        yield* call(() =>
          restored.restoreSnapshot(bytes, { secrets: t.secrets() }),
        );
        expect(restored.crons()).toEqual(after);
        expect(new TextDecoder().decode(restored.exportSnapshot())).toBe(
          exported,
        );
      }),
  );
});
