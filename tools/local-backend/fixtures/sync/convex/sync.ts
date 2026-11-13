// oxlint-disable effecttsgo/async-function, effecttsgo/prefer-effect-array, effecttsgo/global-date -- The fixtures are plain Convex functions, async as product code is, and the app depends on `convex` alone; `clock` answers Convex's own pinned `Date.now()`.
import { mutationGeneric, queryGeneric } from "convex/server";
import { ConvexError, v } from "convex/values";

/**
 * The functions the sync probe runs on the binary and on the test kernel. Each
 * run names its rows with a fresh `name`, so rows an earlier run left behind
 * never reach what it compares.
 */

export const counter = queryGeneric({
  args: { name: v.string() },
  handler: async (ctx, { name }) =>
    (
      await ctx.db
        .query("counters")
        .withIndex("by_name", (q) => q.eq("name", name))
        .unique()
    )?.value ?? 0,
});

/**
 * Read the counter, then write it one higher. Two increments that read the same
 * value conflict, and optimistic concurrency control retries one.
 */
export const increment = mutationGeneric({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const row = await ctx.db
      .query("counters")
      .withIndex("by_name", (q) => q.eq("name", name))
      .unique();
    // More reads before the write widen the window in which another
    // increment can commit first.
    for (let i = 0; i < 20; i++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each read is its own syscall, so the reads take turns.
      await ctx.db
        .query("notes")
        .withIndex("by_name", (q) => q.eq("name", `${name}:${i}`))
        .first();
    }
    if (row === null) {
      await ctx.db.insert("counters", { name, value: 1 });
      return 1;
    }
    await ctx.db.patch(row._id, { value: row.value + 1 });
    return row.value + 1;
  },
});

export const notes = queryGeneric({
  args: { name: v.string() },
  handler: async (ctx, { name }) =>
    (
      await ctx.db
        .query("notes")
        .withIndex("by_name", (q) => q.eq("name", name))
        .collect()
    ).map((note) => note.text),
});

export const add = mutationGeneric({
  args: { name: v.string(), text: v.string() },
  handler: async (ctx, { name, text }) => {
    await ctx.db.insert("notes", { name, text });
    return null;
  },
});

/**
 * Fail with structured data, which reaches the client as `errorData`.
 */
export const refuse = mutationGeneric({
  args: { code: v.string() },
  handler: async (_ctx, { code }) => {
    throw new ConvexError({ code });
  },
});

/**
 * The caller's subject and role, or `null` signed out. Only an identity change
 * changes it.
 */
export const whoami = queryGeneric({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    return identity === null
      ? null
      : {
          subject: identity.subject,
          role: typeof identity["role"] === "string" ? identity["role"] : "",
        };
  },
});

/**
 * Store a note and answer with the secret it was given, so the secret reaches a
 * response.
 */
export const remember = mutationGeneric({
  args: { name: v.string(), secret: v.string() },
  handler: async (ctx, { name, secret }) => {
    await ctx.db.insert("notes", { name, text: "remembered" });
    return `kept ${secret}`;
  },
});

/**
 * Fail with the secret it was given in its message and data, so the secret
 * reaches a failure.
 */
export const reveal = mutationGeneric({
  args: { secret: v.string() },
  handler: async (_ctx, { secret }) => {
    throw new ConvexError({ code: "revealed", secret });
  },
});

/**
 * Answer with the secret argument, so a subscription's value holds it.
 */
export const peek = queryGeneric({
  args: { secret: v.string() },
  handler: async (_ctx, { secret }) => `seen ${secret}`,
});

/**
 * Take a secret and answer nothing with it, so only its argument's schema can
 * mark it, as a secret too short for the string backstop.
 */
export const stash = mutationGeneric({
  args: { secret: v.string() },
  handler: async () => null,
});

/**
 * The time the query ran at. It reads no identity and no row, so only an
 * identity change reruns it, and then the binary's query cache answers it with
 * the value it already sent until that value is older than the cache age.
 * `name` gives each run a cache entry of its own.
 */
export const clock = queryGeneric({
  args: { name: v.string() },
  handler: async () => Date.now(),
});
