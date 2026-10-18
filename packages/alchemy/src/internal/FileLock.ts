import * as Crypto from "effect/Crypto";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

export class FileLockError extends Schema.TaggedError<FileLockError>()(
  "FileLockError",
  { reason: Schema.Literals(["held", "timeout", "filesystem"]) },
) {}

const Holder = Schema.fromJsonString(
  Schema.Struct({ pid: Schema.Finite, token: Schema.String }),
);
const decodeHolder = Schema.decodeUnknownOption(Holder);

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Predicate.hasProperty(error, "code") && error.code === "EPERM";
  }
};

/**
 * Hold an exclusive lock file for the ambient scope, waiting up to `wait` for
 * another holder or failing with `held` at once when `wait` is omitted.
 *
 * The holder, `{ pid, token }`, is written to a private claim file and
 * published with a hard link, which fails when the lock exists, so a visible
 * lock always names its holder. A lock whose holder has exited is removed only
 * under `<file>.recovery`, after re-reading that the same dead holder still
 * owns it, so a successor's lock is never removed in its place. Publishing and
 * recovering are uninterruptible: Node cannot cancel a link or unlink it has
 * started, so stopping early would let one land after `.recovery` is released.
 * The recovery lock is never reclaimed: a crash inside its few file operations
 * leaves waiters timing out rather than overlapping. A timeout that lands while
 * an attempt succeeds still fails, and the published lock is removed only when
 * the ambient scope closes.
 */
export const acquire = Effect.fn("FileLock.acquire")(function* (
  file: string,
  wait?: Duration.Input,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const failed = () => new FileLockError({ reason: "filesystem" });
  const token = Buffer.from(
    yield* crypto.randomBytes(16).pipe(Effect.mapError(failed)),
  ).toString("hex");
  const holder = yield* Schema.encodeEffect(Holder)({
    pid: process.pid,
    token,
  }).pipe(Effect.mapError(failed));
  const claim = `${file}.${token}`;
  const recovery = `${file}.recovery`;
  const removeIfOwned = (target: string) =>
    fs.readFileString(target).pipe(
      Effect.flatMap((content) =>
        content === holder ? fs.remove(target) : Effect.void,
      ),
      Effect.ignore,
    );
  yield* Effect.addFinalizer(() =>
    Effect.all([
      removeIfOwned(file),
      fs.remove(claim, { force: true }).pipe(Effect.ignore),
    ]),
  );
  yield* fs
    .makeDirectory(path.dirname(file), { recursive: true })
    .pipe(Effect.mapError(failed));
  yield* fs
    .writeFileString(claim, holder, { mode: 0o600 })
    .pipe(Effect.mapError(failed));

  const read = (target: string) =>
    fs.readFileString(target).pipe(
      Effect.map(decodeHolder),
      Effect.orElseSucceed(() => Option.none()),
    );
  const publish = (target: string) =>
    fs.link(claim, target).pipe(
      Effect.as(true),
      Effect.catchReason("PlatformError", "AlreadyExists", () =>
        Effect.succeed(false),
      ),
    );
  // Whether a dead holder's lock was removed.
  const reclaim = Effect.gen(function* () {
    const stale = yield* read(file);
    if (Option.isNone(stale) || isAlive(stale.value.pid)) return false;
    if (!(yield* publish(recovery))) return false;
    return yield* read(file).pipe(
      Effect.flatMap((current) =>
        Option.isSome(current) && current.value.token === stale.value.token
          ? fs.remove(file).pipe(Effect.as(true))
          : Effect.succeed(false),
      ),
      Effect.ensuring(removeIfOwned(recovery)),
    );
  });
  const attempt = publish(file).pipe(
    Effect.flatMap((acquired) =>
      acquired
        ? Effect.succeed(true)
        : Effect.flatMap(reclaim, (removed) =>
            removed ? publish(file) : Effect.succeed(false),
          ),
    ),
    Effect.uninterruptible,
    Effect.mapError(failed),
  );

  if (wait === undefined) {
    if (!(yield* attempt)) return yield* new FileLockError({ reason: "held" });
  } else {
    yield* attempt.pipe(
      Effect.repeat({
        until: (acquired) => acquired,
        schedule: Schedule.spaced("100 millis"),
      }),
      Effect.timeoutOrElse({
        duration: wait,
        orElse: () => Effect.fail(new FileLockError({ reason: "timeout" })),
      }),
    );
  }
  yield* fs.remove(claim, { force: true }).pipe(Effect.ignore);
});
