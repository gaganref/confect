import { App } from "@confect/core";
import env from "./env";

// Tables alone: no function, no route, so only Convex's evaluation of its
// schema can run their deploy checks at a push.
export default App.make({ kind: "component", env });
