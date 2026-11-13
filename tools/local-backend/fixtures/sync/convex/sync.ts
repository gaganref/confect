import { mutationGeneric, queryGeneric } from "convex/server";
import { ConvexError, v } from "convex/values";

/**
 * The functions the sync probe runs on the binary and on the test kernel. Each
 * run names its rows with a fresh `name`, so rows an earlier run left behind
 * never reach what it compares. They are plain Convex functions, written as
 * promise chains as the plain HTTP fixture's are.
 */

export const counter = queryGeneric({
  args: { name: v.string() },
  handler: (ctx, { name }) =>
    ctx.db
      .query("counters")
      .withIndex("by_name", (q) => q.eq("name", name))
      .unique()
      .then((row) => row?.value ?? 0),
});

/**
 * Read the counter, then write it one higher. Two increments that read the same
 * value conflict, and optimistic concurrency control retries one. Twenty more
 * reads before the write, one after another, widen the window in which another
 * increment can commit first.
 */
export const increment = mutationGeneric({
  args: { name: v.string() },
  handler: (ctx, { name }) => {
    const widen = (i: number): Promise<void> =>
      i === 20
        ? Promise.resolve()
        : ctx.db
            .query("notes")
            .withIndex("by_name", (q) => q.eq("name", `${name}:${i}`))
            .first()
            .then(() => widen(i + 1));
    return ctx.db
      .query("counters")
      .withIndex("by_name", (q) => q.eq("name", name))
      .unique()
      .then((row) =>
        widen(0).then(() =>
          row === null
            ? ctx.db.insert("counters", { name, value: 1 }).then(() => 1)
            : ctx.db
                .patch(row._id, { value: row.value + 1 })
                .then(() => row.value + 1),
        ),
      );
  },
});

export const notes = queryGeneric({
  args: { name: v.string() },
  handler: (ctx, { name }) =>
    ctx.db
      .query("notes")
      .withIndex("by_name", (q) => q.eq("name", name))
      .collect()
      .then((rows) => {
        const texts: Array<string> = [];
        for (const row of rows) texts.push(row.text);
        return texts;
      }),
});

export const add = mutationGeneric({
  args: { name: v.string(), text: v.string() },
  handler: (ctx, { name, text }) =>
    ctx.db.insert("notes", { name, text }).then(() => null),
});

/**
 * Fail with structured data, which reaches the client as `errorData`.
 */
export const refuse = mutationGeneric({
  args: { code: v.string() },
  handler: (_ctx, { code }) => Promise.reject(new ConvexError({ code })),
});

/**
 * The caller's subject and role, or `null` signed out. Only an identity change
 * changes it.
 */
export const whoami = queryGeneric({
  args: {},
  handler: (ctx) =>
    ctx.auth.getUserIdentity().then((identity) =>
      identity === null
        ? null
        : {
            subject: identity.subject,
            role: typeof identity["role"] === "string" ? identity["role"] : "",
          },
    ),
});

/**
 * Store a note and answer with the secret it was given, so the secret reaches a
 * response.
 */
export const remember = mutationGeneric({
  args: { name: v.string(), secret: v.string() },
  handler: (ctx, { name, secret }) =>
    ctx.db
      .insert("notes", { name, text: "remembered" })
      .then(() => `kept ${secret}`),
});

/**
 * Fail with the secret it was given in its message and data, so the secret
 * reaches a failure.
 */
export const reveal = mutationGeneric({
  args: { secret: v.string() },
  handler: (_ctx, { secret }) =>
    Promise.reject(new ConvexError({ code: "revealed", secret })),
});

/**
 * Answer with the secret argument, so a subscription's value holds it.
 */
export const peek = queryGeneric({
  args: { secret: v.string() },
  handler: (_ctx, { secret }) => Promise.resolve(`seen ${secret}`),
});

/**
 * Take a secret and answer nothing with it, so only its argument's schema can
 * mark it, as a secret too short for the string backstop.
 */
export const stash = mutationGeneric({
  args: { secret: v.string() },
  handler: () => Promise.resolve(null),
});

/**
 * The time the query ran at. It reads no identity and no row, so only an
 * identity change reruns it, and then the binary's query cache answers it with
 * the value it already sent until that value is older than the cache age.
 * `name` gives each run a cache entry of its own.
 */
export const clock = queryGeneric({
  args: { name: v.string() },
  handler: () =>
    // oxlint-disable-next-line effecttsgo/global-date -- A Convex query reads the time through the `Date` its runtime pins, which is what this fixture observes.
    Promise.resolve(Date.now()),
});

/**
 * Fail with the time the query ran at as its error data. A failure is never
 * cached, so every identity change reruns it and the client sees a new error,
 * within the cache age or after it.
 */
export const failingClock = queryGeneric({
  args: { name: v.string() },
  handler: () =>
    // oxlint-disable-next-line effecttsgo/global-date -- A Convex query reads the time through the `Date` its runtime pins, which is what this fixture observes.
    Promise.reject(new ConvexError({ time: Date.now() })),
});
