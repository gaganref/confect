import { App } from "@confect/core";
import { guardSection } from "../../../section";
import env from "./env";

export default App.make({
  kind: "component",
  env,
  manifestSections: [guardSection("functions")],
});
