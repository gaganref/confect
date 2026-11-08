import { Component } from "@confect/core";
import refs from "./confect/_generated/refs";

export default Component.make("relay", {
  init: refs.internal.install.init,
  client: (native: unknown) => native,
});
