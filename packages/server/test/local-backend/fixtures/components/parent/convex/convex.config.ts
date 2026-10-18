import { defineComponent } from "convex/server";
import middle from "../../middle/convex/convex.config";
import counter from "../../counter/convex/convex.config";

const component = defineComponent("parent");
component.use(counter, {
  name: "child",
  httpPrefix: "/child",
  env: { COMPONENT_REQUIRED: "nested-required" },
});
component.use(middle, { name: "deep", httpPrefix: "/deep" });
export default component;
