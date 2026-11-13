import { App, Mount } from "@confect/core";
import counter from "../components/counter/convex/convex.config";
import Parent from "../components/parent/client";
import parent from "../components/parent/convex/convex.config";
import env from "./env";
import { First } from "./first";
import { Second } from "./second";

export default App.make({
  env,
  components: [counter, parent],
  mounts: [
    First,
    Second,
    Mount.make(Parent, { name: "left", httpPrefix: "/left" }),
    Mount.make(Parent, { name: "right", httpPrefix: "/right" }),
  ],
});
