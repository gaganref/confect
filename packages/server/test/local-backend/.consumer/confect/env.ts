import { Env } from "@confect/core";
export default Env.make("consumer", {
  INSTALL_MARKER: Env.optional(Env.string()),
});
