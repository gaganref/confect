import { App } from "@confect/core";
import guarded from "../components/guarded/convex/convex.config";
import env from "./env";
import { Guarded } from "./mount";

export default App.make({
  env,
  components: [guarded],
  mounts: [Guarded],
});
