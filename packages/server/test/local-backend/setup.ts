import { setupForFixture } from "../setup";

export const setup = setupForFixture(import.meta.dirname, "./fixtures", [
  "components/counter/convex",
  "components/inner/convex",
  "components/middle/convex",
  "components/parent/convex",
]);
