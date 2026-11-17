import { expect, it } from "@effect/vitest";
import * as NodeServices from "../fixtures/NodeTestServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { fileURLToPath } from "node:url";

it.live(
  "accepts the built log stream declarations in a NodeNext consumer",
  () =>
    Effect.gen(function* () {
      const services = yield* Layer.build(NodeServices.layer);
      return yield* Effect.gen(function* () {
        const compiler = fileURLToPath(
          new URL("../../node_modules/typescript/bin/tsc", import.meta.url),
        );
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const handle = yield* spawner.spawn(
          ChildProcess.make(
            process.execPath,
            [
              compiler,
              "--ignoreConfig",
              "--noEmit",
              "--module",
              "NodeNext",
              "--moduleResolution",
              "NodeNext",
              "--target",
              "ESNext",
              "--strict",
              "--strictNullChecks",
              "false",
              "--skipLibCheck",
              "false",
              "--types",
              "node",
              "dist/ConvexClient.d.ts",
              "dist/LogStream.d.ts",
            ],
            {
              cwd: fileURLToPath(new URL("../../", import.meta.url)),
              extendEnv: true,
              stdin: "ignore",
            },
          ),
        );
        const result = yield* Effect.all(
          {
            status: handle.exitCode,
            output: handle.all.pipe(Stream.decodeText(), Stream.mkString),
          },
          { concurrency: "unbounded" },
        );
        expect(result.output).toBe("");
        expect(result.status).toBe(0);
      }).pipe(Effect.provideContext(services));
    }).pipe(Effect.scoped),
  60_000,
);
