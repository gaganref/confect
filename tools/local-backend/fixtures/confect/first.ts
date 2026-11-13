import { Mount } from "@confect/core";
import Counter from "../components/counter/client";
import env from "./env";

export const First = Mount.make(Counter, {
  name: "first",
  httpPrefix: "/first",
  env: {
    COMPONENT_REQUIRED: "first-required",
    COMPONENT_OPTIONAL: "first-optional",
    COMPONENT_MARKER: env.COMPONENT_MARKER,
  },
});
