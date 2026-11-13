// oxlint-disable effecttsgo/async-function -- The fixtures are plain Convex functions, which are async as product code is.
import * as Table from "@confect/core/Table";
import * as DatabaseSchema from "@confect/server/DatabaseSchema";
import { describe, expect, it } from "@effect/vitest";
import {
  actionGeneric,
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
import type * as Execution from "../src/internal/Execution";
import * as Invocation from "../src/internal/Invocation";
import * as Redaction from "../src/internal/Redaction";

// Each canary reaches the kernel by one route: a handler argument it never
// stores, a stored row, a test provider's answer.
const argumentCanary = "canary-argument-7f3a9c2e";
const openedCanary = "canary-opened-0d4be771";
const rowCanary = "canary-row-51e0b2aa";
const providerCanary = "canary-provider-c48d1190";
const canaries = [argumentCanary, openedCanary, rowCanary, providerCanary];

const Token = Schema.RedactedFromValue(Schema.String);

// The app's Confect schema marks each account's token secret. The kernel reads
// the secret node from it, not from the Convex validators.
const databaseSchema = DatabaseSchema.make({
  accounts: Table.make(() =>
    Schema.Struct({ name: Schema.String, token: Token }),
  )("accounts"),
  notes: Table.make(() => Schema.Struct({ text: Schema.String }))("notes"),
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
              accounts.map(({ name, token }) => ({ name, token })),
            ),
      }),
      notes: queryGeneric({
        args: {},
        handler: (ctx) =>
          ctx.db
            .query("notes")
            .collect()
            .then((notes) => notes.map(({ text }) => text)),
      }),
    }),
};

const convexSchema = defineSchema({
  accounts: defineTable({ name: v.string(), token: v.string() }),
  notes: defineTable({ text: v.string() }),
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

const backend = (): Backend =>
  convexTest({
    schema: convexSchema,
    modules,
    runtime,
    redaction: Redaction.policy({
      tables: { "": Redaction.tablesOf(databaseSchema) },
      functions: { "": functions },
    }),
  });

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
  return `${message}\n${stack ?? ""}\n${JSON.stringify(convexToJson(data ?? null))}`;
};

const outcomeText = (outcome: Execution.Outcome): string =>
  outcome._tag === "returned"
    ? JSON.stringify(convexToJson(outcome.value))
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
          `stored ${rows.map((row: any) => row.token).join(", ")}`,
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
      failures: [refused, readBack, connected].map(report),
      diff: transitions
        .map(({ from, to }) => `${outcomeText(from)}\n${outcomeText(to)}`)
        .join("\n"),
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
          ...Object.fromEntries(
            failures.map((text, i) => [`failure report ${i + 1}`, text]),
          ),
        };
        for (const [name, text] of Object.entries(artifacts)) {
          for (const canary of canaries) {
            expect(text.includes(canary), `${canary} in ${name}`).toBe(false);
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
          (current.value as Array<{ token: string }>).map(({ token }) => token),
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
        expect(yield* call(() => restored.query(app.notes, {}))).toEqual([
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
        expect(
          yield* failure(() =>
            restored.restoreSnapshot(new TextEncoder().encode(snapshot), {
              worlds: [provider],
            }),
          ),
        ).toMatchObject({ _tag: "SnapshotSecretMissing" });
        expect(yield* call(() => restored.query(app.accounts, {}))).toEqual([]);
      }),
  );

  it.effect(
    "a value under a secret node is found through structs, arrays, records, unions and optional fields, and nowhere else",
    () =>
      Effect.sync(() => {
        expect(
          Redaction.secretPaths(
            Schema.Struct({
              plain: Schema.String,
              token: Token,
              maybe: Schema.optional(Token),
              list: Schema.Array(Schema.Struct({ key: Token })),
              byName: Schema.Record(Schema.String, Token),
              either: Schema.Union([Schema.Finite, Token]),
              pair: Schema.Tuple([Schema.String, Token]),
              wrapped: Schema.Redacted(Schema.String),
            }),
          ),
        ).toEqual([
          ["token"],
          ["maybe"],
          ["list", "*", "key"],
          ["byName", "*"],
          ["either"],
          ["pair", "1"],
          ["wrapped"],
        ]);
      }),
  );
});
