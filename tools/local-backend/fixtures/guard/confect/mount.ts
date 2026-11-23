import { Mount } from "@confect/core";
import GuardedComponent from "../components/guarded/client";
import TabledComponent from "../components/tabled/client";

export const Guarded = Mount.make(GuardedComponent, { name: "guarded" });

export const Tabled = Mount.make(TabledComponent, { name: "tabled" });
