import { App, Env } from "@confect/core";
import { Policy } from "./policy";
export default App.make({ env: Env.make("host", {}), requiresMiddleware: [Policy] });