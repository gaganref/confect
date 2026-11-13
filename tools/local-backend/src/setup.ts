import * as Effect from "effect/Effect";
import * as LocalBackend from "./LocalBackend";
import { setupForFixture } from "./setupForFixture";

const generate = setupForFixture(import.meta.dirname, "../fixtures", [
  "components/counter/convex",
  "components/inner/convex",
  "components/middle/convex",
  "components/parent/convex",
]);

export const seedAuth = () =>
  LocalBackend.LocalBackend.pipe(
    Effect.asVoid,
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- seedAuth is a script entry point: it starts the local backend for one run and closes it.
    Effect.provide(LocalBackend.layer),
    Effect.scoped,
    Effect.runPromise,
  );

export const setup = () =>
  Effect.promise(generate).pipe(
    Effect.andThen(() => Effect.promise(seedAuth)),
    Effect.runPromise,
  );
