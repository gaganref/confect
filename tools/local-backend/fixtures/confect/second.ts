import { Mount } from "@confect/core";
import Counter from "../components/counter/client";

export const Second = Mount.make(Counter, {
  name: "second",
  httpPrefix: "/second",
});
