/**
 * End-to-end test of Confect's storage services inside Convex's real UDF
 * isolate. Convex returns storage URLs as plain strings, which the storage
 * services decode with Effect's `Schema.URLFromString`—so these only pass if
 * that string→URL decode succeeds in the isolate.
 */

import { getFunctionReference } from "@confect/core/RefInternal";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { expect, layer } from "@effect/vitest";
import type { GenericId } from "convex/values";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import refs from "confect-local-backend/refs";
import * as LocalBackend from "confect-local-backend/LocalBackend";
import registry from "../../../../tools/local-backend/fixtures/confect/_generated/testing";
import { TestConfect } from "../../../test/src/index";
import * as Record from "effect/Record";
import * as Arr from "effect/Array";
import * as Str from "effect/String";

const UploadResponse = Schema.fromJsonString(
  Schema.Struct({ storageId: Schema.String }),
);

layer(Layer.mergeAll(LocalBackend.layer, NodeHttpClient.layerUndici), {
  timeout: "120 seconds",
})("Storage services inside the Convex isolate", (it) => {
  it.effect(
    "stores and reads Blobs in mutations with MIME and SHA256 validation",
    () =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        const storage = refs.public.groups.storage;
        for (const type of ["text/plain;charset=utf-8", ""]) {
          const stored = yield* Effect.promise(() =>
            client.mutation(getFunctionReference(storage.storeMutation), {
              text: "abc",
              type,
              sha256: "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=",
            }),
          );
          expect(stored).toEqual({
            storageId: expect.any(String),
            text: "abc",
            type,
            size: 3,
          });
          const read = yield* Effect.promise(() =>
            client.mutation(getFunctionReference(storage.getMutation), {
              storageId: stored.storageId,
            }),
          );
          expect(read).toEqual(stored);
          const actionRead = yield* Effect.promise(() =>
            client.action(getFunctionReference(storage.get), {
              storageId: stored.storageId,
            }),
          );
          expect(actionRead).toBe("abc");
          const deleted = yield* Effect.promise(() =>
            client.mutation(getFunctionReference(storage.deleteAndGet), {
              storageId: stored.storageId,
            }),
          );
          expect(deleted).toEqual({
            id: stored.storageId,
            tag: "BlobNotFoundError",
          });
          yield* Effect.promise(() =>
            expect(
              client.mutation(getFunctionReference(storage.getMutation), {
                storageId: stored.storageId,
              }),
            ).rejects.toThrow(/BlobNotFoundError/),
          );
          const missing = yield* Effect.promise(() =>
            client.mutation(getFunctionReference(storage.limitedFiles), {
              storageIds: [stored.storageId],
              sizes: [],
              limits: {
                filesRead: 0,
                fileReadBytes: 0,
                filesWritten: 0,
                fileWriteBytes: 0,
              },
            }),
          );
          expect(missing.failures).toHaveLength(1);
          expect(missing.failures[0]).toContain("BlobNotFoundError");
          expect(missing.metrics).toEqual({
            filesRead: 0,
            fileReadBytes: 0,
            filesWritten: 0,
            fileWriteBytes: 0,
          });
        }
        yield* Effect.promise(() =>
          expect(
            client.mutation(getFunctionReference(storage.storeMutation), {
              text: "abc",
              type: "text/plain",
              sha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            }),
          ).rejects.toThrow(/sha256 mismatch/i),
        );
      }),
  );

  it.effect(
    "restores the parent's pending file after nested rollback and retains read usage",
    () =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        const storage = refs.public.groups.storage;
        const readId = yield* Effect.promise(() =>
          client.action(getFunctionReference(storage.store), {
            text: "existing",
          }),
        );
        const result = yield* Effect.promise(() =>
          client.mutation(getFunctionReference(storage.rollback), {
            readId,
          }),
        );
        expect(result.metrics).toEqual({
          filesRead: 1,
          fileReadBytes: 8,
          filesWritten: 1,
          fileWriteBytes: 6,
        });
        for (const [storageId, text] of [
          [readId, "existing"],
          [result.parentId, "parent"],
        ] as const) {
          const blob = yield* Effect.promise(() =>
            client.mutation(getFunctionReference(storage.getMutation), {
              storageId,
            }),
          );
          expect(blob.text).toBe(text);
        }
        yield* Effect.promise(() =>
          expect(
            client.mutation(getFunctionReference(storage.getMutation), {
              storageId: result.rolledBackId,
            }),
          ).rejects.toThrow(/BlobNotFoundError/),
        );
        yield* Effect.promise(() =>
          expect(
            client.query(getFunctionReference(storage.getUrl), {
              storageId: result.rolledBackId,
            }),
          ).rejects.toThrow(/BlobNotFoundError/),
        );
      }),
  );

  it.effect(
    "hides pending storage metadata from stale snapshots without hiding the Blob from its mutation",
    () =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        const storage = refs.public.groups.storage;
        for (const stale of [false, true]) {
          const result = yield* Effect.promise(() =>
            client.mutation(getFunctionReference(storage.staleRead), {
              stale,
            }),
          );
          expect(result.text).toBe("pending");
          if (stale) expect(result.url).toBeNull();
          else expect(result.url).toContain("/api/storage/");
          const committed = yield* Effect.promise(() =>
            client.mutation(getFunctionReference(storage.getMutation), {
              storageId: result.storageId,
            }),
          );
          expect(committed.text).toBe("pending");
        }
      }),
  );

  it.effect.each([
    {
      filesWritten: 1,
      fileWriteBytes: 100,
      sizes: [3, 1, 1],
      written: 1,
      bytes: 3,
      error: /Too many files stored/i,
    },
    {
      filesWritten: 10,
      fileWriteBytes: 4,
      sizes: [3, 2, 2, 1],
      written: 2,
      bytes: 4,
      error: /Too large total size of the files stored/i,
    },
  ])(
    "enforces nested file write limits without charging caught failures: $filesWritten files, $fileWriteBytes bytes",
    ({ filesWritten, fileWriteBytes, sizes, written, bytes, error }) =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        const storage = refs.public.groups.storage;
        const result = yield* Effect.promise(() =>
          client.mutation(getFunctionReference(storage.limitedFiles), {
            sizes,
            storageIds: [],
            limits: {
              filesRead: 0,
              fileReadBytes: 0,
              filesWritten,
              fileWriteBytes,
            },
          }),
        );
        expect(result.failures).toHaveLength(2);
        for (const failure of result.failures) expect(failure).toMatch(error);
        expect(result.storageIds).toHaveLength(written);
        expect(result.metrics).toEqual({
          filesRead: 0,
          fileReadBytes: 0,
          filesWritten: written,
          fileWriteBytes: bytes,
        });
        let committedBytes = 0;
        for (const storageId of result.storageIds) {
          const blob = yield* Effect.promise(() =>
            client.mutation(getFunctionReference(storage.getMutation), {
              storageId,
            }),
          );
          committedBytes += blob.size;
        }
        expect(committedBytes).toBe(bytes);
      }),
  );

  it.effect.each([
    { filesRead: 1, fileReadBytes: 100, error: /Too many files read/i },
    {
      filesRead: 10,
      fileReadBytes: 4,
      error: /Too large total size of the files read/i,
    },
  ])(
    "counts distinct reads and rejects repeated over-budget reads: $filesRead files, $fileReadBytes bytes",
    ({ filesRead, fileReadBytes, error }) =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        const storage = refs.public.groups.storage;
        const first = yield* Effect.promise(() =>
          client.mutation(getFunctionReference(storage.storeMutation), {
            text: "abcd",
            type: "text/plain",
          }),
        );
        const second = yield* Effect.promise(() =>
          client.mutation(getFunctionReference(storage.storeMutation), {
            text: "e",
            type: "text/plain",
          }),
        );
        const result = yield* Effect.promise(() =>
          client.mutation(getFunctionReference(storage.limitedFiles), {
            sizes: [],
            storageIds: [
              first.storageId,
              first.storageId,
              second.storageId,
              second.storageId,
            ],
            limits: {
              filesRead,
              fileReadBytes,
              filesWritten: 0,
              fileWriteBytes: 0,
            },
          }),
        );
        expect(result.failures).toHaveLength(2);
        for (const failure of result.failures) expect(failure).toMatch(error);
        expect(result.metrics).toEqual({
          filesRead: 1,
          fileReadBytes: 4,
          filesWritten: 0,
          fileWriteBytes: 0,
        });
      }),
  );

  it.effect("shares stored blobs across actions, queries, and mutations", () =>
    Effect.gen(function* () {
      const { client } = yield* LocalBackend.LocalBackend;
      const storage = refs.public.groups.storage;
      const text = "stored through the unified service";
      const storageId = yield* Effect.promise(() =>
        client.action(getFunctionReference(storage.store), {
          text,
        }),
      );
      const contents = yield* Effect.promise(() =>
        client.action(getFunctionReference(storage.get), {
          storageId,
        }),
      );
      expect(contents).toBe(text);
      const url = yield* Effect.promise(() =>
        client.query(getFunctionReference(storage.getUrl), {
          storageId,
        }),
      );
      expect(new URL(url).pathname).toContain("/api/storage/");
      const pipeResult = yield* HttpClient.get(url).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.text),
      );
      expect(pipeResult).toBe(text);
      const promiseResult = yield* Effect.promise(() =>
        client.mutation(getFunctionReference(storage.deleteBlob), {
          storageId,
        }),
      );
      expect(promiseResult).toBeNull();
      yield* Effect.promise(() =>
        expect(
          client.query(getFunctionReference(storage.getUrl), {
            storageId,
          }),
        ).rejects.toThrow(/BlobNotFoundError/),
      );
      yield* Effect.promise(() =>
        expect(
          client.action(getFunctionReference(storage.get), {
            storageId,
          }),
        ).rejects.toThrow(/BlobNotFoundError/),
      );
    }),
  );

  // The test kernel's storage metadata parity cases
  // (`packages/test/test/Storage.test.ts`) expect these same answers.
  it.effect(
    "keeps one stored blob's _storage row, metadata, URL and delete as the test kernel simulates them",
    () =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        const storage = refs.public.groups.storage;
        const hello = "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=";
        const world = "SG6kYiTRu0+2gPNPfJrZao8k7Ii+c+qOWmxlJg6cuKc=";
        const storeWith = (contentType: string, sha256: string) =>
          client.action(getFunctionReference(storage.storeWith), {
            text: "hello",
            contentType,
            sha256,
          });
        const store = (contentType: string, sha256: string) =>
          Effect.promise(() => storeWith(contentType, sha256));
        const describe = (storageId: GenericId<"_storage">) =>
          Effect.promise(() =>
            client.query(getFunctionReference(storage.describe), {
              storageId,
            }),
          ).pipe(Effect.map((json): any => JSON.parse(json)));
        const deleteRaw = (storageId: GenericId<"_storage">) =>
          client.mutation(getFunctionReference(storage.deleteRaw), {
            storageId,
          });

        const typed = yield* store("text/plain", hello);
        const described = yield* describe(typed);
        expect(described.doc).toStrictEqual({
          _id: typed,
          _creationTime: described.doc._creationTime,
          sha256: hello,
          size: 5,
          contentType: "text/plain",
        });
        expect(typeof described.doc._creationTime).toBe("number");
        expect(described.metadata).toStrictEqual({
          storageId: described.metadata.storageId,
          sha256:
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
          size: 5,
          contentType: "text/plain",
        });
        expect(described.metadata.storageId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        expect(new URL(described.url).pathname).toBe(
          `/api/storage/${described.metadata.storageId}`,
        );
        expect(new URL(described.url).search).toBe("");

        const untyped = yield* describe(yield* store("", ""));
        expect(Arr.sort(Record.keys(untyped.doc), Str.Order)).toStrictEqual(
          Arr.sort(Record.keys(described.doc), Str.Order),
        );
        expect(untyped.doc.contentType).toBeNull();
        expect(untyped.metadata.contentType).toBeNull();

        yield* Effect.promise(() =>
          expect(storeWith("", world)).rejects.toThrow(
            `Sha256 mismatch. Expected: ${world} Actual: ${hello}`,
          ),
        );

        expect(yield* Effect.promise(() => deleteRaw(typed))).toBeNull();
        expect(yield* describe(typed)).toStrictEqual({
          doc: null,
          metadata: null,
          url: null,
        });
        yield* Effect.promise(() =>
          expect(deleteRaw(typed)).rejects.toThrow(
            `storage id ${typed} not found`,
          ),
        );
      }),
    60_000,
  );

  it.effect(
    "generateUploadUrl decodes the isolate's string URL, and getUrl resolves an uploaded blob",
    () =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;

        const uploadUrl = yield* Effect.promise(() =>
          client.mutation(
            getFunctionReference(refs.public.groups.storage.generateUploadUrl),
            {},
          ),
        );
        expect(new URL(uploadUrl).pathname).toContain("/api/storage/upload");

        const uploadResponseBody = yield* HttpClient.post(uploadUrl, {
          body: HttpBody.text("hello, storage"),
          headers: { "Content-Type": "text/plain" },
        }).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.text),
        );
        const { storageId } =
          yield* Schema.decodeEffect(UploadResponse)(uploadResponseBody);

        const blobUrl = yield* Effect.promise(() =>
          client.query(
            getFunctionReference(refs.public.groups.storage.getUrl),
            { storageId: storageId as GenericId<"_storage"> },
          ),
        );
        expect(new URL(blobUrl).pathname).toContain("/api/storage/");
      }),
    60_000,
  );
});

const storage = refs.public.groups.storage;

/**
 * Run `program` on a fresh test kernel loaded with the same fixture.
 */
const onKernel = <A, E>(
  program: (
    test: TestConfect.TestConfect<typeof registry.schema>,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    return yield* program(
      yield* TestConfect.TestConfect<typeof registry.schema>(),
    );
  }).pipe(Effect.provide(TestConfect.layer(registry, { target: "kernel" })));

const MiB = 1 << 20;
const deployment = {
  filesWritten: 10,
  fileWriteBytes: 16 * MiB,
  filesRead: 10,
  fileReadBytes: 16 * MiB,
};
const hello = { text: "hello", contentType: "", sha256: "" };

layer(LocalBackend.layer, { timeout: "120 seconds" })(
  "file limits and content types",
  (it) => {
    // `files` files of 5 bytes each are stored first, on each backend, and the
    // probe reads the ones `read` picks.
    const probe = (options: {
      readonly files: number;
      readonly read: (
        ids: ReadonlyArray<GenericId<"_storage">>,
      ) => ReadonlyArray<GenericId<"_storage">>;
      readonly nested: boolean;
      readonly count: number;
      readonly size: number;
      readonly budget?: Partial<typeof deployment>;
    }) =>
      Effect.gen(function* () {
        const { client } = yield* LocalBackend.LocalBackend;
        const args = (ids: ReadonlyArray<GenericId<"_storage">>) => ({
          nested: options.nested,
          count: options.count,
          size: options.size,
          ids: options.read(ids),
          ...deployment,
          ...options.budget,
        });
        const binaryIds = yield* Effect.forEach(
          Array.from({ length: options.files }),
          () =>
            Effect.promise(() =>
              client.action(getFunctionReference(storage.storeWith), hello),
            ),
        );
        const binary = yield* Effect.promise(() =>
          client.mutation(
            getFunctionReference(storage.fileProbe),
            args(binaryIds),
          ),
        );
        const kernel = yield* onKernel((test) =>
          Effect.forEach(Array.from({ length: options.files }), () =>
            test.action(storage.storeWith, hello),
          ).pipe(
            Effect.flatMap((ids) =>
              test.mutation(storage.fileProbe, args(ids)),
            ),
          ),
        );
        return { binary, kernel };
      });

    it.effect.each([
      {
        name: "ten files stored at the deployment's limit",
        options: { files: 0, nested: false, count: 10, size: 1 },
        answer: "ok",
      },
      {
        name: "an eleventh file stored",
        options: { files: 0, nested: false, count: 11, size: 1 },
        answer: "Too many files stored by this mutation (limit: 10)",
      },
      {
        name: "a second file under a nested budget of one",
        options: {
          files: 0,
          nested: true,
          count: 2,
          size: 1,
          budget: { filesWritten: 1 },
        },
        answer: "Too many files stored by this mutation (limit: 1)",
      },
      {
        name: "ten bytes stored under a nested budget of eight",
        options: {
          files: 0,
          nested: true,
          count: 2,
          size: 5,
          budget: { fileWriteBytes: 8 },
        },
        answer:
          "Too large total size of the files stored by this mutation (limit: 8 bytes)",
      },
      {
        name: "an eleventh file read",
        options: { files: 11, nested: false, count: 0, size: 0 },
        answer: "Too many files read by this mutation (limit: 10)",
      },
      {
        name: "a second file read under a nested budget of one, after one read twice",
        options: {
          files: 2,
          read: (ids: ReadonlyArray<GenericId<"_storage">>) => [
            ids[0]!,
            ids[0]!,
            ids[1]!,
          ],
          nested: true,
          count: 0,
          size: 0,
          budget: { filesRead: 1 },
        },
        answer: "Too many files read by this mutation (limit: 1)",
      },
      {
        name: "ten bytes read under a nested budget of eight",
        options: {
          files: 2,
          nested: true,
          count: 0,
          size: 0,
          budget: { fileReadBytes: 8 },
        },
        answer:
          "Too large total size of the files read by this mutation (limit: 8 bytes)",
      },
    ])("$name answers as the test kernel does", ({ options, answer }) =>
      Effect.gen(function* () {
        const { binary, kernel } = yield* probe({
          read: (ids) => ids,
          ...options,
        });
        expect(binary).toContain(answer);
        if (options.nested) {
          // A nested call's uncaught error reaches its caller as the binary
          // rethrows it, "Uncaught Error: " and its stack around the message,
          // where the kernel passes the error itself, as #135's nested limit
          // probes find. The limit's message is the same.
          expect(kernel).toContain(answer);
        } else {
          expect(kernel).toBe(binary);
        }
      }),
    );

    it.effect.each([
      {
        contentType: 'text/plain; charset="unterminated',
        answer:
          'refused Invalid argument `contentType` for `storage.store`: mime parse error: a quote (") was missing from a parameter value',
      },
      {
        contentType: "text/plain ;charset=utf-8",
        answer:
          "refused Invalid argument `contentType` for `storage.store`: mime parse error: an invalid token was encountered, 20 at position 10",
      },
      { contentType: "text/plain;", answer: "stored text/plain" },
    ])(
      "a mutation storing a file typed $contentType answers as the test kernel does",
      ({ contentType, answer }) =>
        Effect.gen(function* () {
          const { client } = yield* LocalBackend.LocalBackend;
          const args = { text: "hello", contentType };
          const binary = yield* Effect.promise(() =>
            client.mutation(
              getFunctionReference(storage.storeInMutation),
              args,
            ),
          );
          expect(binary).toContain(answer);
          expect(
            yield* onKernel((test) =>
              test.mutation(storage.storeInMutation, args),
            ),
          ).toBe(binary);
        }),
    );

    it.effect(
      "an action storing a file typed with an unterminated quote is refused as its content type header",
      () =>
        Effect.gen(function* () {
          const { client } = yield* LocalBackend.LocalBackend;
          const args = {
            text: "hello",
            contentType: 'text/plain; charset="unterminated',
            sha256: "",
          };
          const reason =
            'mime parse error: a quote (") was missing from a parameter value';
          yield* Effect.promise(() =>
            expect(
              client.action(getFunctionReference(storage.storeWith), args),
            ).rejects.toThrow(reason),
          );
          const kernel = yield* onKernel((test) =>
            Effect.exit(test.action(storage.storeWith, args)),
          );
          expect(String(kernel)).toContain(reason);
        }),
    );
  },
);
