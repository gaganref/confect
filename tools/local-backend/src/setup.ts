import * as Effect from "effect/Effect";
import * as LocalBackend from "./LocalBackend";
import { setupForFixture } from "./setupForFixture";

const generate = setupForFixture(import.meta.dirname, "../fixtures", [
  "components/counter/convex",
  "components/inner/convex",
  "components/middle/convex",
  "components/parent/convex",
]);

const generateFamily = setupForFixture(
  import.meta.dirname,
  "../fixtures/family",
);

const generateGuard = setupForFixture(
  import.meta.dirname,
  "../fixtures/guard",
  ["components/guarded/convex"],
);

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
    Effect.andThen(() => Effect.promise(generateFamily)),
    Effect.andThen(() => Effect.promise(generateGuard)),
    Effect.andThen(() => Effect.promise(seedAuth)),
    Effect.runPromise,
  );
