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
import { TestConfect } from "../../../test/src/index";
import refs from "./fixtures/confect/_generated/refs";
import registry from "./fixtures/confect/_generated/testing";
import * as LocalBackend from "./LocalBackend";

const UploadResponse = Schema.fromJsonString(
  Schema.Struct({ storageId: Schema.String }),
);

layer(Layer.mergeAll(LocalBackend.layer, NodeHttpClient.layerUndici), {
  timeout: "120 seconds",
})("Storage services inside the Convex isolate", (it) => {
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
      expect(
        yield* HttpClient.get(url).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.text),
        ),
      ).toBe(text);
      expect(
        yield* Effect.promise(() =>
          client.mutation(getFunctionReference(storage.deleteBlob), {
            storageId,
          }),
        ),
      ).toBeNull();
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
        expect(Object.keys(untyped.doc).toSorted()).toStrictEqual(
          Object.keys(described.doc).toSorted(),
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
