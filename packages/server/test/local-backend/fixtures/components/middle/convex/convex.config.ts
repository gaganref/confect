import { defineComponent } from "convex/server";
import child from "../../inner/convex/convex.config";

const component = defineComponent("middle");
component.use(child, { name: "child", httpPrefix: "/child" });
export default component;
