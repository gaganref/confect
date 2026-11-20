import * as PushCheck from "@confect/server/PushCheck";
import { make } from "../checks";
import schema from "./_generated/schema";
import { verdict } from "./verdict";

/**
 * The router's own check and counter. Only `confect/http.ts` imports this
 * module, and it does not import `./guard`, so the router's module graph
 * registers this check alone and every function's graph registers `./guard`'s.
 */
export const { runs } = (() => {
  const router = make("host", verdict);
  PushCheck.register(
    schema,
    PushCheck.make("router", () => router.refusals("router")),
  );
  return router;
})();
