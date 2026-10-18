import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as LocalBackend from "./LocalBackend";

const LogEntry = Schema.fromJsonString(
  Schema.Struct({
    kind: Schema.String,
    udfType: Schema.String,
    identifier: Schema.String,
    timestamp: Schema.Finite,
  }),
);

layer(
  Layer.mergeAll(LocalBackend.layer, NodeServices.layer, FetchHttpClient.layer),
  { timeout: "120 seconds", excludeTestServices: true },
)("HTTP route labels on a real backend", (it) => {
  it.effect(
    "logs reflected patterns for application and mounted component completions",
    () =>
      Effect.gen(function* () {
        const started = (yield* Clock.currentTimeMillis) / 1000;
        for (const requestPath of ["/users/42", "/first/members/42"]) {
          const response = yield* HttpClient.get(
            `http://127.0.0.1:3211${requestPath}`,
          );
          expect(response.status).toBe(200);
          expect(yield* response.json).toBe("42");
        }
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner;
        const logs = yield* spawner.spawn(
          ChildProcess.make(
            "pnpm",
            ["convex", "logs", "--history", "100", "--success", "--jsonl"],
            {
              cwd: path.resolve(import.meta.dirname, "./fixtures"),
              shell: true,
              extendEnv: true,
              env: { CONVEX_AGENT_MODE: "anonymous" },
            },
          ),
        );
        const completions = yield* logs.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.filter((line) => line.startsWith("{")),
          Stream.mapEffect((line) => Schema.decodeEffect(LogEntry)(line)),
          Stream.filter(
            (entry) =>
              entry.kind === "Completion" &&
              entry.udfType === "HttpAction" &&
              entry.timestamp >= started,
          ),
          Stream.take(2),
          Stream.runCollect,
          Effect.timeout("20 seconds"),
        );
        const labels = completions.map(({ identifier }) => identifier);
        expect(labels).toEqual(["GET /users/:id", "GET /members/:id"]);
        yield* Effect.sync(() => {
          for (const { kind, udfType, identifier } of completions) {
            process.stdout.write(`${kind} ${udfType} ${identifier}\n`);
          }
        });
      }),
  );
  it.effect("keeps unmatched app and component responses in Effect", () =>
    Effect.gen(function* () {
      for (const requestPath of ["/no-such-route", "/first/no-such-route"]) {
        const response = yield* HttpClient.get(
          `http://127.0.0.1:3211${requestPath}`,
        );
        expect(response.status).toBe(404);
        expect(yield* response.text).toBe("");
      }
    }),
  );
});
