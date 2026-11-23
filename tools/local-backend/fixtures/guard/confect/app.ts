import { App } from "@confect/core";
import guarded from "../components/guarded/convex/convex.config";
import tabled from "../components/tabled/convex/convex.config";
import env from "./env";
import { Guarded, Tabled } from "./mount";

export default App.make({
  env,
  components: [guarded, tabled],
  mounts: [Guarded, Tabled],
});
