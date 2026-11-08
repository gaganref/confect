import * as Effect from "effect/Effect";
import { setupForFixture } from "../setup";
import * as LocalBackend from "./LocalBackend";

const generate = setupForFixture(import.meta.dirname, "./fixtures", [
  "components/counter/convex",
  "components/inner/convex",
  "components/middle/convex",
  "components/parent/convex",
]);

export const seedAuth = () =>
  LocalBackend.LocalBackend.pipe(
    Effect.asVoid,
    Effect.provide(LocalBackend.layer),
    Effect.scoped,
    Effect.runPromise,
  );

export const setup = () =>
  Effect.promise(generate).pipe(
    Effect.andThen(() => Effect.promise(seedAuth)),
    Effect.runPromise,
  );
