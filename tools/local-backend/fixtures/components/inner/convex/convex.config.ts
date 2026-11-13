import { defineComponent } from "convex/server";
import child from "../../counter/convex/convex.config";

const component = defineComponent("inner");
component.use(child, {
  name: "child",
  httpPrefix: "/child",
  env: { COMPONENT_REQUIRED: "nested-required" },
});
export default component;
