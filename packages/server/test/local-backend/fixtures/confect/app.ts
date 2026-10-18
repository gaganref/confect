import { App } from "@confect/core";
import { CounterApi } from "../components/counter/confect/api";
import counter from "../components/counter/convex/convex.config";
import parent from "../components/parent/convex/convex.config";
import env from "./env";

export default App.make({
  env,
  mounts: {
    first: App.mount(counter, {
      httpPrefix: "/first",
      api: CounterApi,
      env: {
        COMPONENT_REQUIRED: "first-required",
        COMPONENT_OPTIONAL: "first-optional",
        COMPONENT_MARKER: env.COMPONENT_MARKER,
      },
    }),
    second: App.mount(counter, {
      httpPrefix: "/second",
      api: CounterApi,
      env: {
        COMPONENT_REQUIRED: "second-required",
        COMPONENT_OPTIONAL: env.COMPONENT_MARKER,
        COMPONENT_MARKER: env.COMPONENT_MARKER,
      },
    }),
    left: App.mount(parent, { httpPrefix: "/left" }),
    right: App.mount(parent, { httpPrefix: "/right" }),
  },
});
