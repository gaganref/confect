import { App } from "@confect/core";
import email from "../../email/convex/convex.config";
import env from "./env";
import { Inbox } from "./inbox";

export default App.make({
  kind: "component",
  env,
  components: [email],
  mounts: [Inbox],
});
