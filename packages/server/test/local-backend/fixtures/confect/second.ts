import { Mount } from "@confect/core";
import Counter from "../components/counter/client";
import env from "./env";

export const Second = Mount.make(Counter, {
  name: "second",
  httpPrefix: "/second",
  env: {
    COMPONENT_REQUIRED: "second-required",
    COMPONENT_OPTIONAL: env.COMPONENT_MARKER,
    COMPONENT_MARKER: env.COMPONENT_MARKER,
  },
});
