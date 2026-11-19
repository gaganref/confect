import { App, Env } from "@confect/core";

export const env = Env.make("host", { PEER_SERVICES: Env.string() });

export default App.make({ env });
