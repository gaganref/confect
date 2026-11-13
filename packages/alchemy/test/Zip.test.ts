import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { extract, ZipError } from "../src/internal/Zip";
import * as Str from "effect/String";
import { pipe } from "effect/Function";

// Python's zipfile with ZIP_DEFLATED: README.txt, then convex-local-backend
// holding "#!/bin/sh\necho local backend\n" twenty times.
const archive = Buffer.from(
  "UEsDBBQAAAAIADJUT12HpvV8EQAAAA8AAAAKAAAAUkVBRE1FLnR4dMvLL1EoyUhVSMrMSyyq5AIAUEsDBBQAAAAIADJUT13Bw602JgAAAEQCAAAUAAAAY29udmV4LWxvY2FsLWJhY2tlbmRTVtRPyszTL87gSk3OyFfIyU9OzFFISkzOTs1L4VIelRyVJCwJAFBLAQIUAxQAAAAIADJUT12HpvV8EQAAAA8AAAAKAAAAAAAAAAAAAACAAQAAAABSRUFETUUudHh0UEsBAhQDFAAAAAgAMlRPXcHDrTYmAAAARAIAABQAAAAAAAAAAAAAAIABOQAAAGNvbnZleC1sb2NhbC1iYWNrZW5kUEsFBgAAAAACAAIAegAAAJEAAAAAAA==",
  "base64",
);

const withArchive = <A, E, R>(
  effect: (paths: {
    readonly zip: string;
    readonly directory: string;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({
      prefix: "confect-zip-test-",
    });
    const zip = path.join(directory, "backend.zip");
    yield* fs.writeFile(zip, archive);
    return yield* effect({ zip, directory });
  });

describe("Zip", () => {
  it.effect("extracts one deflated entry by name", () =>
    Effect.gen(function* () {
      const services = yield* Layer.build(NodeServices.layer);
      return yield* withArchive(({ zip, directory }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const destination = path.join(directory, "convex-local-backend");
          yield* extract(zip, "convex-local-backend", destination);
          const destinationContents = yield* fs.readFileString(destination);
          expect(destinationContents).toBe(
            pipe("#!/bin/sh\necho local backend\n", Str.repeat(20)),
          );
        }),
      ).pipe(Effect.provideContext(services));
    }),
  );

  it.effect("fails typed when the entry or the archive is missing", () =>
    Effect.gen(function* () {
      const services2 = yield* Layer.build(NodeServices.layer);
      return yield* withArchive(({ zip, directory }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const destination = path.join(directory, "out");
          const extractResult = yield* extract(
            zip,
            "convex-local-backend.exe",
            destination,
          ).pipe(Effect.result);
          expect(extractResult).toEqual(
            Result.fail(ZipError.make({ reason: "entry" })),
          );
          const garbage = path.join(directory, "garbage.zip");
          yield* fs.writeFileString(garbage, "not a zip archive");
          const extractResult2 = yield* extract(
            garbage,
            "convex-local-backend",
            destination,
          ).pipe(Effect.result);
          expect(extractResult2).toEqual(
            Result.fail(ZipError.make({ reason: "format" })),
          );
          const destinationExists = yield* fs.exists(destination);
          expect(destinationExists).toBe(false);
        }),
      ).pipe(Effect.provideContext(services2));
    }),
  );
});
