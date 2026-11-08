import { Mount } from "@confect/core";
import RelayComponent from "../components/relay/client";
import args from "./args";

export const Relay = Mount.make(RelayComponent, {
  name: "relay",
  args: args.relay,
});
