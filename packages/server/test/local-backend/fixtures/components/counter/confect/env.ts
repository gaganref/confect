import { Env } from "@confect/core";

export default Env.make("counter", {
  COMPONENT_REQUIRED: Env.string(),
  COMPONENT_OPTIONAL: Env.optional(Env.string()),
  COMPONENT_MARKER: Env.optional(Env.string()),
  COMPONENT_UNBOUND: Env.optional(Env.string()),
});
