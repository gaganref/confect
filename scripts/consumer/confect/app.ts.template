import { App, Component, Mount } from "@confect/core";
import counterKit from "counter-kit/convex.config.js";
import counter from "../components/counter/convex/convex.config.js";
import env from "./env.js";

const client = (native: unknown) => native;
export default App.make({
  env,
  components: [counter, counterKit],
  mounts: [
    Mount.make(Component.make("counter", { client }), {
      name: "counter",
      httpPrefix: "/counter",
    }),
    Mount.make(Component.make("counterKit", { client }), { name: "kitted" }),
  ],
});
