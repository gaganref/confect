import { queryGeneric } from "convex/server";

// The function `LocalBackend.plainLayer` pushes again to redeploy.
export const ping = queryGeneric({ args: {}, handler: () => "pong" });
