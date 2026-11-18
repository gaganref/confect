import { Mount } from "@confect/core";
import Counter from "../components/counter/client";

export const First = Mount.make(Counter, {
  name: "first",
  httpPrefix: "/first",
});
