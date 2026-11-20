import { App } from "@confect/core";
import guarded from "../components/guarded/convex/convex.config";
import { guardSection } from "../section";
import env from "./env";
import { Guarded } from "./mount";

export default App.make({
  env,
  components: [guarded],
  mounts: [Guarded],
  manifestSections: [guardSection("functions"), guardSection("router")],
});
