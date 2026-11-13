import * as NodeServices from "../fixtures/NodeTestServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as RealBackend from "./RealBackend";
import * as String from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";

// Runs the real pinned backend: it downloads the release once into a cache
// under the OS temp directory, binds ports 3300-3399, and is skipped on
// Windows, where it has not been verified.
const fixture = new URL("../fixtures/local-app", import.meta.url).pathname;
const modules = new URL("../../node_modules", import.meta.url).pathname;

const app = (root: string, name: string, schemaFields: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = `${root}/${name}`;
    yield* RealBackend.copyApp(fixture, directory, { node_modules: modules });
    yield* fs.writeFileString(
      `${directory}/convex/schema.ts`,
      `import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({ notes: defineTable({ ${schemaFields} }) });
`,
    );
    return directory;
  });

const code = (cwd: string) => ({
  cwd,
  variables: { GREETING: "set before the first push" },
});

describe.skipIf(process.platform === "win32")("real local backend", () => {
  it.live(
    "runs a pushed app against env set before the push, restarts on its data, and serialises concurrent pushes",
    () =>
      Effect.gen(function* () {
        const backend = yield* RealBackend.make({
          name: "real",
          ports: "3300-3399",
        });
        const appA = yield* app(backend.root, "app-a", "text: v.string()");
        const appB = yield* app(
          backend.root,
          "app-b",
          "text: v.string(), tag: v.optional(v.string())",
        );
        const events: Array<string> = [];
        const first = yield* backend.session(code(appA), (outputs) =>
          Effect.gen(function* () {
            const port = Number(new URL(outputs.url).port);
            expect(port).toBeGreaterThanOrEqual(backend.ports.low);
            expect(port).toBeLessThanOrEqual(backend.ports.high);
            yield* Effect.log(
              `backend ${outputs.name} ready at ${outputs.url}`,
            );
            const call2 = yield* RealBackend.call(outputs, "greeting:get");
            expect(call2).toBe("set before the first push");
            yield* RealBackend.call(outputs, "notes:add", undefined, {
              text: "kept across restarts",
            });
            const pushed = yield* Effect.forEach(
              [
                ["A", appA],
                ["B", appB],
              ] as const,
              ([tag, cwd]) => RealBackend.push(outputs, { cwd }, tag, events),
              { concurrency: "unbounded" },
            );
            expect(Arr.every(pushed, Result.isSuccess)).toBe(true);
            return outputs;
          }),
        );
        const held = Arr.filter(
          events,
          (event) => !pipe(event, String.endsWith("attempt")),
        );
        const [earlier, later] = Arr.map([held[0], held.at(-1)], (event) =>
          event === undefined ? undefined : pipe(event, String.split(" "))[0],
        );
        expect(earlier).not.toBe(later);
        expect(held).toEqual(
          Arr.flatMap([earlier, later], (tag) => [
            `${tag} acquire`,
            `${tag} code`,
            `${tag} release`,
          ]),
        );
        const response = yield* HttpClient.get(
          `${first.url}/instance_name`,
        ).pipe(
          Effect.as("answered"),
          Effect.orElseSucceed(() => "stopped"),
          Effect.provide(FetchHttpClient.layer),
        );
        expect(response).toBe("stopped");

        const restarted = yield* backend.session(code(appA), (outputs) =>
          Effect.gen(function* () {
            const call2 = yield* RealBackend.call(outputs, "notes:list");
            expect(call2).toEqual(["kept across restarts"]);
            const call3 = yield* RealBackend.call(outputs, "greeting:get");
            expect(call3).toBe("set before the first push");
            return outputs;
          }),
        );
        yield* Effect.log(
          `restarted ${restarted.name} on its saved data at ${restarted.url}`,
        );
        expect(restarted.url).toBe(first.url);
        expect(restarted.name).toBe(first.name);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    300_000,
  );
});
