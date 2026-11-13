import * as BunServices from "@effect/platform-bun/BunServices";
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Record from "effect/Record";

const concurrency = Schema.Struct({
  group: Schema.String,
  "cancel-in-progress": Schema.Boolean,
});
const workflowSchema = Schema.Struct({
  concurrency: Schema.optionalKey(concurrency),
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({ concurrency: Schema.optionalKey(concurrency) }),
  ),
});

test("holds one publish lock across version selection and publication", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const source = yield* fs.readFileString(
        new URL("../.github/workflows/publish.yml", import.meta.url).pathname,
      );
      const workflow = yield* Schema.decodeUnknownEffect(workflowSchema)(
        Bun.YAML.parse(source),
      );

      // Pinned whole: a publish holds the shared lock, and every other run gets its own group.
      expect(workflow.concurrency).toEqual({
        group:
          "${{ inputs.publish == true && 'fork-npm-publish' || format('fork-npm-check-{0}', github.run_id) }}",
        "cancel-in-progress": false,
      });
      for (const job of Record.values(workflow.jobs)) {
        expect(job.concurrency).toBeUndefined();
      }
    }).pipe(Effect.provide(BunServices.layer)),
  ));
