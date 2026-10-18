import { App, Env } from "@confect/core";
export default App.make({ kind: "component", env: Env.make("counter", {}) });
