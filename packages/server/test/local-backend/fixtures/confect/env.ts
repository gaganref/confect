import { Env } from "@confect/core";

export default Env.make("host", {
  COMPONENT_MARKER: Env.optional(Env.string()),
  COMPONENT_HOST_ONLY: Env.optional(Env.string()),
});
