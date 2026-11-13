// oxlint-disable effecttsgo/async-function -- The fixtures are plain Convex functions, which are async as product code is.
import { assert, describe, expect, it } from "@effect/vitest";
import {
  defineSchema,
  defineTable,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
  type GenericActionCtx,
  type GenericDataModel,
  type GenericMutationCtx,
  type GenericQueryCtx,
} from "convex/server";
import * as Table from "@confect/core/Table";
import * as DatabaseSchema from "@confect/server/DatabaseSchema";
import { Base64, v, type GenericId } from "convex/values";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { convexTest, type KernelControls } from "../src/internal/ConvexTest";
import * as Redaction from "../src/internal/Redaction";
import * as Array from "effect/Array";

// The binary answers these for one stored blob. The local-backend case
// "keeps one stored blob's _storage row, metadata, URL and delete as the test
// kernel simulates them" (`packages/server/test/local-backend/storage.test.ts`)
// checks the same answers against the pinned binary.
const hello = {
  text: "hello",
  sha256: "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=",
  hex: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
};
const world = "SG6kYiTRu0+2gPNPfJrZao8k7Ii+c+qOWmxlJg6cuKc=";

type StorageId = GenericId<"_storage">;
type ActionCtx = GenericActionCtx<GenericDataModel>;
type MutationCtx = GenericMutationCtx<GenericDataModel>;
type QueryCtx = GenericQueryCtx<GenericDataModel>;

const schema = defineSchema({ notes: defineTable({ text: v.string() }) });

const files = {
  readThenNote: makeFunctionReference<"mutation", { id: StorageId }>(
    "files:readThenNote",
  ),
  urlOf: makeFunctionReference<"query", { id: StorageId }, string | null>(
    "files:urlOf",
  ),
};

const modules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "files.ts": () =>
    Promise.resolve({
      urlOf: queryGeneric({
        args: { id: v.id("_storage") },
        handler: (ctx, { id }) => ctx.storage.getUrl(id),
      }),
      readThenNote: mutationGeneric({
        args: { id: v.id("_storage") },
        handler: async (ctx, { id }) => {
          const url = await ctx.storage.getUrl(id);
          await ctx.db.insert("notes", { text: url ?? "gone" });
          return null;
        },
      }),
    }),
};

const storageWorld = (): KernelControls & {
  readonly run: (handler: (ctx: MutationCtx) => Promise<any>) => Promise<any>;
  readonly runInComponent: (
    componentPath: string,
    handler: (ctx: MutationCtx) => Promise<any>,
  ) => Promise<any>;
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>;
  readonly registerComponent: (
    componentPath: string,
    schema: unknown,
    modules: Record<string, () => Promise<any>>,
  ) => unknown;
} => convexTest(schema, modules);

const call = <A>(thunk: () => Promise<A>) => Effect.promise(thunk);

const storeFromAction =
  (blob: Blob, sha256?: string) =>
  (ctx: ActionCtx): Promise<StorageId> =>
    ctx.storage.store(blob, sha256 === undefined ? undefined : { sha256 });

const describeFile = (id: StorageId | string) => (ctx: QueryCtx) =>
  Promise.all([
    ctx.db.system.get(id as StorageId),
    ctx.storage.getMetadata(id as StorageId),
    ctx.storage.getUrl(id as StorageId),
  ]).then(([doc, metadata, url]) => ({ doc, metadata, url }));

/**
 * Every `_storage` row, serialized, so a refused store can be shown to change
 * nothing.
 */
const allFiles = (ctx: QueryCtx) =>
  ctx.db.system
    .query("_storage")
    .collect()
    .then((rows) => JSON.stringify(rows));

describe("storage metadata", () => {
  it.effect(
    "a stored file has the binary's _storage row, deprecated metadata and URL",
    () =>
      Effect.gen(function* () {
        const t = storageWorld();
        const id = yield* call(() =>
          t.action(
            storeFromAction(
              new Blob([hello.text], { type: "text/plain" }),
              hello.sha256,
            ),
          ),
        );
        const described = yield* call(() => t.query(describeFile(id)));
        expect(described.doc).toStrictEqual({
          _id: id,
          _creationTime: described.doc._creationTime,
          sha256: hello.sha256,
          size: 5,
          contentType: "text/plain",
        });
        expect(typeof described.doc._creationTime).toBe("number");
        expect(described.metadata).toStrictEqual({
          storageId: described.metadata.storageId,
          sha256: hello.hex,
          size: 5,
          contentType: "text/plain",
        });
        expect(described.metadata.storageId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        expect(described.url).toBe(
          `https://kernel.convex.cloud/api/storage/${described.metadata.storageId}`,
        );
        // A file's storage UUID still names it, as before Convex 1.6.
        expect(
          yield* call(() =>
            t.query((ctx: QueryCtx) =>
              ctx.storage.getUrl(described.metadata.storageId),
            ),
          ),
        ).toBe(described.url);
      }),
  );

  it.effect(
    "a file with no content type keeps contentType null in its row and metadata",
    () =>
      Effect.gen(function* () {
        const t = storageWorld();
        const id = yield* call(() =>
          t.action(storeFromAction(new Blob([hello.text]))),
        );
        const described = yield* call(() => t.query(describeFile(id)));
        expect(described.doc.contentType).toBeNull();
        expect(described.metadata.contentType).toBeNull();
        expect(
          yield* call(() =>
            t.action(async (ctx: ActionCtx) => {
              const blob = await ctx.storage.get(id);
              return blob === null ? null : [blob.type, await blob.text()];
            }),
          ),
        ).toStrictEqual(["", hello.text]);
      }),
  );

  it.effect.each([
    {
      name: "an action",
      store: (t: ReturnType<typeof storageWorld>, sha256: string) =>
        t.action(storeFromAction(new Blob([hello.text]), sha256)),
    },
    {
      name: "a mutation",
      store: (t: ReturnType<typeof storageWorld>, sha256: string) =>
        t.run((ctx) => ctx.storage.store(new Blob([hello.text]), { sha256 })),
    },
  ])(
    "$name's store with a declared digest keeps the file only when the digest matches",
    ({ store }) =>
      Effect.gen(function* () {
        const t = storageWorld();
        const before = yield* call(() => t.query(allFiles));
        yield* call(() =>
          expect(store(t, world)).rejects.toThrow(
            `Sha256 mismatch. Expected: ${world} Actual: ${hello.sha256}`,
          ),
        );
        expect(yield* call(() => t.query(allFiles))).toBe(before);
        const id = yield* call(() => store(t, hello.sha256));
        expect(yield* call(() => t.query(describeFile(id)))).toMatchObject({
          doc: { sha256: hello.sha256 },
        });
      }),
  );

  it.effect(
    "a declared digest that is not 32 bytes of base64 is refused as an argument",
    () =>
      Effect.gen(function* () {
        const t = storageWorld();
        yield* call(() =>
          expect(
            t.run((ctx) =>
              ctx.storage.store(new Blob([hello.text]), { sha256: "c2hvcnQ=" }),
            ),
          ).rejects.toThrow(
            "Invalid argument `sha256` for `storage.store`: sha256 not 32 bytes",
          ),
        );
        expect(yield* call(() => t.query(allFiles))).toBe("[]");
      }),
  );

  it.effect(
    "a delete removes the row, and deleting it again is refused as the binary refuses it",
    () =>
      Effect.gen(function* () {
        const t = storageWorld();
        const id = yield* call(() =>
          t.action(storeFromAction(new Blob([hello.text]))),
        );
        expect(
          yield* call(() => t.run((ctx) => ctx.storage.delete(id))),
        ).toBeNull();
        expect(yield* call(() => t.query(describeFile(id)))).toStrictEqual({
          doc: null,
          metadata: null,
          url: null,
        });
        expect(
          yield* call(() => t.action((ctx: ActionCtx) => ctx.storage.get(id))),
        ).toBeNull();
        yield* call(() =>
          expect(t.run((ctx) => ctx.storage.delete(id))).rejects.toThrow(
            `storage id ${id} not found`,
          ),
        );
        yield* call(() =>
          expect(
            t.action((ctx: ActionCtx) => ctx.storage.delete(id)),
          ).rejects.toThrow(`storage id ${id} not found`),
        );
      }),
  );

  it.effect("an action's delete commits at once", () =>
    Effect.gen(function* () {
      const t = storageWorld();
      const id = yield* call(() =>
        t.action(storeFromAction(new Blob([hello.text]))),
      );
      yield* call(() => t.action((ctx: ActionCtx) => ctx.storage.delete(id)));
      expect(yield* call(() => t.query(allFiles))).toBe("[]");
    }),
  );

  it.effect(
    "a file a mutation stores exists only once the mutation commits, and the mutation reads it back",
    () =>
      Effect.gen(function* () {
        const t = storageWorld();
        yield* call(() =>
          expect(
            t.run(async (ctx) => {
              await ctx.storage.store(new Blob([hello.text]));
              throw new Error("The mutation failed after storing.");
            }),
          ).rejects.toThrow("The mutation failed after storing."),
        );
        expect(yield* call(() => t.query(allFiles))).toBe("[]");
        const text = yield* call(() =>
          t.run(async (ctx) => {
            const id = await ctx.storage.store(
              new Blob([hello.text], { type: "text/plain" }),
            );
            const blob = await ctx.storage.get(id);
            return blob === null ? null : [blob.type, await blob.text()];
          }),
        );
        expect(text).toStrictEqual(["text/plain", hello.text]);
      }),
  );

  it.effect(
    "a held attempt that read a file conflicts when the file is deleted before it applies",
    () =>
      Effect.gen(function* () {
        const t = storageWorld();
        const id = yield* call(() =>
          t.action(storeFromAction(new Blob([hello.text]))),
        );
        const held = yield* call(() => t.prepare(files.readThenNote, { id }));
        yield* call(() => t.run((ctx) => ctx.storage.delete(id)));
        const applied = yield* call(() => t.apply(held.id));
        assert(applied.kind === "conflict");
        expect(yield* call(() => t.apply(applied.next.id))).toMatchObject({
          kind: "applied",
        });
        expect(
          yield* call(() =>
            t.query((ctx: QueryCtx) =>
              ctx.db
                .query("notes")
                .collect()
                .then((notes) => Array.map(notes, (note) => note.text)),
            ),
          ),
        ).toStrictEqual(["gone"]);
      }),
  );

  it.effect(
    "a subscription that read a file's URL is stale once an action deletes the file",
    () =>
      Effect.gen(function* () {
        const t = storageWorld();
        const id = yield* call(() =>
          t.action(storeFromAction(new Blob([hello.text]))),
        );
        const subscription = yield* call(() =>
          t.subscriber().subscribe(files.urlOf, { id }),
        );
        expect(yield* call(() => t.reference())).toStrictEqual([]);
        yield* call(() => t.action((ctx: ActionCtx) => ctx.storage.delete(id)));
        expect(yield* call(() => t.reference())).toMatchObject([
          {
            subscription: subscription.id,
            reference: { _tag: "returned", value: null },
          },
        ]);
        yield* call(() => t.refresh());
        expect(yield* call(() => t.reference())).toStrictEqual([]);
      }),
  );

  it.effect.each([
    {
      name: "an ID of another table",
      id: (noteId: string) => noteId,
      message:
        "Invalid storage ID. Storage ID cannot be an ID on any table other than '_storage'.",
    },
    {
      name: "a string that is no ID",
      id: () => "not-an-id",
      message:
        'Invalid argument `storageId` for `storage.getUrl`: Invalid storage ID: "not-an-id".',
    },
  ])("$name is refused as a storage ID", ({ id, message }) =>
    Effect.gen(function* () {
      const t = storageWorld();
      const noteId = yield* call(() =>
        t.run((ctx) => ctx.db.insert("notes", { text: "note" })),
      );
      yield* call(() =>
        expect(
          t.query((ctx: QueryCtx) =>
            ctx.storage.getUrl(id(noteId) as StorageId),
          ),
        ).rejects.toThrow(message),
      );
    }),
  );

  // The binary parses a content type with `mime` 0.3.17. Its messages, and
  // the stored forms, are pinned on the binary in
  // `packages/server/test/local-backend/storage.test.ts`.
  it.effect.each([
    {
      type: "nonsense",
      reason: "a slash (/) was missing between the type and subtype",
    },
    {
      type: 'text/plain; charset="unterminated',
      reason: 'a quote (") was missing from a parameter value',
    },
    {
      type: "text/plain ;charset=utf-8",
      reason: "an invalid token was encountered, 20 at position 10",
    },
    {
      type: "text/plain; charset",
      reason:
        "an equals sign (=) was missing between a parameter and its value",
    },
    {
      type: 'text/plain; a="b" c',
      reason: "an invalid token was encountered, 63 at position 18",
    },
  ])(
    "a content type `mime` refuses, $type, is refused on both store paths, and nothing is stored",
    ({ type, reason }) =>
      Effect.gen(function* () {
        const t = storageWorld();
        const blob = new Blob([hello.text], { type });
        yield* call(() =>
          expect(t.action(storeFromAction(blob))).rejects.toThrow(
            `mime parse error: ${reason}`,
          ),
        );
        yield* call(() =>
          expect(t.run((ctx) => ctx.storage.store(blob))).rejects.toThrow(
            `Invalid argument \`contentType\` for \`storage.store\`: mime parse error: ${reason}`,
          ),
        );
        expect(yield* call(() => t.query(allFiles))).toBe("[]");
      }),
  );

  it.effect.each([
    { type: "text/plain;", stored: "text/plain" },
    { type: "text/", stored: "text/" },
    { type: 'text/plain; name="A B"', stored: 'text/plain; name="A B"' },
    { type: "*/*", stored: "*/*" },
  ])(
    "a content type `mime` accepts, $type, is stored as `mime` prints it",
    ({ type, stored }) =>
      Effect.gen(function* () {
        const t = storageWorld();
        // A `Blob` lowercases its type, so this one keeps the case `mime`
        // itself keeps in a parameter value.
        const id = yield* call(() =>
          t.run((ctx) =>
            ctx.storage.store(
              Object.defineProperty(new Blob([hello.text]), "type", {
                value: type,
              }),
            ),
          ),
        );
        expect(
          (yield* call(() => t.query(describeFile(id)))).doc.contentType,
        ).toBe(stored);
      }),
  );

  it.effect(
    "a component's files live in its own _storage, and their URLs name the component",
    () =>
      Effect.gen(function* () {
        const t = storageWorld();
        t.registerComponent("files", defineSchema({}), {
          "_generated/server.ts": () => Promise.resolve({}),
        });
        const id = yield* call(() =>
          t.runInComponent("files", (ctx) =>
            ctx.storage.store(new Blob([hello.text])),
          ),
        );
        const url = yield* call(() =>
          t.runInComponent("files", (ctx) => ctx.storage.getUrl(id)),
        );
        expect(new URL(url).search).toBe("?component=files");
        expect(
          yield* call(() => t.run((ctx) => ctx.storage.getUrl(id))),
        ).toBeNull();
      }),
  );
});

describe("storage endpoints", () => {
  it.effect(
    "an upload URL has the binary's shape, and uploading or downloading through the kernel is RequiresBinary",
    () =>
      Effect.gen(function* () {
        const t = storageWorld();
        const uploadUrl = yield* call(() =>
          t.run((ctx) => ctx.storage.generateUploadUrl()),
        );
        expect(uploadUrl).toMatch(
          /^https:\/\/kernel\.convex\.cloud\/api\/storage\/upload\?token=/,
        );
        const upload = yield* call(() =>
          t.fetch(uploadUrl, { method: "POST", body: hello.text }).then(
            () => undefined,
            (error: unknown) => error,
          ),
        );
        expect(upload).toMatchObject({
          _tag: "RequiresBinary",
          operation: "storageUpload",
        });
        const id = yield* call(() =>
          t.action(storeFromAction(new Blob([hello.text]))),
        );
        const fileUrl = yield* call(() =>
          t.query((ctx: QueryCtx) => ctx.storage.getUrl(id)),
        );
        const download = yield* call(() =>
          t.fetch(fileUrl!).then(
            () => undefined,
            (error: unknown) => error,
          ),
        );
        expect(download).toMatchObject({
          _tag: "RequiresBinary",
          operation: "storageDownload",
        });
      }),
  );
});

describe("storage redaction", () => {
  const canary = "canary-attachment-5d2e91f0";
  const Token = Schema.RedactedFromValue(Schema.String);
  const confectSchema = DatabaseSchema.make({
    attachments: Table.make(() =>
      Schema.Struct({ file: Schema.String, token: Token }),
    )("attachments"),
  });
  const attachThenFail = makeFunctionReference<
    "mutation",
    { file: StorageId; token: string }
  >("files:attachThenFail");
  const redactedWorld = () =>
    convexTest({
      schema: defineSchema({
        attachments: defineTable({ file: v.id("_storage"), token: v.string() }),
      }),
      modules: {
        "_generated/server.ts": () => Promise.resolve({}),
        "files.ts": () =>
          Promise.resolve({
            attachThenFail: mutationGeneric({
              args: { file: v.id("_storage"), token: v.string() },
              handler: async (_ctx, { file, token }) => {
                throw new Error(`Attaching ${file} with ${token} failed.`);
              },
            }),
          }),
      },
      redaction: Redaction.policy({
        tables: { "": Redaction.tablesOf(confectSchema) },
        functions: {
          "": {
            "files:attachThenFail": {
              args: () => Schema.Struct({ file: Schema.String, token: Token }),
            },
          },
        },
      }),
    });
  const attach = (t: any, contents: string) =>
    call((): Promise<StorageId> =>
      t.run(async (ctx: MutationCtx) => {
        const file = await ctx.storage.store(new Blob([contents]));
        await ctx.db.insert("attachments", { file, token: canary });
        return file;
      }),
    );
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

  it.effect(
    "a snapshot marks a declared secret in a row that references a file, and carries the file's row and bytes as they are",
    () =>
      Effect.gen(function* () {
        const t = redactedWorld();
        const file = yield* attach(t, "attachment body");
        const exported = text(t.exportSnapshot());
        expect(exported).not.toContain(canary);
        expect(exported).toContain(`"${Redaction.markerKey}"`);
        expect(exported).toContain(`"file":"${file}"`);
        expect(exported).toContain(
          `"bytes":"${Base64.fromByteArray(new TextEncoder().encode("attachment body"))}"`,
        );

        const restored = redactedWorld();
        yield* call(() =>
          restored.restoreSnapshot(new TextEncoder().encode(exported), {
            secrets: t.secrets(),
          }),
        );
        expect(
          yield* call(() =>
            restored.query((ctx: QueryCtx) =>
              ctx.db
                .query("attachments")
                .collect()
                .then((rows) =>
                  Array.map(rows, (row) => [row["file"], row["token"]]),
                ),
            ),
          ),
        ).toStrictEqual([[file, canary]]);
        expect(
          yield* call(() =>
            restored.action(async (ctx: ActionCtx) =>
              (await ctx.storage.get(file))!.text(),
            ),
          ),
        ).toBe("attachment body");
      }),
  );

  it.effect(
    "a file whose bytes hold a kept secret is marked in the snapshot, and only a restore given the secrets puts its bytes back",
    () =>
      Effect.gen(function* () {
        const t = redactedWorld();
        yield* attach(t, "first");
        const contents = `the token is ${canary}`;
        const leaky = yield* call((): Promise<StorageId> =>
          t.action((ctx: ActionCtx) => ctx.storage.store(new Blob([contents]))),
        );
        const exported = t.exportSnapshot();
        expect(text(exported)).not.toContain(
          Base64.fromByteArray(new TextEncoder().encode(contents)),
        );
        expect(
          yield* call(() =>
            redactedWorld()
              .restoreSnapshot(exported)
              .then(
                () => null,
                (error: unknown) => error,
              ),
          ),
        ).toMatchObject({ _tag: "SnapshotSecretMissing" });
        const restored = redactedWorld();
        yield* call(() =>
          restored.restoreSnapshot(exported, { secrets: t.secrets() }),
        );
        expect(
          yield* call(() =>
            restored.action(async (ctx: ActionCtx) =>
              (await ctx.storage.get(leaky))!.text(),
            ),
          ),
        ).toBe(contents);
        expect(text(restored.exportSnapshot())).toBe(text(exported));
      }),
  );

  it.effect(
    "a failure report marks a declared secret beside a storage ID and leaves the ID as it is",
    () =>
      Effect.gen(function* () {
        const t = redactedWorld();
        const file = yield* attach(t, "attachment body");
        const report = yield* call(() =>
          t.mutation(attachThenFail, { file, token: canary }).then(
            () => "",
            (error: unknown) => (error as Error).message,
          ),
        );
        expect(report).not.toContain(canary);
        expect(report).toContain(Redaction.marker);
        expect(report).toContain(file);
      }),
  );
});
